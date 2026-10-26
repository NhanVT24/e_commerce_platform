import { ScanCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../config/database-config.js";
import { rawDb } from "../database/dynamodb/client.js";

const tableName = databaseConfig.DYNAMODB_TABLE_NAME;
let cursor: Record<string, AttributeValue> | undefined;
let removedCount = 0;

do {
  const page = await rawDb.send(new ScanCommand({
    TableName: tableName,
    ExclusiveStartKey: cursor,
    FilterExpression: "entityType = :entityType AND SK = :sk AND attribute_exists(id)",
    ExpressionAttributeValues: marshall({
      ":entityType": "ORDER",
      ":sk": "ORDER"
    })
  }));

  for (const rawItem of page.Items ?? []) {
    const item = unmarshall(rawItem);
    await rawDb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ PK: item.PK, SK: item.SK }),
      ConditionExpression: "attribute_exists(PK) AND attribute_exists(id)",
      UpdateExpression: "REMOVE id"
    }));
    removedCount += 1;
  }

  cursor = page.LastEvaluatedKey;
} while (cursor);

console.log(`Removed redundant id from ${removedCount} awaiting-payment order record(s) in ${tableName}.`);
