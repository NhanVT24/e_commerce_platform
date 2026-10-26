import { PutItemCommand, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../config/database-config.js";
import { rawDb } from "../database/dynamodb/client.js";
import { keys } from "../database/dynamodb/keys.js";
import { toProductCategoryIndexRecord } from "../modules/shopping/indexes/product-category.index.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

function isProductRecord(item: Record<string, any>) {
  return item.entityType === "PRODUCT" || (
    String(item.PK ?? "").startsWith("PRODUCT#") &&
    String(item.SK ?? "") === "DETAIL"
  );
}

async function main() {
  let cursor: Record<string, AttributeValue> | undefined;
  let scanned = 0;
  let indexed = 0;

  do {
    const result = await rawDb.send(new ScanCommand({
      TableName,
      ExclusiveStartKey: cursor,
      FilterExpression: "entityType = :entityType",
      ExpressionAttributeValues: marshall({
        ":entityType": "PRODUCT"
      })
    }));

    for (const rawItem of result.Items ?? []) {
      const item = unmarshall(rawItem) as Record<string, any>;
      scanned += 1;

      if (!isProductRecord(item)) {
        continue;
      }

      await rawDb.send(new PutItemCommand({
        TableName,
        Item: marshall(toProductCategoryIndexRecord({ ...keys.product(item.id), ...item }), {
          removeUndefinedValues: true
        })
      }));

      indexed += 1;
    }

    cursor = result.LastEvaluatedKey;
  } while (cursor);

  console.log(JSON.stringify({
    task: "backfill-product-category-index",
    scanned,
    indexed
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
