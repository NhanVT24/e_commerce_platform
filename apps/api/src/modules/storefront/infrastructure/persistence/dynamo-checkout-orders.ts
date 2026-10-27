import { QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { databaseConfig } from "../../../../config/database-config.js";
import type { CheckoutOrders } from "../../application/ports/checkout-ports.js";
import { persistAwaitingPaymentOrder, readCheckoutPrices, attachPaymentTxnRef, transitionAwaitingPaymentOrder } from "./storefront.store.js";
import { getAwaitingPaymentOrder } from "./order-record.store.js";
import { listOrderItems } from "./order-record.store.js";
import { OrderActionError } from "../../application/order-action.error.js";
import { InsufficientOrderStock } from "../../application/ports/order-finalization-ports.js";
import { getPaymentSessionByTxnRef } from "../../../vnpay/vnpay.repository.js";
import { toCheckoutOrder } from "./order.mapper.js";

export class DynamoCheckoutOrders implements CheckoutOrders {
  loadPrices = readCheckoutPrices;
  async create(entity: Parameters<CheckoutOrders["create"]>[0]) {
    const orderData = entity;
    // Session+link are now committed atomically. Unattached holds can be resumed
    // safely; concurrent issuers compete on the order condition in that transaction.
    const replay = async () => {
      const existing = await getAwaitingPaymentOrder(orderData.id);
      if (!existing) return null;
      const lines = await listOrderItems(orderData.id);
      const order = toCheckoutOrder(existing, lines);
      order.assertCheckoutReplay(orderData.customerEmail, orderData.items, lines, new Date().toISOString());
      return order;
    };
    const existing = await replay();
    if (existing) return existing;
    try {
      const result = await persistAwaitingPaymentOrder(entity);
      return toCheckoutOrder(result.order, result.items);
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if ((error instanceof OrderActionError && error.code === "CONFLICT") ||
          (failure?.name === "TransactionCanceledException" && failure.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed")) {
        const winner = await replay();
        if (winner) return winner;
      }
      if (error instanceof Error && error.message.startsWith("Insufficient stock for ")) throw new InsufficientOrderStock(error.message);
      if (failure?.name === "TransactionCanceledException" &&
        failure.CancellationReasons?.some(reason => reason.Code === "ConditionalCheckFailed")) {
        throw new OrderActionError("CONFLICT", "Inventory changed. Please refresh and retry checkout.");
      }
      throw error;
    }
  }
  async findById(id: string) {
    const record = await getAwaitingPaymentOrder(id);
    return record ? toCheckoutOrder(record, await listOrderItems(id)) : null;
  }
  async attachPayment(entity: Parameters<CheckoutOrders["attachPayment"]>[0]) {
    const order = entity;
    if (!order.paymentTxnRef || !order.paymentUrl) throw new OrderActionError("INVALID_INPUT", "Order has no payment linkage.");
    await attachPaymentTxnRef(order.id, order.paymentTxnRef, order.customerEmail, order.paymentUrl);
  }
  async transition(change: Parameters<CheckoutOrders["transition"]>[0]) {
    const { order: entity, ...context } = change;
    const input = { ...context, orderId: entity.id };
    try {
      const result = await transitionAwaitingPaymentOrder(input);
      return { ...result, order: toCheckoutOrder(result.order, result.items) };
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (failure?.name !== "TransactionCanceledException") throw error;
      const reasons = failure.CancellationReasons ?? [];
      if (reasons[0]?.Code === "ConditionalCheckFailed") {
        const current = await this.findById(input.orderId);
        if (current && current.status !== "awaiting_payment") {
          const result = await transitionAwaitingPaymentOrder(input);
          return { ...result, order: toCheckoutOrder(result.order, result.items) };
        }
      }
      // A paid session won against expiry; inventory remains held for its worker.
      if (input.status === "expired" && reasons.at(-1)?.Code === "ConditionalCheckFailed") {
        const order = await this.findById(input.orderId);
        if (order?.paymentTxnRef && reasons.length > 1 && (reasons.length - 2) % 3 === 0) {
          // Verify the reason using the authoritative session, not just its position.
          if ((await getPaymentSessionByTxnRef(order.paymentTxnRef))?.status === "success") return { order, items: [], changed: false };
        }
      }
      throw error;
    }
  }
  async *expiredCandidates(now: string) {
    let cursor: Record<string, AttributeValue> | undefined;
    do {
      const result = await rawDb.send(new QueryCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME,
        IndexName: "EntityUpdatedAtIndex", ExclusiveStartKey: cursor, Limit: 100,
        KeyConditionExpression: "entityType = :entity",
        FilterExpression: "#status = :status AND lockedUntil <= :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: marshall({ ":status": "awaiting_payment", ":entity": "ORDER", ":now": now }) }));
      for (const item of result.Items ?? []) yield String(unmarshall(item).PK).replace(/^ORDER#/, "");
      cursor = result.LastEvaluatedKey;
    } while (cursor);
  }
}
