import { inventoryOutboxWrite } from "./inventory-alert-outbox.js";
import type { InventoryStockAlert } from "../../application/ports/inventory-alert-publisher.js";
import type { ProductStatus, ProductCounters } from "../../domain/product.js";
import type { ProductCounterRepository } from "../../application/ports/product-counter-repository.js";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { keys } from "../../../../database/dynamodb/keys.js";
import type { ProductRecord } from "../../product.types.js";
import { buildProductCategoryIndexKey, toProductCategoryIndexRecord } from "../../indexes/product-category.index.js";
import { toProductRecord, toProduct } from "./product.mapper.js";
import { readProductRecord, toDynamoItem, rethrowProductConflict, missingProductConflict } from "./product-record.store.js";
const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

export async function incrementProductRecord(id: string, field: string, incrementBy = 1, expectedOwnerSub?: string, prepared?: { expectedVersion: number; nextValue: number; status: ProductStatus; inventoryAlert?: InventoryStockAlert; changedBy?: string }) {
  if (field !== "stock" && field !== "soldCount") {
    throw new Error(`Field "${field}" is not allowed for increment.`);
  }

  const current = await readProductRecord(id);
  if (!current) {
    const error = new Error("Product not found");
    error.name = "ConditionalCheckFailedException";
    throw error;
  }

  if (prepared && current.version !== prepared.expectedVersion) throw missingProductConflict();
  const nextValue = prepared?.nextValue ?? toProduct(current).adjustCounter(field, incrementBy)[field];
  const nextRecord = toProductRecord(
    {
      [field]: nextValue,
      updatedAt: new Date().toISOString()
    },
    current
  );

  if (prepared) nextRecord.status = prepared.status;
  const mergedRecord: ProductRecord = {
    ...current,
    [field]: nextValue,
    status: nextRecord.status,
    searchName: nextRecord.searchName,
    updatedAt: nextRecord.updatedAt,
    version: Number(current.version ?? 0) + 1,
    ...(field === "stock" ? { inventoryAlertSent: false } : {})
  };
  if (field === "stock") delete mergedRecord.inventoryAlertSentAt;

  await rawDb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Update: {
          TableName,
          Key: toDynamoItem(keys.product(id)),
          UpdateExpression: [
            "SET #field = :fieldValue",
            "#status = :status",
            "#searchName = :searchName",
            "updatedAt = :updatedAt",
            "#version = #version + :one",
            ...(field === "stock" ? ["#inventoryAlertSent = :inventoryAlertSent"] : [])
          ].join(", ") + (field === "stock" ? " REMOVE inventoryAlertSentAt" : ""),
          ConditionExpression: expectedOwnerSub
            ? "attribute_exists(PK) AND #version = :expectedVersion AND ownerSub = :expectedOwnerSub"
            : "attribute_exists(PK) AND #version = :expectedVersion",
          ExpressionAttributeNames: {
            "#field": field,
            "#status": "status",
            "#searchName": "searchName",
            "#version": "version",
            ...(field === "stock" ? { "#inventoryAlertSent": "inventoryAlertSent" } : {})
          },
          ExpressionAttributeValues: toDynamoItem({
            ":fieldValue": nextValue,
            ":status": nextRecord.status,
            ":searchName": nextRecord.searchName,
            ":updatedAt": nextRecord.updatedAt,
            ":one": 1,
            ":expectedVersion": current.version,
            ...(expectedOwnerSub ? { ":expectedOwnerSub": expectedOwnerSub } : {}),
            ...(field === "stock" ? { ":inventoryAlertSent": false } : {})
          })
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
      ...inventoryOutboxWrite(prepared?.inventoryAlert, mergedRecord.version!, prepared?.changedBy ?? "", TableName, id)
    ]
  }));

  return mergedRecord;
}


export class DynamoProductCounterRepository implements ProductCounterRepository<ProductRecord> {
  async findById(id: string): Promise<ProductCounters | null> {
    const record = await readProductRecord(id);
    return record ? toProduct(record) : null;
  }
  async increment(input: Parameters<ProductCounterRepository<ProductRecord>["increment"]>[0]) {
    try {
      const record = await incrementProductRecord(input.id, input.field, input.incrementBy, input.expectedOwnerId, input);
      return { product: toProduct(record), representation: record };
    } catch (error) { rethrowProductConflict(error, [0]); }
  }
}
