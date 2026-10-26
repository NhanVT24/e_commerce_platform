import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { keys } from "../../../../database/dynamodb/keys.js";
import { toProduct } from "./product.mapper.js";
import { buildProductCategoryIndexKey, toProductCategoryIndexRecord } from "../../indexes/product-category.index.js";
import type { ProductRecord } from "../../product.types.js";
import { toDynamoItem } from "./product-record.store.js";

/** Append these operations to the SAME order/refund transaction. A stale
 * snapshot fails its version condition instead of overwriting another writer. */
export function inventoryTransaction(product: ProductRecord, delta: { stock: number; sold: number }, timestamp: string): TransactWriteItem[] {
  const changed = toProduct(product).changeInventory(delta, Number(product.reservedStock ?? 0));
  const stock = changed.stock, sold = changed.soldCount;
  const version = Number(product.version ?? 0);
  if (!product.id) throw new Error(`Invalid inventory transition for ${product.id}`);
  // A different timestamp prevents deleting and putting the same index item
  // twice in one Dynamo transaction, including rapid sequential writes.
  const priorTime = String(product.updatedAt ?? product.createdAt ?? "");
  const priorMs = Date.parse(priorTime);
  const updatedAt = Number.isFinite(priorMs) && Date.parse(timestamp) <= priorMs
    ? new Date(priorMs + 1).toISOString() : timestamp;
  const resetAlert = delta.stock !== 0;
  const next = { ...product, stock, soldCount: sold, version: version + 1,
    status: changed.stockStatus, updatedAt, ...(resetAlert ? { inventoryAlertSent: false } : {}) };
  if (resetAlert) delete next.inventoryAlertSentAt;
  const table = databaseConfig.DYNAMODB_TABLE_NAME;
  return [
    { Update: {
      TableName: table, Key: toDynamoItem(keys.product(String(product.id))),
      ConditionExpression: "attribute_exists(PK) AND " + (product.version === undefined
        ? "attribute_not_exists(#version)" : "#version = :expectedVersion"),
      UpdateExpression: "SET #stock = :stock, soldCount = :sold, #status = :status, #version = :version, updatedAt = :now" +
        (resetAlert ? ", inventoryAlertSent = :alert REMOVE inventoryAlertSentAt" : ""),
      ExpressionAttributeNames: { "#stock": "stock", "#status": "status", "#version": "version" },
      ExpressionAttributeValues: toDynamoItem({ ":stock": stock, ":sold": sold, ":status": next.status,
        ":version": version + 1, ":expectedVersion": product.version === undefined ? undefined : version,
        ":now": updatedAt, ":alert": resetAlert ? false : undefined })
    } },
    { Delete: { TableName: table, Key: toDynamoItem(buildProductCategoryIndexKey(product.category, product.id, priorTime)) } },
    { Put: { TableName: table, Item: toDynamoItem(toProductCategoryIndexRecord({ ...keys.product(String(product.id)), ...next })) } }
  ];
}
