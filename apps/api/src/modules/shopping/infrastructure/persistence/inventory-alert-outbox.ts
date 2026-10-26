import { QueryCommand, UpdateItemCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type { DurableInventoryAlert, InventoryAlertOutbox, OutboxCandidate, OutboxClaim } from "../../application/ports/inventory-alert-outbox.js";
import type { InventoryStockAlert } from "../../application/ports/inventory-alert-publisher.js";

const pending = "INVENTORY_ALERT_OUTBOX_PENDING";
const key = (eventId: string) => ({ PK: `INVENTORY_ALERT_OUTBOX#${eventId}`, SK: "DETAIL" });
const item = (value: Record<string, unknown>) => marshall(value, { removeUndefinedValues: true });
const eventSchema = z.object({ eventId: z.string(), productVersion: z.number().int().positive(), changedBy: z.string(), createdAt: z.string().datetime(),
  productId: z.string().min(1), productName: z.string(), sku: z.string().optional(), stock: z.number().int().nonnegative(),
  previousStock: z.number().int().nonnegative(), status: z.enum(["low_stock", "out_of_stock"]), previousStatus: z.string(),
  source: z.enum(["admin.update", "admin.increment"]) });

export function inventoryOutboxWrite(alert: InventoryStockAlert | undefined, version: number, changedBy: string, tableName: string, productId: string): TransactWriteItem[] {
  if (!alert) return [];
  if (alert.productId !== productId) throw new Error("Inventory alert belongs to another product");
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid inventory outbox version");
  const now = new Date().toISOString();
  const event: DurableInventoryAlert = { ...alert, productVersion: version, changedBy, createdAt: now,
    eventId: `inventory.stock.alert:${alert.productId}:${version}` };
  eventSchema.parse(event);
  return [{ Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(PK)",
    Item: item({ ...key(event.eventId), entityType: pending, event, status: "PENDING", attempts: 0,
      createdAt: now, nextAttemptAt: now, updatedAt: now, lastChangedAt: now }) } }];
}

export class DynamoInventoryAlertOutbox implements InventoryAlertOutbox {
  constructor(private readonly db: DynamoDBClient, private readonly tableName: string) {}
  /** Manual recovery only: preserve event identity/payload and reject active/published records. */
  async requeueFailed(eventId: string, now: string) {
    try {
      await this.db.send(new UpdateItemCommand({ TableName: this.tableName, Key: item(key(eventId)),
        ConditionExpression: "#s = :failed AND attribute_not_exists(leaseOwner)",
        UpdateExpression: "SET #s = :ready, entityType = :pending, attempts = :zero, nextAttemptAt = :now, updatedAt = :now, lastChangedAt = :now REMOVE auditExpiresAt",
        ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: item({ ":failed": "FAILED", ":ready": "PENDING", ":pending": pending, ":zero": 0, ":now": now }) }));
      return true;
    } catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false; throw error; }
  }
  async due(now: string, limit: number) {
    const candidates: OutboxCandidate[] = [];
    let cursor: Record<string, AttributeValue> | undefined;
    // Bounded work; unprocessed due items remain queryable on the next tick.
    for (let page = 0; page < 10 && candidates.length < limit; page++) {
      const result = await this.db.send(new QueryCommand({ TableName: this.tableName, IndexName: "EntityUpdatedAtIndex",
        KeyConditionExpression: "entityType = :pending AND updatedAt <= :now", ExpressionAttributeValues: item({ ":pending": pending, ":now": now }),
        Limit: Math.min(25, limit - candidates.length), ExclusiveStartKey: cursor }));
      for (const raw of result.Items ?? []) {
        const row = unmarshall(raw);
        if (typeof row.event?.eventId !== "string" || !Number.isSafeInteger(row.attempts) || row.attempts < 0) throw new Error("Invalid inventory outbox record");
        candidates.push({ eventId: row.event.eventId, attempts: row.attempts });
      }
      cursor = result.LastEvaluatedKey;
      if (!cursor) break;
    }
    return candidates;
  }
  async claim(candidate: OutboxCandidate, owner: string, now: string, until: string): Promise<OutboxClaim | null> {
    try {
      const result = await this.db.send(new UpdateItemCommand({ TableName: this.tableName, Key: item(key(candidate.eventId)),
        ConditionExpression: "entityType = :pending AND attempts = :attempt AND nextAttemptAt <= :now AND (#s = :ready OR (#s = :processing AND leaseUntil <= :now))",
        UpdateExpression: "SET #s = :processing, attempts = :next, leaseOwner = :owner, leaseUntil = :until, nextAttemptAt = :until, updatedAt = :until, lastChangedAt = :now",
        ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: item({ ":pending": pending, ":attempt": candidate.attempts,
          ":next": candidate.attempts + 1, ":now": now, ":ready": "PENDING", ":processing": "PROCESSING", ":owner": owner, ":until": until }), ReturnValues: "ALL_NEW" }));
      const row = unmarshall(result.Attributes!);
      const parsed = eventSchema.safeParse(row.event);
      if (!parsed.success || parsed.data.eventId !== candidate.eventId || parsed.data.eventId !== `inventory.stock.alert:${parsed.data.productId}:${parsed.data.productVersion}`) {
        await this.finish({ eventId: candidate.eventId, attempts: candidate.attempts + 1, owner }, now, now, "FAILED");
        throw new Error("Invalid inventory event quarantined");
      }
      const event = parsed.data;
      return { eventId: candidate.eventId, attempts: candidate.attempts + 1, owner, event };
    } catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") return null; throw error; }
  }
  published(claim: OutboxClaim, now: string) { return this.finish(claim, now, now, "PUBLISHED"); }
  retry(claim: OutboxClaim, now: string, next: string, exhausted: boolean) { return this.finish(claim, now, next, exhausted ? "FAILED" : "PENDING"); }
  private async finish(claim: Pick<OutboxClaim, "eventId" | "attempts" | "owner">, now: string, next: string, state: "PENDING" | "PUBLISHED" | "FAILED") {
    const terminal = state !== "PENDING";
    try {
      await this.db.send(new UpdateItemCommand({ TableName: this.tableName, Key: item(key(claim.eventId)),
        ConditionExpression: "#s = :processing AND leaseOwner = :owner AND attempts = :attempt AND leaseUntil > :now",
        UpdateExpression: "SET #s = :state, entityType = :entity, updatedAt = :next, nextAttemptAt = :next, lastChangedAt = :now" +
          (state === "PUBLISHED" ? ", publishedAt = :now, auditExpiresAt = :ttl" : "") + " REMOVE leaseOwner, leaseUntil",
        ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: item({ ":processing": "PROCESSING", ":owner": claim.owner,
          ":attempt": claim.attempts, ":now": now, ":state": state, ":entity": terminal ? `INVENTORY_ALERT_OUTBOX_${state}` : pending,
          ":next": terminal ? now : next, ":ttl": state === "PUBLISHED" ? Math.floor(Date.parse(now) / 1000) + 30 * 86400 : undefined }) }));
      return true;
    } catch (error) { if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false; throw error; }
  }
}
