import { GetItemCommand, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import type { StorefrontAwaitingPaymentOrderRecord, StorefrontOrderItemRecord } from "../../storefront.repository.js";
const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
const toDynamoItem = (item: Record<string, unknown>) => marshall(item, { removeUndefinedValues: true });
const fromDynamoItem = (item?: Record<string, AttributeValue>) => item ? unmarshall(item) : null;
const buildOrderMetaKey = (orderId: string) => ({ PK: 'ORDER#' + orderId, SK: 'ORDER' });
export async function listOrderItems(orderId: string) {
  const result = await rawDb.send(new QueryCommand({
    TableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :itemPrefix)",
    ConsistentRead: true,
    ExpressionAttributeValues: toDynamoItem({ ":pk": `ORDER#${orderId}`, ":itemPrefix": "ORDER_ITEM#" })
  }));
  return (result.Items ?? []).map((item) => fromDynamoItem(item) as StorefrontOrderItemRecord | null)
    .filter(Boolean) as StorefrontOrderItemRecord[];
}

export async function getAwaitingPaymentOrder(orderId: string) {
  const result = await rawDb.send(new GetItemCommand({
    TableName,
    Key: toDynamoItem(buildOrderMetaKey(orderId)),
    ConsistentRead: true
  }));
  return result.Item ? unmarshall(result.Item) as StorefrontAwaitingPaymentOrderRecord : null;
}

