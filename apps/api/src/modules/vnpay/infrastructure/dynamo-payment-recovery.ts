import { GetItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { rawDb } from "../../../database/dynamodb/client.js";
import { databaseConfig } from "../../../config/database-config.js";
import { getPaymentSessionByTxnRef } from "../vnpay.repository.js";
import type { PaymentRecoveryQueue, PaymentRecoverySessions, RecoveryLane } from "../application/ports/payment-recovery-ports.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
const encode = (row: Record<string, unknown>) => marshall(row, { removeUndefinedValues: true });
const cursorKey = (lane: RecoveryLane) => encode({ PK: `RECOVERY_CURSOR#payment#${lane}`, SK: "DETAIL" });

export class DynamoPaymentRecovery implements PaymentRecoveryQueue, PaymentRecoverySessions {
  find = getPaymentSessionByTxnRef;
  async page(lane: RecoveryLane, limit: number) {
    const current = await rawDb.send(new GetItemCommand({ TableName, Key: cursorKey(lane), ConsistentRead: true }));
    const state = current.Item ? unmarshall(current.Item) : null;
    const cursor = state?.cursor ? JSON.parse(state.cursor) as Record<string, AttributeValue> : undefined;
    const checkout = lane === "checkout";
    const orderLane = checkout || lane === "refund";
    const result = await rawDb.send(new QueryCommand({ TableName, IndexName: "EntityUpdatedAtIndex",
      ExclusiveStartKey: cursor, Limit: limit, ScanIndexForward: true,
      KeyConditionExpression: "entityType = :entity",
      FilterExpression: "#status = :status" + (lane === "refund" ? " AND attribute_exists(refundRequestId) AND attribute_exists(paymentTxnRef)" : checkout ? " AND attribute_not_exists(paymentTxnRef)" :
        (lane === "pending" ? "" : " AND attribute_not_exists(paymentEventEnqueuedAt)")),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: encode({ ":status": checkout ? "awaiting_payment" : lane === "refund" ? "refund_pending" : lane, ":entity": orderLane ? "ORDER" : "PAYMENT_SESSION" }) }));
    return { ids: (result.Items ?? []).map(item => { const row = unmarshall(item); return orderLane ? String(row.PK).replace(/^ORDER#/, "") : String(row.txnRef); }),
      checkpoint: JSON.stringify({ revision: state?.revision ?? 0, cursor: result.LastEvaluatedKey ? JSON.stringify(result.LastEvaluatedKey) : "" }) };
  }
  async checkpoint(lane: RecoveryLane, checkpoint: string) {
    const state = JSON.parse(checkpoint) as { revision: number; cursor: string };
    try {
      await rawDb.send(new UpdateItemCommand({ TableName, Key: cursorKey(lane),
        ConditionExpression: state.revision === 0 ? "attribute_not_exists(revision)" : "revision = :expected",
        UpdateExpression: "SET #cursor = :cursor, revision = :revision, entityType = :entity, updatedAt = :now",
        ExpressionAttributeNames: { "#cursor": "cursor" },
        ExpressionAttributeValues: encode({ ":expected": state.revision ? state.revision : undefined, ":revision": state.revision + 1,
          ":cursor": state.cursor, ":entity": "PAYMENT_RECOVERY_CURSOR", ":now": new Date().toISOString() }) }));
    } catch (error) { if ((error as { name?: string })?.name !== "ConditionalCheckFailedException") throw error; }
  }
  async defer(txnRef: string, attempts: number, nextAt: string) {
    // Optimistic attempt counter makes only one overlapping job perform this query.
    await rawDb.send(new UpdateItemCommand({ TableName, Key: encode({ PK: `PAYMENT#${txnRef}`, SK: "DETAIL" }),
      ConditionExpression: "#status = :pending AND " + (attempts === 1 ? "attribute_not_exists(recoveryAttempts)" : "recoveryAttempts = :previous"),
      UpdateExpression: "SET recoveryAttempts = :attempts, recoveryNextAt = :next",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: encode({ ":pending": "pending", ":attempts": attempts, ":previous": attempts > 1 ? attempts - 1 : undefined, ":next": nextAt }) }));
  }
}
