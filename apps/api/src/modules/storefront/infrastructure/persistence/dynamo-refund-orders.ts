import { DynamoPaymentRecovery } from "../../../vnpay/infrastructure/dynamo-payment-recovery.js";
import { UpdateItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { inventoryTransaction } from "../../../shopping/infrastructure/persistence/inventory-transaction.js";
import { readProductRecord } from "../../../shopping/infrastructure/persistence/product-record.store.js";
import type { StorefrontAwaitingPaymentOrderRecord } from "../../storefront.repository.js";
import type { RefundOrder } from "../../domain/order-refund.js";
import { REFUND_WINDOW_MS, isTerminalRefund } from "../../domain/order-refund.js";
import { OrderActionError } from "../../application/order-action.error.js";
import type { RefundOrderRepository } from "../../application/ports/order-lifecycle-ports.js";
import { getAwaitingPaymentOrder, listOrderItems } from "./order-record.store.js";
const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
const toDynamoItem = (item: Record<string, unknown>) => marshall(item, { removeUndefinedValues: true });
const buildOrderMetaKey = (orderId: string) => ({ PK: 'ORDER#' + orderId, SK: 'ORDER' });

export function toRefundOrder(record: StorefrontAwaitingPaymentOrderRecord): RefundOrder {
  return { id: record.PK.replace(/^ORDER#/, ''), customerEmail: record.customerEmail,
    status: record.status, totalAmount: record.totalAmount, paymentTxnRef: record.paymentTxnRef,
    paymentConfirmedAt: record.paymentConfirmedAt, refundRequestId: record.refundRequestId,
    refundStatus: record.refundStatus, refundTransactionNo: record.refundTransactionNo };
}

function conditionalOrderFailure(error: unknown): boolean {
  const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return failure?.name === 'ConditionalCheckFailedException' ||
    (failure?.name === 'TransactionCanceledException' && failure.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed');
}

/** Bounded reconciliation read; avoids scanning the full marketplace table. */
async function listPendingRefundRecords(limit = 50) {
  const recovery = new DynamoPaymentRecovery();
  const page = await recovery.page("refund", Math.min(Math.max(Math.trunc(limit), 1), 100));
  const records = (await Promise.all(page.ids.map(getAwaitingPaymentOrder))).filter(Boolean);
  // Advance a bounded page even when all candidates were filtered out. A crash
  // after this read is retried on cursor wrap; no refund request is re-sent.
  await recovery.checkpoint("refund", page.checkpoint);
  return records;
}


async function beginRefund(orderId: string, paymentConfirmedAt: string, requestId: string, customerEmail: string, timestamp: number) {
  const now = new Date(timestamp).toISOString();
  const cutoff = new Date(timestamp - REFUND_WINDOW_MS).toISOString();
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: toDynamoItem(buildOrderMetaKey(orderId)),
    ConditionExpression: "#status = :paid AND paymentConfirmedAt = :paidAt AND paymentConfirmedAt > :cutoff AND attribute_exists(paymentTxnRef) AND attribute_not_exists(refundRequestId) AND customerEmail = :customerEmail",
    UpdateExpression: "SET #status = :pending, refundRequestId = :requestId, refundStatus = :refundStatus, refundUpdatedAt = :now, updatedAt = :now, auditActorType = :auditActorType, auditActorId = :auditActorId, auditActorRole = :auditActorRole, auditSource = :auditSource, auditReason = :auditReason, auditRequestId = :auditRequestId",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: toDynamoItem({ ":customerEmail": customerEmail, ":paid": "paid", ":paidAt": paymentConfirmedAt, ":cutoff": cutoff,
      ":pending": "refund_pending", ":requestId": requestId, ":refundStatus": "pending", ":now": now,
      ":auditActorType": "SERVICE", ":auditActorId": "service:refund-api", ":auditActorRole": "SYSTEM",
      ":auditSource": "REFUND_API", ":auditReason": "refund_requested", ":auditRequestId": requestId })
  }));
}

