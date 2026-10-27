import { ScanCommand, TransactWriteItemsCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { rawDb } from "../../../database/dynamodb/client.js";
import { databaseConfig } from "../../../config/database-config.js";
import type { NotifiedOrders } from "../application/complete-notified-order.js";
import { getOrderById } from "../../storefront/infrastructure/persistence/storefront.store.js";

export class DynamoNotifiedOrders implements NotifiedOrders {
  async findById(id: string) {
    const row = await getOrderById(id);
    return row ? { customerEmail: row.customerEmail, status: row.status } : null;
  }
  async hasSentSystemNotification(orderId: string, email: string) {
    let cursor: Record<string, AttributeValue> | undefined;
    do {
      const page = await rawDb.send(new ScanCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME,
        ExclusiveStartKey: cursor, ConsistentRead: true,
        FilterExpression: "entityType = :type AND customerEmail = :email AND channel = :system AND #status = :sent",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: marshall({ ":type": "NOTIFICATION", ":email": email, ":system": "system", ":sent": "sent" }) }));
      if ((page.Items ?? []).some(raw => {
        const row = unmarshall(raw);
        return row.entityType === "NOTIFICATION" && row.customerEmail === email && row.channel === "system" &&
          row.status === "sent" && String(row.metadata?.orderId ?? "") === orderId;
      })) return true;
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return false;
  }
  async completePending(entity: Parameters<NotifiedOrders["completePending"]>[0]) {
    const { id, status } = entity.toSnapshot();
    if (status !== "done") throw new Error("Expected a completed order entity");
    const now = new Date().toISOString();
    try {
      await rawDb.send(new TransactWriteItemsCommand({ TransactItems: [
        { Update: { TableName: databaseConfig.DYNAMODB_TABLE_NAME, Key: marshall({ PK: `ORDER#${id}`, SK: "DETAIL" }),
          UpdateExpression: "SET #status = :done, updatedAt = :now",
          ConditionExpression: "#status = :pendingStatus",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({ ":done": "done", ":pendingStatus": "pending", ":now": now }) } },
        { Put: { TableName: databaseConfig.DYNAMODB_TABLE_NAME, Item: marshall({ PK: `ORDER#${id}`,
          SK: "DETAIL#STATUS_CHANGE#done", entityType: "ORDER_STATUS_AUDIT", orderId: id, status: "done", createdAt: now }) } }
      ] }));
      return true;
    } catch (error) {
      // A competing completion or a lost success response is safe to acknowledge only after a strong read.
      const latest = await getOrderById(id);
      if (latest?.status === "done") return false;
      throw error;
    }
  }
}
