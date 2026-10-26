import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { databaseConfig } from "../../../../config/database-config.js";
import type { PaymentReview, PaymentReviewWriter } from "../../application/ports/payment-review.js";
import { OrderActionError } from "../../application/order-action.error.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
const encode = (row: Record<string, unknown>) => marshall(row, { removeUndefinedValues: true });
const key = (txnRef: string) => encode({ PK: `PAYMENT_REVIEW#${txnRef}`, SK: "DETAIL" });
const conditional = (error: unknown) => (error as { name?: string })?.name === "ConditionalCheckFailedException";

export class DynamoPaymentReviews implements PaymentReviewWriter {
  async open(review: PaymentReview) {
    const now = new Date().toISOString();
    try {
      await rawDb.send(new PutItemCommand({ TableName, Item: encode({ ...review, PK: `PAYMENT_REVIEW#${review.txnRef}`, SK: "DETAIL",
        entityType: "PAYMENT_REVIEW", status: "payment_review_open", createdAt: now, updatedAt: now }), ConditionExpression: "attribute_not_exists(PK)" }));
    } catch (error) {
      if (!conditional(error)) throw error;
      const current = await rawDb.send(new GetItemCommand({ TableName, Key: key(review.txnRef), ConsistentRead: true }));
      const saved = current.Item && unmarshall(current.Item);
      if (!saved || saved.orderId !== review.orderId || saved.amount !== review.amount) throw new Error("Manual-review identity conflict");
      // "Unconfirmed" is weaker than a later durable successful payment.
      // Reopen that case even if an operator previously closed the uncertainty.
      if (saved.reason === "PROVIDER_UNCONFIRMED" && review.reason !== "PROVIDER_UNCONFIRMED") {
        try {
          await rawDb.send(new UpdateItemCommand({ TableName, Key: key(review.txnRef),
            ConditionExpression: "#reason = :oldReason",
            UpdateExpression: "SET #reason = :reason, #status = :open, updatedAt = :now, reopenedAt = :now, previousResolution = :previous REMOVE resolvedBy, resolutionNote, externalReference, resolvedAt",
            ExpressionAttributeNames: { "#reason": "reason", "#status": "status" },
            ExpressionAttributeValues: encode({ ":oldReason": "PROVIDER_UNCONFIRMED", ":reason": review.reason,
              ":open": "payment_review_open", ":now": now, ":previous": {
                resolvedBy: saved.resolvedBy, resolutionNote: saved.resolutionNote, externalReference: saved.externalReference, resolvedAt: saved.resolvedAt } }) }));
        } catch (escalationError) { if (!conditional(escalationError)) throw escalationError; }
      }
    }
  }
  async list(limit = 20, cursor?: string) {
    let start: Record<string, string> | undefined;
    if (cursor) {
      try { start = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
      catch { throw new OrderActionError("INVALID_INPUT", "Invalid review cursor"); }
      if (!start || Object.keys(start).sort().join(",") !== "PK,SK,entityType,updatedAt" ||
        typeof start.PK !== "string" || !start.PK.startsWith("PAYMENT_REVIEW#") || start.SK !== "DETAIL" ||
        start.entityType !== "PAYMENT_REVIEW" || typeof start.updatedAt !== "string" || !Number.isFinite(Date.parse(start.updatedAt))) {
        throw new OrderActionError("INVALID_INPUT", "Invalid review cursor");
      }
    }
    const result = await rawDb.send(new QueryCommand({ TableName, IndexName: "EntityUpdatedAtIndex", Limit: limit,
      ExclusiveStartKey: start && encode(start), ScanIndexForward: true,
      KeyConditionExpression: "entityType = :entity", FilterExpression: "#status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: encode({ ":status": "payment_review_open", ":entity": "PAYMENT_REVIEW" }) }));
    return { items: (result.Items ?? []).map(item => { const { PK, SK, entityType, ...review } = unmarshall(item); return review; }),
      nextCursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(unmarshall(result.LastEvaluatedKey))).toString("base64url") : null };
  }
  async resolve(txnRef: string, actor: string, note: string, externalReference: string) {
    try {
      await rawDb.send(new UpdateItemCommand({ TableName, Key: key(txnRef),
        ConditionExpression: "#status = :open",
        UpdateExpression: "SET #status = :closed, resolvedBy = :actor, resolutionNote = :note, externalReference = :reference, resolvedAt = :now, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: encode({ ":open": "payment_review_open", ":closed": "payment_review_resolved", ":actor": actor,
          ":note": note, ":reference": externalReference, ":now": new Date().toISOString() }) }));
    } catch (error) { if (conditional(error)) throw new OrderActionError("CONFLICT", "Review missing or already resolved"); throw error; }
  }
}
