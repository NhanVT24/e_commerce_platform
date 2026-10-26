import { PublishCommand } from "@aws-sdk/client-sns";
import { operationsConfig } from "../../config/operations-config.js";
import { snsClient } from "./client.js";

type PublishAdminAlertInput = {
  subject: string;
  message: string;
  attributes?: Record<string, string | number | boolean | undefined>;
};

export async function publishAdminAlert(input: PublishAdminAlertInput) {
  const topicArn = operationsConfig.SNS_ADMIN_ALERTS_TOPIC_ARN?.trim();
  if (!topicArn) {
    throw new Error("Missing SNS_ADMIN_ALERTS_TOPIC_ARN.");
  }

  const response = await snsClient.send(new PublishCommand({
    TopicArn: topicArn,
    Subject: input.subject.slice(0, 100),
    Message: input.message,
    MessageAttributes: Object.fromEntries(
      Object.entries(input.attributes ?? {})
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
        .map(([key, value]) => [
          key,
          {
            DataType: "String",
            StringValue: String(value)
          }
        ])
    )
  }));

  return {
    topicArn,
    messageId: response.MessageId ?? ""
  };
}
