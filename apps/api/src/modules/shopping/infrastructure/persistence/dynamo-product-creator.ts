import crypto from "node:crypto";
import { Product, type ProductStatus } from "../../domain/product.js";
import type { ProductCreator } from "../../application/ports/product-creator.js";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { keys } from "../../../../database/dynamodb/keys.js";
import type { ProductRecord } from "../../product.types.js";
import { toProductCategoryIndexRecord } from "../../indexes/product-category.index.js";
import { normalizeText, toProductRecord } from "./product.mapper.js";
import { toDynamoItem, rethrowProductConflict } from "./product-record.store.js";
const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

async function createProductRecord(input: ProductRecord, ownerSub: string, identity?: { id: string; createdAt: string; updatedAt: string; status: ProductStatus }) {
  const now = new Date().toISOString();
  const item = toProductRecord(
    {
      ...input,
      id: identity?.id ?? crypto.randomUUID(),
      entityType: "PRODUCT",
      ownerSub,
      searchName: normalizeText(input.name),
      // A new low-stock product has not been included in an inventory alert yet.
      inventoryAlertSent: false,
      version: 1,
      createdAt: identity?.createdAt ?? input.createdAt ?? now,
      updatedAt: identity?.updatedAt ?? input.updatedAt ?? now
    },
    null
  );

  if (identity) item.status = identity.status;
  const productRecord = { ...keys.product(item.id), ...item };
  await rawDb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Put: {
          TableName,
          Item: toDynamoItem(productRecord),
          ConditionExpression: "attribute_not_exists(PK)"
        }
      },
      {
        Put: {
          TableName,
          Item: toDynamoItem(toProductCategoryIndexRecord(productRecord)),
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
        }
      }
    ]
  }));

  return item;
}


export class DynamoProductCreator implements ProductCreator<ProductRecord> {
  async create(input: Parameters<ProductCreator<ProductRecord>["create"]>[0]) {
    input.product.assertValidState();
    const { id, ownerId, version: _version, status: _status, ...details } = input.product.toSnapshot();
    try { return await createProductRecord(details, ownerId, { id, status: Product.stockStatus(input.product.stock),
      createdAt: input.createdAt, updatedAt: input.updatedAt }); }
    catch (error) { rethrowProductConflict(error, [0, 1]); }
  }
}
