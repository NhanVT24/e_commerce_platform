import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { deletionAuditPut } from "../../../audit-log/audit-delete.js";
import type { ProductDeleter } from "../../application/ports/product-deleter.js";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { keys } from "../../../../database/dynamodb/keys.js";
import { buildProductCategoryIndexKey } from "../../indexes/product-category.index.js";
import { toProduct } from "./product.mapper.js";
import { readProductRecord, toDynamoItem, rethrowProductConflict, missingProductConflict } from "./product-record.store.js";
const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

export async function deleteProductRecord(id: string, expectedOwnerSub?: string, expectedVersion?: number) {
  const current = await readProductRecord(id);
  if (!current) {
    const error = new Error("Product not found");
    error.name = "ConditionalCheckFailedException";
    throw error;
  }

  if (expectedVersion !== undefined && current.version !== expectedVersion) throw missingProductConflict();
  const deleteCondition = expectedOwnerSub
    ? "attribute_exists(PK) AND #version = :deleteVersion AND ownerSub = :expectedOwnerSub"
    : "attribute_exists(PK) AND #version = :deleteVersion";
  const deleteValues = toDynamoItem({ ":deleteVersion": current.version, ...(expectedOwnerSub ? { ":expectedOwnerSub": expectedOwnerSub } : {}) });
  // The metadata-only marker suppresses the raw REMOVE; the transaction below
  // emits the authoritative delete audit with its actor and exact snapshot.
  await rawDb.send(new UpdateItemCommand({ TableName, Key: toDynamoItem(keys.product(id)),
    UpdateExpression: "SET auditDeleteOutbox = :auditDeleteOutbox", ConditionExpression: deleteCondition,
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ...deleteValues, ":auditDeleteOutbox": { BOOL: true } } }));
  await rawDb.send(new TransactWriteItemsCommand({
    TransactItems: [
      deletionAuditPut(TableName, toDynamoItem({ ...current, ...keys.product(id) })),
      {
        Delete: {
          TableName,
          Key: toDynamoItem(keys.product(id)),
          ConditionExpression: deleteCondition,
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: deleteValues
        }
      },
      {
        Delete: {
          TableName,
          Key: toDynamoItem(buildProductCategoryIndexKey(current.category, current.id, current.updatedAt ?? current.createdAt))
        }
      }
    ]
  }));
}

export class DynamoProductDeleter implements ProductDeleter {
  async findById(id: string) {
    const record = await readProductRecord(id);
    return record ? toProduct(record) : null;
  }
  async delete(input: Parameters<ProductDeleter["delete"]>[0]): Promise<void> {
    try { await deleteProductRecord(input.id, input.expectedOwnerId, input.expectedVersion); }
    catch (error) { rethrowProductConflict(error, [1]); }
  }
}