async function persistRefundOutcome(input: { orderId: string; requestId: string; status: "refund_pending" | "refund_sent" | "refund_rejected"; gatewayStatus: string; transactionNo?: string }) {
  const now = new Date().toISOString();
  const update = input.transactionNo
    ? "SET #status = :status, refundStatus = :gatewayStatus, refundTransactionNo = :transactionNo, refundUpdatedAt = :now, updatedAt = :now, auditActorType = :auditActorType, auditActorId = :auditActorId, auditActorRole = :auditActorRole, auditSource = :auditSource, auditReason = :auditReason, auditRequestId = :auditRequestId"
    : "SET #status = :status, refundStatus = :gatewayStatus, refundUpdatedAt = :now, updatedAt = :now, auditActorType = :auditActorType, auditActorId = :auditActorId, auditActorRole = :auditActorRole, auditSource = :auditSource, auditReason = :auditReason, auditRequestId = :auditRequestId";
  const orderUpdate = {
    TableName,
    Key: toDynamoItem(buildOrderMetaKey(input.orderId)),
    ConditionExpression: "refundRequestId = :requestId AND #status = :pending",
    UpdateExpression: update,
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: toDynamoItem({
      ":requestId": input.requestId, ":status": input.status, ":gatewayStatus": input.gatewayStatus,
      ":transactionNo": input.transactionNo, ":now": now,
      ":pending": "refund_pending",
      ":auditActorType": "SERVICE", ":auditActorId": "service:vnpay-refund", ":auditActorRole": "SYSTEM",
      ":auditSource": "VNPAY_REFUND", ":auditReason": input.status, ":auditRequestId": input.requestId
    })
  };
  if (input.status !== "refund_sent") {
    await rawDb.send(new UpdateItemCommand(orderUpdate));
    return;
  }
  const items = await listOrderItems(input.orderId);
  if (items.length === 0) throw new Error("Order items missing during refund");
  const inventoryWrites = (await Promise.all(items.map(async item => {
    const product = await readProductRecord(item.productId);
    if (!product) throw new Error('Product missing during refund');
    return inventoryTransaction(product, { stock: item.quantity, sold: -item.quantity }, now);
  }))).flat();
  await rawDb.send(new TransactWriteItemsCommand({
    TransactItems: [
      { Update: orderUpdate },
      ...inventoryWrites
    ]
  }));
}


export class DynamoRefundOrders implements RefundOrderRepository {
  async findById(id: string) {
    const record = await getAwaitingPaymentOrder(id);
    return record ? toRefundOrder(record) : null;
  }
  async listPending(limit: number) { return (await listPendingRefundRecords(limit)).map(toRefundOrder); }
  async claim(input: Parameters<RefundOrderRepository['claim']>[0]): Promise<void> {
    try { await beginRefund(input.orderId, input.paymentConfirmedAt, input.requestId, input.customerEmail, input.now); }
    catch (error) {
      if (conditionalOrderFailure(error)) throw new OrderActionError('CONFLICT', 'Refund already requested or order changed.');
      throw error;
    }
  }
  async saveOutcome(input: Parameters<RefundOrderRepository['saveOutcome']>[0]) {
    const before = await this.findById(input.orderId);
    if (!before || before.refundRequestId !== input.requestId) throw new OrderActionError('CONFLICT', 'Refund request changed.');
    if (isTerminalRefund(before.status)) return { order: before, changed: false };
    try {
      await persistRefundOutcome({ orderId: input.orderId, requestId: input.requestId,
        status: input.outcome.status, gatewayStatus: input.outcome.gatewayStatus, transactionNo: input.outcome.transactionNo });
      return { order: { ...before, status: input.outcome.status, refundStatus: input.outcome.gatewayStatus,
        refundTransactionNo: input.outcome.transactionNo || before.refundTransactionNo }, changed: true };
    } catch (error) {
      if (conditionalOrderFailure(error)) {
        const winner = await this.findById(input.orderId);
        if (winner?.refundRequestId === input.requestId && isTerminalRefund(winner.status)) return { order: winner, changed: false };
        throw new OrderActionError('CONFLICT', 'Refund request changed.');
      }
      throw error;
    }
  }
}
