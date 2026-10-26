import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { keys } from "../../../../database/dynamodb/keys.js";
import type { ProductRecord } from "../../product.types.js";
import { ProductMutationError } from "../../application/product-mutation.error.js";
const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
export const toDynamoItem = (item: Record<string, unknown>) => marshall(item, { removeUndefinedValues: true });

export async function readProductRecord(id: string): Promise<ProductRecord | null> {
  const result = await rawDb.send(new GetItemCommand({
    TableName, Key: toDynamoItem(keys.product(id)), ConsistentRead: true
  }));
  return result.Item ? unmarshall(result.Item) as ProductRecord : null;
}

export function missingProductConflict(): Error {
  return Object.assign(new Error("Product not found or changed"), { name: "ConditionalCheckFailedException" });
}

export function rethrowProductConflict(error: unknown, positions: readonly number[]): never {
  if (error && typeof error === "object") {
    const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
    // Inspect only the business operation positions. Audit-event identity
    // collisions, throttling and validation failures are not business conflicts.
    if (failure.name === "ConditionalCheckFailedException" ||
      (failure.name === "TransactionCanceledException" &&
        positions.some(index => failure.CancellationReasons?.[index]?.Code === "ConditionalCheckFailed"))) {
      throw new ProductMutationError("CONFLICT", "Record changed, missing, or condition failed");
    }
  }
  throw error;
}
