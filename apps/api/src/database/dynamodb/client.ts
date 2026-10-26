import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { attachAuditWriteMiddleware } from "../../modules/audit-log/audit-write.js";
import { awsConfig } from "../../config/aws-config.js";
import { databaseConfig } from "../../config/database-config.js";

const client = new DynamoDBClient({
  region: awsConfig.AWS_REGION,
  endpoint: databaseConfig.DYNAMODB_ENDPOINT,
  credentials: databaseConfig.DYNAMODB_ENDPOINT
    ? { accessKeyId: awsConfig.AWS_ACCESS_KEY_ID, secretAccessKey: awsConfig.AWS_SECRET_ACCESS_KEY }
    : undefined
});

attachAuditWriteMiddleware(client, () => databaseConfig.DYNAMODB_TABLE_NAME);

export { client as rawDb };
