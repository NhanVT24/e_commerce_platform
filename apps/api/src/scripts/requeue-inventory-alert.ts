import { parseArgs } from "node:util";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { awsConfig } from "../config/aws-config.js";
import { databaseConfig } from "../config/database-config.js";
import { rawDb } from "../database/dynamodb/client.js";
import { DynamoInventoryAlertOutbox } from "../modules/shopping/infrastructure/persistence/inventory-alert-outbox.js";

const { values } = parseArgs({ options: { "event-id": { type: "string" }, table: { type: "string" }, apply: { type: "boolean", default: false } } });
const eventId = values["event-id"];
if (!eventId?.startsWith("inventory.stock.alert:") || values.table !== databaseConfig.DYNAMODB_TABLE_NAME) {
  throw new Error("Provide --event-id and --table matching DYNAMODB_TABLE_NAME; default is read-only, --apply requeues FAILED only.");
}
try {
  const result = await rawDb.send(new GetItemCommand({ TableName: values.table,
    Key: marshall({ PK: `INVENTORY_ALERT_OUTBOX#${eventId}`, SK: "DETAIL" }), ConsistentRead: true }));
  if (!result.Item) throw new Error("Inventory outbox event not found");
  const row = unmarshall(result.Item);
  console.log(JSON.stringify({ table: values.table, region: awsConfig.AWS_REGION, endpoint: databaseConfig.DYNAMODB_ENDPOINT ?? "AWS",
    eventId, status: row.status, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, apply: values.apply }));
  if (values.apply) {
    const changed = await new DynamoInventoryAlertOutbox(rawDb, values.table).requeueFailed(eventId, new Date().toISOString());
    if (!changed) throw new Error("Requeue rejected: event is not FAILED or another operation changed it");
    console.log("Requeued with the original business event identity. External effects are not reset.");
  }
} finally { rawDb.destroy(); }
