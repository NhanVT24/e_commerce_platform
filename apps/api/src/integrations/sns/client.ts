import { SNSClient } from "@aws-sdk/client-sns";
import { awsConfig } from "../../config/aws-config.js";

export const snsClient = new SNSClient({
  region: awsConfig.AWS_REGION
});
