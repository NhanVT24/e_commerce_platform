import { createHash, randomUUID } from "node:crypto";
import { GetItemCommand, TransactWriteItemsCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { rawDb } from "../../../database/dynamodb/client.js";
import { databaseConfig } from "../../../config/database-config.js";
import type { InventoryNotifications } from "../application/ports/inventory-notifications.js";

const item = (value: Record<string, unknown>) => marshall(value, { removeUndefinedValues: true });
const identity = (eventId: string, email: string) => createHash("sha256").update(JSON.stringify([eventId, email.trim().toLowerCase()])).digest("hex");
export class DynamoInventoryNotifications implements InventoryNotifications {
  async createOnce(input: Parameters<InventoryNotifications["createOnce"]>[0]) {
    const id = identity(input.eventId, input.email), notificationId = `inventory-${id}`, owner = randomUUID(), now = new Date().toISOString();
    const receipt = { PK: `INVENTORY_ALERT_RECEIPT#${id}`, SK: "DETAIL" };
    try {
      await rawDb.send(new TransactWriteItemsCommand({ TransactItems: [
        { Put: { TableName: databaseConfig.DYNAMODB_TABLE_NAME, ConditionExpression: "attribute_not_exists(PK)", Item: item({
          PK: `NOTIFICATION#${notificationId}`, SK: "DETAIL", entityType: "NOTIFICATION", id: notificationId,
          customerEmail: input.email, title: input.title, message: input.message, channel: "system", status: "pending",
          isRead: false, metadata: input.metadata, createdAt: now, updatedAt: now }) } },
        { Put: { TableName: databaseConfig.DYNAMODB_TABLE_NAME, ConditionExpression: "attribute_not_exists(PK)", Item: item({ ...receipt,
          entityType: "INVENTORY_ALERT_RECEIPT", eventId: input.eventId, notificationId, owner,
          effectsState: "IN_PROGRESS", createdAt: now, updatedAt: now }) } }
      ] }));
      return { created: true, notificationId, owner };
    } catch (error) {
      if ((error as { name?: string }).name !== "TransactionCanceledException") throw error;
      const existing = await rawDb.send(new GetItemCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME, Key: item(receipt), ConsistentRead: true }));
      if (!existing.Item) throw error;
      const row = unmarshall(existing.Item);
      if (row.eventId !== input.eventId || typeof row.notificationId !== "string" || typeof row.owner !== "string") throw new Error("Invalid inventory notification receipt");
      return { created: false, notificationId: String(row.notificationId), owner: String(row.owner) };
    }
  }
  async finish(input: Parameters<InventoryNotifications["finish"]>[0]) {
    const id = identity(input.eventId, input.email);
    await rawDb.send(new UpdateItemCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME,
      Key: item({ PK: `INVENTORY_ALERT_RECEIPT#${id}`, SK: "DETAIL" }),
      ConditionExpression: "#owner = :owner AND effectsState = :progress",
      UpdateExpression: "SET effectsState = :state, effects = :effects, updatedAt = :now",
      ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: item({ ":owner": input.owner,
        ":progress": "IN_PROGRESS", ":state": Object.values(input.effects).includes("UNKNOWN") ? "UNKNOWN" : "COMPLETED",
        ":effects": input.effects, ":now": new Date().toISOString() }) }));
  }
}
