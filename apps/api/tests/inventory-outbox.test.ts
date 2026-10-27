import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayInventoryAlerts } from "../src/modules/shopping/application/relay-inventory-alerts.js";
import type { InventoryAlertOutbox, DurableInventoryAlert } from "../src/modules/shopping/application/ports/inventory-alert-outbox.js";
import { Product } from "../src/modules/shopping/domain/product.js";
import { UpdateProduct } from "../src/modules/shopping/application/update-product/update-product.js";
import { IncrementProductField } from "../src/modules/shopping/application/increment-product-field/increment-product-field.js";
import { NotificationUseCases } from "../src/modules/notifications/application/notifications.js";
import type { NotificationEffects } from "../src/modules/notifications/application/ports.js";
import type { InventoryEffects } from "../src/modules/notifications/application/ports/inventory-notifications.js";

const time = Date.parse("2026-10-26T00:00:00Z");
const event: DurableInventoryAlert = { eventId: "inventory.stock.alert:product:2", productId: "product", productVersion: 2,
  productName: "Product", stock: 5, previousStock: 20, status: "low_stock", previousStatus: "active", source: "admin.update", changedBy: "owner", createdAt: new Date(time).toISOString() };
const product = new Product({ id: "product", ownerId: "owner", name: "Product", stock: 20, status: "active", version: 1 });
const actor = { subject: "owner", isAdmin: false };

test("update/counter hand off alert before committing and never call the direct publisher in outbox mode", async () => {
  let direct = 0;
  const publisher = { async publish() { direct++; } };
  let alert: unknown;
  const update = new UpdateProduct({ async findById() { return product; }, async update(input) {
    alert = input.inventoryAlert; assert.equal(input.changedBy, "owner");
    return { product: input.product, representation: "saved" };
  } }, publisher);
  assert.equal(await update.execute({ productId: "product", changes: { stock: 5 }, expectedVersion: 1, actor }), "saved");
  assert.equal((alert as { status: string }).status, "low_stock");
  const counter = new IncrementProductField({ async findById() { return product; }, async increment(input) {
    assert.equal(input.inventoryAlert?.source, "admin.increment");
    return { product: product.adjustCounter(input.field, input.incrementBy), representation: "incremented" };
  } }, publisher);
  assert.equal(await counter.execute({ productId: "product", field: "stock", incrementBy: -15, actor }), "incremented");
  assert.equal(direct, 0);
});

test("no transition has no outbox draft; a rejected commit is not followed by publish", async () => {
  let direct = 0;
  const failure = new Error("ambiguous commit result");
  const update = new UpdateProduct({ async findById() { return product; }, async update(input) {
    assert.equal(input.inventoryAlert, undefined); throw failure;
  } }, { async publish() { direct++; } });
  await assert.rejects(update.execute({ productId: "product", changes: { name: "Next" }, expectedVersion: 1, actor }), error => error === failure);
  assert.equal(direct, 0);
});

function relayFixture() {
  let attempts = 0, pending = true, clock = time;
  const ids: string[] = [], owners: string[] = [];
  let failMarker = true;
  const store: InventoryAlertOutbox = {
    async due() { return pending ? [{ eventId: event.eventId, attempts }] : []; },
    async claim(candidate, owner) { owners.push(owner); return { ...candidate, attempts: ++attempts, owner, event }; },
    async published() { if (failMarker) { failMarker = false; throw new Error("marker response lost"); } pending = false; return true; },
    async retry() { return true; }
  };
  const relay = new RelayInventoryAlerts(store, { async publish(input) { ids.push(input.eventId); } }, () => `owner-${owners.length}`, () => clock);
  return { store, relay, ids, owners, advance() { clock += 120000; } };
}

test("lost publish marker schedules recovery with the same business identity and a fresh lease owner", async () => {
  const f = relayFixture();
  assert.equal((await f.relay.execute()).retry, 1); f.advance();
  assert.equal((await f.relay.execute()).published, 1);
  assert.deepEqual(f.ids, [event.eventId, event.eventId]);
  assert.notEqual(f.owners[0], f.owners[1]);
});

