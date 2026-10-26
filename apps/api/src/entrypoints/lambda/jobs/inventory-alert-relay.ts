import { createInventoryAlertRelay } from "../../../modules/shopping/inventory-alert-relay.composition.js";
const relay = createInventoryAlertRelay();
export const handler = async () => {
  const result = await relay.execute();
  console.log(JSON.stringify({ event: "inventory.outbox.tick", ...result }));
  console.log(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: "Supermarket/InventoryOutbox",
    Dimensions: [["Service"]], Metrics: [{ Name: "Failed", Unit: "Count" }] }] }, Service: "inventory-alert-relay", Failed: result.failed }));
  return result;
};
