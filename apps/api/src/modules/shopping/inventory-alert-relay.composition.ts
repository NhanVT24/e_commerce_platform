import { randomUUID } from "node:crypto";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { RelayInventoryAlerts } from "./application/relay-inventory-alerts.js";
import { DynamoInventoryAlertOutbox } from "./infrastructure/persistence/inventory-alert-outbox.js";

export function createInventoryAlertRelay() {
  const config = z.object({ DYNAMODB_TABLE_NAME: z.string().min(1), EVENTBRIDGE_PLATFORM_BUS_NAME: z.string().min(1),
    AWS_REGION: z.string().default("ap-southeast-1"), DYNAMODB_ENDPOINT: z.string().url().optional() }).parse(process.env);
  const db = new DynamoDBClient({ region: config.AWS_REGION, endpoint: config.DYNAMODB_ENDPOINT, maxAttempts: 2 });
  const events = new EventBridgeClient({ region: config.AWS_REGION, maxAttempts: 1 });
  return new RelayInventoryAlerts(new DynamoInventoryAlertOutbox(db, config.DYNAMODB_TABLE_NAME), { async publish(event) {
    const result = await events.send(new PutEventsCommand({ Entries: [{ EventBusName: config.EVENTBRIDGE_PLATFORM_BUS_NAME,
      Source: "supermarket.inventory", DetailType: "inventory.stock.alert", Detail: JSON.stringify({ ...event, type: "inventory.stock.alert", alertLevel: event.status }) }] }),
    { abortSignal: AbortSignal.timeout(5000) });
    if (result.FailedEntryCount || !result.Entries?.[0]?.EventId) throw new Error("Inventory event publish was not confirmed");
  } }, randomUUID);
}
