import { QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { databaseConfig } from "../../../../config/database-config.js";
import type { CheckoutOrders, HeldOrder } from "../../application/ports/checkout-ports.js";
import { createAwaitingPaymentOrder, attachPaymentTxnRef, transitionAwaitingPaymentOrder } from "./storefront.store.js";
import { getAwaitingPaymentOrder } from "./order-record.store.js";
import { listOrderItems } from "./order-record.store.js";
import { OrderActionError } from "../../application/order-action.error.js";
import { InsufficientOrderStock } from "../../application/ports/order-finalization-ports.js";
import { getPaymentSessionByTxnRef } from "../../../vnpay/vnpay.repository.js";

const toOrder = (order: Awaited<ReturnType<typeof getAwaitingPaymentOrder>>): HeldOrder => ({
  id: order.PK.replace(/^ORDER#/, ""), customerEmail: order.customerEmail, status: order.status,
  totalAmount: order.totalAmount, lockedUntil: order.lockedUntil, paymentTxnRef: order.paymentTxnRef, paymentUrl: order.paymentUrl,
  paymentConfirmedAt: order.paymentConfirmedAt });

export class DynamoCheckoutOrders implements CheckoutOrders {
  async hold(input: Parameters<CheckoutOrders["hold"]>[0]) {
    // Session+link are now committed atomically. Unattached holds can be resumed
    // safely; concurrent issuers compete on the order condition in that transaction.
    const replay = async () => {
      const existing = await getAwaitingPaymentOrder(input.orderId);
      if (!existing) return null;
      const lines = await listOrderItems(input.orderId);
      const same = existing.customerEmail === input.email && lines.length === input.items.length &&
        input.items.every(item => lines.some(line => line.productId === item.productId && line.quantity === item.quantity));
      if (!same || existing.status !== "awaiting_payment" || Boolean(existing.paymentUrl) !== Boolean(existing.paymentTxnRef) ||
        existing.lockedUntil <= new Date().toISOString()) {
        throw new OrderActionError("CONFLICT", "Checkout ID already exists, is being prepared, or has expired.");
      }
      return { order: toOrder(existing), items: lines };
    };
    const existing = await replay();
    if (existing) return existing;
    try {
      const result = await createAwaitingPaymentOrder(input);
      return { order: toOrder(result.order), items: result.items };
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (failure?.name === "TransactionCanceledException" && failure.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
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
  async findById(id: string) { const order = await getAwaitingPaymentOrder(id); return order ? toOrder(order) : null; }
  async attachPayment(orderId: string, txnRef: string, email: string, paymentUrl: string) { await attachPaymentTxnRef(orderId, txnRef, email, paymentUrl); }
  async transition(input: Parameters<CheckoutOrders["transition"]>[0]) {
    try {
      const result = await transitionAwaitingPaymentOrder(input);
      return { ...result, order: toOrder(result.order) };
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (failure?.name !== "TransactionCanceledException") throw error;
      const reasons = failure.CancellationReasons ?? [];
      if (reasons[0]?.Code === "ConditionalCheckFailed") {
        const current = await this.findById(input.orderId);
        if (current && current.status !== "awaiting_payment") {
          const result = await transitionAwaitingPaymentOrder(input);
          return { ...result, order: toOrder(result.order) };
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
