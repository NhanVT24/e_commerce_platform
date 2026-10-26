import { ScanCommand, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import type { RevenueReader, RevenueOrder, RevenueLine } from "../../application/weekly-revenue.js";
const line = (item: Record<string, unknown>): RevenueLine => ({ productId: String(item.productId ?? ""), productName: String(item.productName ?? ""), quantity: Number(item.quantity ?? 0), lineTotal: Number(item.lineTotal ?? 0) });
export class DynamoRevenueReader implements RevenueReader {
    async list() {
        const orders: RevenueOrder[] = [];
        let cursor: Record<string, AttributeValue> | undefined;
        do {
            const page = await rawDb.send(new ScanCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME, ExclusiveStartKey: cursor,
                FilterExpression: "entityType = :entity AND #status IN (:paid, :done, :pending)", ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: marshall({ ":entity": "ORDER", ":paid": "paid", ":done": "done", ":pending": "pending" }) }));
            for (const raw of page.Items ?? []) {
                const row = unmarshall(raw), id = String(row.id ?? String(row.PK).replace(/^ORDER#/, ""));
                const items: RevenueLine[] = [];
                if (Array.isArray(row.items))
                    items.push(...row.items.map(line));
                else {
                    let itemCursor: Record<string, AttributeValue> | undefined;
                    do {
                        const lines = await rawDb.send(new QueryCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME, ExclusiveStartKey: itemCursor,
                            KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)", ExpressionAttributeValues: marshall({ ":pk": row.PK, ":prefix": "ORDER_ITEM#" }) }));
                        items.push(...(lines.Items ?? []).map(raw => line(unmarshall(raw))));
                        itemCursor = lines.LastEvaluatedKey;
                    } while (itemCursor);
                }
                orders.push({ id, customerEmail: String(row.customerEmail ?? ""), status: String(row.status ?? ""), createdAt: String(row.createdAt ?? ""), totalAmount: Number(row.totalAmount ?? 0), items });
            }
            cursor = page.LastEvaluatedKey;
        } while (cursor);
        return orders;
    }
}
