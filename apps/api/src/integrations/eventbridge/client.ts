import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { awsConfig } from "../../config/aws-config.js";

export const eventBridgeClient = new EventBridgeClient({
  region: awsConfig.AWS_REGION
});
