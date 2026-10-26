import { SESv2Client } from "@aws-sdk/client-sesv2";
import { awsConfig } from "../../config/aws-config.js";
import { databaseConfig } from "../../config/database-config.js";

export const sesClient = new SESv2Client({
  region: awsConfig.AWS_REGION,
  credentials: databaseConfig.DYNAMODB_ENDPOINT
    ? { accessKeyId: awsConfig.AWS_ACCESS_KEY_ID, secretAccessKey: awsConfig.AWS_SECRET_ACCESS_KEY }
    : undefined
});
