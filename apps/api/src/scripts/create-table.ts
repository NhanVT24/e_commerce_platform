import {
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists
} from "@aws-sdk/client-dynamodb";
import { marketplaceTableDefinition } from "../database/dynamodb/table-definition.js";
import { databaseConfig } from "../config/database-config.js";
import { rawDb } from "../database/dynamodb/client.js";

const tableDefinition = marketplaceTableDefinition(databaseConfig.DYNAMODB_TABLE_NAME);

try {
  await rawDb.send(new DescribeTableCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME }));
  console.log(`Table ${databaseConfig.DYNAMODB_TABLE_NAME} already exists.`);
} catch (error: any) {
  if (error.name !== "ResourceNotFoundException") throw error;

  await rawDb.send(new CreateTableCommand(tableDefinition));
  await waitUntilTableExists(
    { client: rawDb, maxWaitTime: 30 },
    { TableName: databaseConfig.DYNAMODB_TABLE_NAME }
  );
  console.log(`Created table ${databaseConfig.DYNAMODB_TABLE_NAME}.`);
}