test("a competing claim is skipped; an expired last attempt is failed without another publish", async () => {
  const f = relayFixture(); f.store.claim = async () => null;
  assert.equal((await f.relay.execute()).claimed, 0); assert.deepEqual(f.ids, []);
  f.store.due = async () => [{ eventId: event.eventId, attempts: 8 }];
  f.store.claim = async (candidate, owner) => ({ ...candidate, owner, event, attempts: 9 });
  assert.equal((await f.relay.execute()).failed, 1); assert.deepEqual(f.ids, []);
});

function notificationFixture() {
  const receipts = new Map<string, { effects?: InventoryEffects }>();
  let creates = 0, calls = 0, finishFailure = false, snsFailure = false;
  const effects: NotificationEffects = { newId: () => "test-notification",
    store: {} as NotificationEffects["store"], async findCheckout() { return null; },
    async publish(input) { calls++; assert.equal(input.source, "supermarket.platform"); return { eventId: "bus-id", eventBusName: "bus" }; },
    async adminAlert() { calls++; if (snsFailure) throw new Error("timeout"); return { messageId: "sns-id", topicArn: "topic" }; },
    async orderConfirmation() { throw new Error("unexpected"); }, async paymentFailure() { throw new Error("unexpected"); },
    inventory: { notificationId: () => "notification",
      async createOnce(input) {
        const created = !receipts.has(input.eventId);
        if (created) { creates++; receipts.set(input.eventId, {}); }
        return { created, owner: "receipt-owner", notificationId: "notification" };
      },
      async finish(input) { if (finishFailure) throw new Error("receipt marker failed"); receipts.get(input.eventId)!.effects = input.effects; }
    }
  };
  const service = new NotificationUseCases(null!, null!, effects, { adminEmail: "admin@example.test", platformEventsEnabled: true,
    paymentEventsEnabled: true, commerceEventsEnabled: true, adminAlertsEnabled: true }, { log() {}, warn() {}, error() {} });
  return { service, receipts, counts: () => ({ creates, calls }), failFinish() { finishFailure = true; }, failSns() { snsFailure = true; } };
}

test("duplicate inventory event creates one notification and makes no second external effect attempt", async () => {
  const f = notificationFixture();
  await f.service.processEvent({ ...event, type: "inventory.stock.alert" });
  await f.service.processEvent({ ...event, type: "inventory.stock.alert" });
  assert.deepEqual(f.counts(), { creates: 1, calls: 3 });
  assert.deepEqual(f.receipts.get(event.eventId)?.effects, { notification: "SUCCEEDED", audit: "SUCCEEDED", sns: "SUCCEEDED" });
});

test("ambiguous SNS or completion marker does not trigger blind effect replay", async () => {
  const f = notificationFixture(); f.failSns();
  await f.service.processEvent({ ...event, type: "inventory.stock.alert" });
  assert.equal(f.receipts.get(event.eventId)?.effects?.sns, "UNKNOWN");
  await f.service.processEvent({ ...event, type: "inventory.stock.alert" });
  assert.equal(f.counts().calls, 3);
  const g = notificationFixture(); g.failFinish();
  await assert.rejects(g.service.processEvent({ ...event, type: "inventory.stock.alert" }), /marker failed/);
  await g.service.processEvent({ ...event, type: "inventory.stock.alert" });
  assert.deepEqual(g.counts(), { creates: 1, calls: 3 });
});

test("malformed durable identity cannot silently enter the legacy non-deduplicated path", async () => {
  const f = notificationFixture();
  await assert.rejects(f.service.processEvent({ ...event, type: "inventory.stock.alert", eventId: "foreign" }), /Invalid durable/);
  assert.deepEqual(f.counts(), { creates: 0, calls: 0 });
});
