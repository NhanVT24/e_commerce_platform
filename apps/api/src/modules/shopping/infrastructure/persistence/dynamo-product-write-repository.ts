import { inventoryOutboxWrite } from "./inventory-alert-outbox.js";
import type { InventoryStockAlert } from "../../application/ports/inventory-alert-publisher.js";
import { readProductRecord, toDynamoItem, rethrowProductConflict } from "./product-record.store.js";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { keys } from "../../../../database/dynamodb/keys.js";
import { buildProductCategoryIndexKey, toProductCategoryIndexRecord } from "../../indexes/product-category.index.js";
import type { ProductRecord } from "../../product.types.js";
import type { ProductStatus } from "../../domain/product.js";
import type { ProductWriteRepository } from "../../application/ports/product-write-repository.js";
import { normalizeText, toProductRecord, toProduct } from "./product.mapper.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

async function updateProductRecord(id: string, patch: ProductRecord, version: number, expectedOwnerSub?: string, status?: ProductStatus, alert?: InventoryStockAlert, changedBy = "") {
  const current = await readProductRecord(id);
  if (!current) {
    const error = new Error("Product not found");
    error.name = "ConditionalCheckFailedException";
    throw error;
  }

  const merged = toProductRecord(
    { ...patch, updatedAt: new Date().toISOString() },
    current
  );
  if (status !== undefined) merged.status = status;
  const names: Record<string, string> = {
    "#version": "version",
    "#status": "status",
    "#searchName": "searchName",
    "#searchField": "searchField"
  };
  const values: Record<string, unknown> = {
    ":expectedVersion": version,
    ":one": 1,
    ":updatedAt": merged.updatedAt,
    ":status": merged.status,
    ":searchName": normalizeText(merged.name),
    ":searchField": merged.searchField ?? "name"
  };
  const setters = [
    "updatedAt = :updatedAt",
    "#version = #version + :one",
    "#status = :status",
    "#searchName = :searchName",
    "#searchField = :searchField"
  ];
  const stockChanged = Object.hasOwn(patch, "stock") && Number(merged.stock ?? 0) !== Number(current.stock ?? 0);

  for (const [field, value] of Object.entries(patch)) {
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    setters.push(`#${field} = :${field}`);
  }

  if (!Object.hasOwn(patch, "originalPrice")) {
    names["#originalPrice"] = "originalPrice";
    values[":originalPrice"] = merged.originalPrice;
    setters.push("#originalPrice = :originalPrice");
  }

  if (stockChanged) {
    names["#inventoryAlertSent"] = "inventoryAlertSent";
    values[":inventoryAlertSent"] = false;
    setters.push("#inventoryAlertSent = :inventoryAlertSent");
  }

  const nextVersion = Number(current.version ?? version) + 1;
  const mergedRecord: ProductRecord = {
    ...merged,
    version: nextVersion,
    searchName: normalizeText(merged.name),
    searchField: merged.searchField ?? "name",
    ...(stockChanged ? { inventoryAlertSent: false } : {})
  };
  if (stockChanged) {
    delete mergedRecord.inventoryAlertSentAt;
  }

  await rawDb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Update: {
          TableName,
          Key: toDynamoItem(keys.product(id)),
          UpdateExpression: `SET ${setters.join(", ")}${stockChanged ? " REMOVE inventoryAlertSentAt" : ""}`,
          ConditionExpression: expectedOwnerSub
            ? "attribute_exists(PK) AND #version = :expectedVersion AND ownerSub = :expectedOwnerSub"
            : "attribute_exists(PK) AND #version = :expectedVersion",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: toDynamoItem({ ...values, ...(expectedOwnerSub ? { ":expectedOwnerSub": expectedOwnerSub } : {}) })
        }
      },
      {
        Delete: {
          TableName,
          Key: toDynamoItem(buildProductCategoryIndexKey(current.category, current.id, current.updatedAt ?? current.createdAt))
        }
      },
      {
        Put: {
          TableName,
          Item: toDynamoItem(toProductCategoryIndexRecord({ ...keys.product(id), ...mergedRecord }))
        }
      },
      ...inventoryOutboxWrite(alert, nextVersion, changedBy, TableName, id)
    ]
  }));

  return mergedRecord;
}


export class DynamoProductWriteRepository implements ProductWriteRepository<ProductRecord> {
  async findById(id: string) {
    const record = await readProductRecord(id);
    return record ? toProduct(record) : null;
  }

  async update(input: Parameters<ProductWriteRepository<ProductRecord>["update"]>[0]) {
    try {
      input.product.assertValidState();
      input.product.assertVersion(input.expectedVersion);
      const patch = input.product.changesFor(input.fields);
      const record = await updateProductRecord(
        input.product.id, { ...patch }, input.expectedVersion, input.expectedOwnerId, input.product.stockStatus, input.inventoryAlert, input.changedBy
      );
      return { product: toProduct(record), representation: record };
    } catch (error) {
      rethrowProductConflict(error, [0]);
    }
  }
}
