import { ScanCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { databaseConfig } from "../config/database-config.js";
import { rawDb } from "../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
const applyChanges = process.argv.includes("--apply");
let lastKey: Record<string, AttributeValue> | undefined;
let matched = 0;
let removed = 0;

do {
  const result = await rawDb.send(new ScanCommand({
    TableName,
    ExclusiveStartKey: lastKey,
    FilterExpression: "entityType = :entityType AND attribute_exists(expiresAt)",
    ExpressionAttributeValues: {
      ":entityType": { S: "CHECKOUT_RESERVATION" }
    },
    ProjectionExpression: "PK, SK"
  }));

  for (const item of result.Items ?? []) {
    matched += 1;
    if (!applyChanges) continue;

    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: { PK: item.PK!, SK: item.SK! },
      // Conditional removal makes the script safe if it is run more than once.
      ConditionExpression: "attribute_exists(expiresAt)",
      UpdateExpression: "REMOVE expiresAt"
    }));
    removed += 1;
  }

  lastKey = result.LastEvaluatedKey;
} while (lastKey);

console.log(applyChanges
  ? `Removed expiresAt from ${removed} checkout reservation record(s).`
  : `Dry run: ${matched} checkout reservation record(s) still have expiresAt. Run again with --apply to remove it.`
);
