import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { eventbridgeConfig } from "../../config/eventbridge-config.js";
import { eventBridgeClient } from "./client.js";

type PublishEventInput = {
  busName?: string;
  source: string;
  detailType: string;
  detail: Record<string, unknown>;
};

export async function publishEventBridgeEvent(input: PublishEventInput) {
  const eventBusName = input.busName?.trim() || eventbridgeConfig.EVENTBRIDGE_DEFAULT_BUS_NAME?.trim();
  if (!eventBusName) {
    throw new Error(`Missing EventBridge bus for detailType=${input.detailType}`);
  }

  const response = await eventBridgeClient.send(new PutEventsCommand({
    Entries: [
      {
        EventBusName: eventBusName,
        Source: input.source,
        DetailType: input.detailType,
        Detail: JSON.stringify(input.detail),
        Time: new Date()
      }
    ]
  }));

  const failedCount = Number(response.FailedEntryCount ?? 0);
  if (failedCount > 0) {
    const firstEntry = response.Entries?.[0];
    throw new Error(firstEntry?.ErrorMessage || `EventBridge publish failed for detailType=${input.detailType}`);
  }

  return {
    eventBusName,
    eventId: response.Entries?.[0]?.EventId ?? ""
  };
}
