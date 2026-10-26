import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
  type CreateTableCommandInput
} from "@aws-sdk/client-dynamodb";
import { databaseConfig } from "../config/database-config.js";
import { rawDb } from "../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

const tableDefinition: CreateTableCommandInput = {
  TableName,
  BillingMode: "PAY_PER_REQUEST" as const,
  StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
  AttributeDefinitions: [
    { AttributeName: "PK", AttributeType: "S" },
    { AttributeName: "SK", AttributeType: "S" },
    { AttributeName: "status", AttributeType: "S" },
    { AttributeName: "searchName", AttributeType: "S" },
    { AttributeName: "searchField", AttributeType: "S" },
    { AttributeName: "entityType", AttributeType: "S" },
    { AttributeName: "campaignStatus", AttributeType: "S" },
    { AttributeName: "startAt", AttributeType: "S" },
    { AttributeName: "updatedAt", AttributeType: "S" }
  ],
  KeySchema: [
    { AttributeName: "PK", KeyType: "HASH" },
    { AttributeName: "SK", KeyType: "RANGE" }
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "StatusTimelineIndex",
      KeySchema: [
        { AttributeName: "status", KeyType: "HASH" },
        { AttributeName: "updatedAt", KeyType: "RANGE" },
        { AttributeName: "searchName", KeyType: "RANGE" },
        { AttributeName: "PK", KeyType: "RANGE" }
      ],
      Projection: { ProjectionType: "ALL" }
    },
    {
      IndexName: "SearchNameIndex",
      KeySchema: [
        { AttributeName: "searchField", KeyType: "HASH" },
        { AttributeName: "searchName", KeyType: "RANGE" },
        { AttributeName: "PK", KeyType: "RANGE" }
      ],
      Projection: { ProjectionType: "ALL" }
    },
    {
      IndexName: "EntityUpdatedAtIndex",
      KeySchema: [
        { AttributeName: "entityType", KeyType: "HASH" },
        { AttributeName: "updatedAt", KeyType: "RANGE" }
      ],
      Projection: { ProjectionType: "ALL" }
    },
    {
      IndexName: "SaleCampaignTimelineIndex",
      KeySchema: [
        { AttributeName: "campaignStatus", KeyType: "HASH" },
        { AttributeName: "startAt", KeyType: "RANGE" }
      ],
      Projection: { ProjectionType: "ALL" }
    }
  ]
};

async function deleteIfExists() {
  try {
    await rawDb.send(new DescribeTableCommand({ TableName }));
  } catch (error: any) {
    if (error.name === "ResourceNotFoundException") {
      console.log(`Table ${TableName} does not exist. Skipping delete.`);
      return;
    }
    throw error;
  }

  await rawDb.send(new DeleteTableCommand({ TableName }));
  await waitUntilTableNotExists({ client: rawDb, maxWaitTime: 30 }, { TableName });
  console.log(`Deleted table ${TableName}.`);
}

async function createTable() {
  await rawDb.send(new CreateTableCommand(tableDefinition));
  await waitUntilTableExists({ client: rawDb, maxWaitTime: 30 }, { TableName });
  console.log(`Created table ${TableName}.`);
}

await deleteIfExists();
await createTable();
