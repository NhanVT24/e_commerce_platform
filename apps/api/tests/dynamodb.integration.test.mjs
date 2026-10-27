import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CreateTableCommand, DeleteTableCommand, DeleteItemCommand, GetItemCommand, ListTablesCommand, PutItemCommand, QueryCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

// Fail closed: this test creates and deletes a generated table, exclusively on loopback.
const configured = process.env.PHASE7_DYNAMODB_ENDPOINT;
if (!configured) throw new Error("Set PHASE7_DYNAMODB_ENDPOINT to an isolated DynamoDB Local endpoint.");
const endpoint = new URL(configured);
if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
  throw new Error("Integration tests require an explicit loopback HTTP endpoint and port; AWS endpoints are forbidden.");
}
const table = `Phase7_${randomUUID().replaceAll("-", "")}`;
process.env.DYNAMODB_ENDPOINT = endpoint.origin;
process.env.DYNAMODB_TABLE_NAME = table;
process.env.AWS_ACCESS_KEY_ID = "local";
process.env.AWS_SECRET_ACCESS_KEY = "local";
process.env.AWS_REGION = "ap-southeast-1";
process.env.VNPAY_TMN_CODE = "LOCALTEST";
process.env.VNPAY_HASH_SECRET = "local-integration-only";
process.env.VNPAY_RETURN_URL = "https://example.test/return";
process.env.VNPAY_IPN_URL = "https://example.test/ipn";
const { rawDb } = await import("../dist/src/database/dynamodb/client.js");
const { marketplaceTableDefinition } = await import("../dist/src/database/dynamodb/table-definition.js");
const { CreateProduct } = await import("../dist/src/modules/shopping/application/create-product/create-product.js");
const { UpdateProduct } = await import("../dist/src/modules/shopping/application/update-product/update-product.js");
const { DynamoProductCreator } = await import("../dist/src/modules/shopping/infrastructure/persistence/dynamo-product-creator.js");
const { DynamoProductWriteRepository } = await import("../dist/src/modules/shopping/infrastructure/persistence/dynamo-product-write-repository.js");
const { DynamoCheckoutOrders } = await import("../dist/src/modules/storefront/infrastructure/persistence/dynamo-checkout-orders.js");
const { DynamoOrderReader } = await import("../dist/src/modules/storefront/infrastructure/persistence/dynamo-order-reader.js");
const { GetOrderDetails } = await import("../dist/src/modules/storefront/application/read-orders/read-orders.js");
const { DynamoNotifiedOrders } = await import("../dist/src/modules/notifications/infrastructure/dynamo-notified-orders.js");
const { CompleteNotifiedOrder } = await import("../dist/src/modules/notifications/application/complete-notified-order.js");
const { DynamoPaymentRecovery } = await import("../dist/src/modules/vnpay/infrastructure/dynamo-payment-recovery.js");
const { DynamoProfiles } = await import("../dist/src/modules/customers/authorization/infrastructure/profile-adapters.js");
const { ProfileChange } = await import("../dist/src/modules/customers/authorization/domain/user-profile.js");
const { Order } = await import("../dist/src/modules/storefront/domain/order.js");
const { Notification } = await import("../dist/src/modules/notifications/domain/notification.js");
const { Product } = await import("../dist/src/modules/shopping/domain/product.js");
const { DynamoInventoryAlertOutbox } = await import("../dist/src/modules/shopping/infrastructure/persistence/inventory-alert-outbox.js");
const { DynamoInventoryNotifications } = await import("../dist/src/modules/notifications/infrastructure/inventory-notifications.js");
const { IncrementProductField } = await import("../dist/src/modules/shopping/application/increment-product-field/increment-product-field.js");
const { DynamoProductCounterRepository } = await import("../dist/src/modules/shopping/infrastructure/persistence/dynamo-product-counter-repository.js");
const { RelayInventoryAlerts } = await import("../dist/src/modules/shopping/application/relay-inventory-alerts.js");
const { NotificationUseCases } = await import("../dist/src/modules/notifications/application/notifications.js");
let created = false;
const email = "integration@example.test", actor = { subject: "integration-owner", isAdmin: false };
const read = async (PK, SK = "DETAIL") => {
  const result = await rawDb.send(new GetItemCommand({ TableName: table, Key: marshall({ PK, SK }), ConsistentRead: true }));
  return result.Item ? unmarshall(result.Item) : null;
};
const put = row => rawDb.send(new PutItemCommand({ TableName: table, Item: marshall(row) }));
async function seedProduct(stock = 20) {
  const id = randomUUID();
  await new CreateProduct(new DynamoProductCreator(), () => id, () => new Date()).execute({ actor, details: {
    name: "Integration product", category: "Gia dung", brand: "Test", sku: `SKU-${id}`, stock, price: 1000,
    imageUrl: "https://example.test/product.png", location: "Test", description: "Disposable integration product"
  } });
  return id;
}
before(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await rawDb.send(new ListTablesCommand({ Limit: 1 }), { abortSignal: AbortSignal.timeout(2000) }); break; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  await rawDb.send(new CreateTableCommand(marketplaceTableDefinition(table)));
  created = true;
  await waitUntilTableExists({ client: rawDb, maxWaitTime: 30 }, { TableName: table });
});
after(async () => {
  try { if (created) await rawDb.send(new DeleteTableCommand({ TableName: table })); }
  finally { rawDb.destroy(); }
});

test("engine: profile updates cannot upsert a missing or unrelated record", async () => {
  const profiles = new DynamoProfiles(), subject = randomUUID();
  await assert.rejects(profiles.update(new ProfileChange(subject, { displayName: "User" }), { code: "INVALID_INPUT" }));
  assert.equal(await read(`USER#${subject}`, "PROFILE"), null);
  await put({ PK: `USER#${subject}`, SK: "PROFILE", entityType: "OTHER", displayName: "Original" });
  await assert.rejects(profiles.update(new ProfileChange(subject, { displayName: "Wrong" }), { code: "INVALID_INPUT" }));
  assert.equal((await read(`USER#${subject}`, "PROFILE")).displayName, "Original");
  await put({ PK: `USER#${subject}`, SK: "PROFILE", entityType: "USER_PROFILE", displayName: "Original", avatarKey: "" });
  await profiles.update(new ProfileChange(subject, { displayName: "Updated" }));
  assert.equal((await profiles.find(subject)).displayName, "Updated");
});

test("engine: optimistic product writes allow one version winner and enforce owner at the write boundary", async () => {
  const id = await seedProduct(), repository = new DynamoProductWriteRepository();
  const flow = new UpdateProduct(repository, { async publish() {} });
  const results = await Promise.allSettled(["Winner A", "Winner B"].map(name => flow.execute({ productId: id,
    changes: { name }, expectedVersion: 1, actor })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await read(`PRODUCT#${id}`)).version, 2);
  await assert.rejects(repository.update({ product: (await repository.findById(id)).update({ name: "Wrong owner" }), fields: ["name"], expectedVersion: 2, expectedOwnerId: "foreign" }), { code: "CONFLICT" });
  assert.equal((await read(`PRODUCT#${id}`)).version, 2);
});

test("engine: passive hydration cannot bypass assertions at product write boundaries", async () => {
  const id = await seedProduct();
  const row = await read(`PRODUCT#${id}`);
  await put({ ...row, soldCount: -1 });
  const repository = new DynamoProductWriteRepository();
  const entity = await repository.findById(id);
  assert.ok(entity instanceof Product);
  assert.equal(entity.soldCount, -1);
  const flow = new UpdateProduct(repository, { async publish() { throw new Error("Must not publish"); } });
  await assert.rejects(flow.execute({ productId: id, actor, expectedVersion: 1, changes: { stock: 5 } }), { code: "INVALID_INPUT" });
  const unchanged = await read(`PRODUCT#${id}`);
  assert.equal(unchanged.version, 1); assert.equal(unchanged.stock, row.stock);
  const uncreatedId = randomUUID();
  const invalid = new Product({ ...entity.toSnapshot(), id: uncreatedId });
  await assert.rejects(new DynamoProductCreator().create({ product: invalid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), { code: "INVALID_INPUT" });
  assert.equal(await read(`PRODUCT#${uncreatedId}`), null);
});

test("engine: competing checkouts cannot oversell; replay does not deduct stock twice; cancel releases once", async () => {
  const id = await seedProduct(4), orders = new DynamoCheckoutOrders();
  const input = orderId => ({ orderId, email, items: [{ productId: id, quantity: 3 }], holdSeconds: 300 });
  const ids = [randomUUID(), randomUUID()];
  const results = await Promise.allSettled(ids.map(orderId => holdCheckout(orders, input(orderId))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = ids[results.findIndex(result => result.status === "fulfilled")];
  assert.equal((await read(`PRODUCT#${id}`)).stock, 1);
  await holdCheckout(orders, input(winner)); assert.equal((await read(`PRODUCT#${id}`)).stock, 1);
  const details = await new GetOrderDetails(new DynamoOrderReader()).execute(email, winner);
  assert.equal(details.items[0].price, 1000); assert.equal(details.totalAmount, 3000);
  await assert.rejects(new GetOrderDetails(new DynamoOrderReader()).execute("foreign", winner), { code: "NOT_FOUND" });
  assert.equal((await orders.transition({ order: new Order(await orders.findById(winner)), expectedCustomerEmail: email, status: "cancelled" })).changed, true);
  assert.equal((await orders.transition({ order: new Order(await orders.findById(winner)), expectedCustomerEmail: email, status: "cancelled" })).changed, false);
  assert.equal((await read(`PRODUCT#${id}`)).stock, 4);
});

test("engine: product/counter and outbox commit together; a rejected owner cannot leave a ghost event", async () => {
  const id = await seedProduct();
  let direct = 0;
  const publisher = { async publish() { direct++; } };
  const repository = new DynamoProductWriteRepository();
  await new UpdateProduct(repository, publisher).execute({ productId: id, actor, changes: { stock: 5 }, expectedVersion: 1 });
  const eventId = `inventory.stock.alert:${id}:2`;
  const outbox = await read(`INVENTORY_ALERT_OUTBOX#${eventId}`);
  assert.equal(outbox.event.eventId, eventId); assert.equal(outbox.event.changedBy, actor.subject);
  assert.equal(outbox.status, "PENDING"); assert.equal(outbox.auditExpiresAt, undefined);
  assert.equal((await read(`PRODUCT#${id}`)).version, 2);
  await assert.rejects(repository.update({ product: (await repository.findById(id)).update({ stock: 0 }), fields: ["stock"], expectedVersion: 2, expectedOwnerId: "foreign",
    inventoryAlert: { ...outbox.event, stock: 0, previousStock: 5, status: "out_of_stock", previousStatus: "low_stock" }, changedBy: actor.subject }), { code: "CONFLICT" });
  assert.equal(await read(`INVENTORY_ALERT_OUTBOX#inventory.stock.alert:${id}:3`), null);
  assert.equal((await read(`PRODUCT#${id}`)).stock, 5);
  const other = await seedProduct();
  await new IncrementProductField(new DynamoProductCounterRepository(), publisher).execute({ productId: other, actor, field: "stock", incrementBy: -15 });
  assert.equal((await read(`INVENTORY_ALERT_OUTBOX#inventory.stock.alert:${other}:2`)).event.source, "admin.increment");
  assert.equal(direct, 0);
});

async function dueEvent(store, eventId, now) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = (await store.due(new Date(now).toISOString(), 100)).find(item => item.eventId === eventId);
    if (candidate) return candidate;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Outbox event did not reach the due index");
}

test("engine: competing relay claims have one owner; expired owners cannot complete or reschedule", async () => {
  const id = await seedProduct();
  await new UpdateProduct(new DynamoProductWriteRepository(), { async publish() {} }).execute({ productId: id, actor, changes: { stock: 0 }, expectedVersion: 1 });
  const eventId = `inventory.stock.alert:${id}:2`, store = new DynamoInventoryAlertOutbox(rawDb, table);
  const now = Date.now() + 10000, iso = value => new Date(value).toISOString();
  const candidate = await dueEvent(store, eventId, now);
  const claims = await Promise.all(["one", "two"].map(owner => store.claim(candidate, owner, iso(now), iso(now + 120000))));
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean);
  assert.equal(await store.published(first, iso(now + 120001)), false);
  const second = await store.claim({ eventId, attempts: 1 }, "new-owner", iso(now + 120001), iso(now + 240001));
  assert.ok(second);
  assert.equal(await store.retry(first, iso(now + 120002), iso(now + 180000), false), false);
  assert.equal(await store.published(first, iso(now + 120002)), false);
  assert.equal(await store.published(second, iso(now + 120002)), true);
  const row = await read(`INVENTORY_ALERT_OUTBOX#${eventId}`);
  assert.equal(row.status, "PUBLISHED"); assert.ok(row.auditExpiresAt); assert.equal(row.leaseOwner, undefined);
  assert.equal(await store.requeueFailed(eventId, iso(now + 120003)), false);
});

test("engine: invalid event is quarantined; explicit recovery preserves identity and rejects active events", async () => {
  const id = await seedProduct();
  await new UpdateProduct(new DynamoProductWriteRepository(), { async publish() {} }).execute({ productId: id, actor, changes: { stock: 0 }, expectedVersion: 1 });
  const eventId = `inventory.stock.alert:${id}:2`, store = new DynamoInventoryAlertOutbox(rawDb, table);
  const now = Date.now() + 10000, iso = new Date(now).toISOString();
  const candidate = await dueEvent(store, eventId, now);
  const row = await read(`INVENTORY_ALERT_OUTBOX#${eventId}`);
  row.event.stock = -1;
  await rawDb.send(new PutItemCommand({ TableName: table, Item: marshall(row) }));
  await assert.rejects(store.claim(candidate, "invalid-owner", iso, new Date(now + 120000).toISOString()), /quarantined/);
  const quarantined = await read(row.PK);
  assert.equal(quarantined.status, "FAILED"); assert.equal(quarantined.leaseOwner, undefined);
  // Repair only the deliberately corrupted test payload, as an operator would after review.
  quarantined.event.stock = 0;
  await rawDb.send(new PutItemCommand({ TableName: table, Item: marshall(quarantined) }));
  assert.equal(await store.requeueFailed(eventId, iso), true);
  assert.equal(await store.requeueFailed(eventId, iso), false);
  const recovered = await store.claim({ eventId, attempts: 0 }, "recovery-owner", iso, new Date(now + 120000).toISOString());
  assert.equal(recovered.event.eventId, eventId); assert.equal(recovered.attempts, 1);
  assert.equal(await store.requeueFailed(eventId, iso), false);
  assert.equal(await store.published(recovered, iso), true);
});

test("engine: notification/receipt are atomic under concurrent delivery and receipt survives notification deletion", async () => {
  const store = new DynamoInventoryNotifications(), eventId = `inventory.stock.alert:${randomUUID()}:2`;
  const input = { eventId, email, title: "Low stock", message: "Stock=5", metadata: { eventId, audience: "admin" } };
  const claims = await Promise.all(Array.from({ length: 5 }, () => store.createOnce({ eventId: input.eventId, notification: Notification.create({ ...input, id: store.notificationId(input.eventId, input.email), channel: "system" }, Date.now()) })));
  assert.equal(claims.filter(item => item.created).length, 1);
  const winner = claims.find(item => item.created);
  assert.ok(await read(`NOTIFICATION#${winner.notificationId}`));
  await store.finish({ ...winner, eventId, email, effects: { notification: "SUCCEEDED", audit: "SUCCEEDED", sns: "UNKNOWN" } });
  await rawDb.send(new DeleteItemCommand({ TableName: table, Key: marshall({ PK: `NOTIFICATION#${winner.notificationId}`, SK: "DETAIL" }) }));
  assert.equal((await store.createOnce(input)).created, false);
  assert.equal(await read(`NOTIFICATION#${winner.notificationId}`), null);
});

test("engine: publish-success/marker-failure repeats the same event without duplicate notification or external calls", async () => {
  const id = await seedProduct();
  await new UpdateProduct(new DynamoProductWriteRepository(), { async publish() {} }).execute({ productId: id, actor, changes: { stock: 5 }, expectedVersion: 1 });
  const eventId = `inventory.stock.alert:${id}:2`, store = new DynamoInventoryAlertOutbox(rawDb, table);
  let clock = Date.now() + 10000, sends = 0, external = 0, failMarker = true;
  const findDue = store.due.bind(store), mark = store.published.bind(store);
  await dueEvent(store, eventId, clock);
  store.due = async (now, limit) => (await findDue(now, limit)).filter(item => item.eventId === eventId);
  store.published = async (...args) => { if (failMarker) { failMarker = false; throw new Error("marker lost"); } return mark(...args); };
  const effects = { newId: randomUUID, inventory: new DynamoInventoryNotifications(), store: {},
    async publish() { external++; return { eventId: "bus-event", eventBusName: "bus" }; },
    async adminAlert() { external++; return { messageId: "sns", topicArn: "topic" }; } };
  const consumer = new NotificationUseCases(null, null, effects, { adminEmail: email, platformEventsEnabled: true, adminAlertsEnabled: true }, { log() {}, warn() {}, error() {} });
  const relay = new RelayInventoryAlerts(store, { async publish(event) { sends++; await consumer.processEvent({ ...event, type: "inventory.stock.alert" }); } }, randomUUID, () => clock);
  assert.equal((await relay.execute()).retry, 1);
  clock += 120000;
  await dueEvent(store, eventId, clock);
  assert.equal((await relay.execute()).published, 1);
  assert.equal(sends, 2); assert.equal(external, 3);
  assert.equal((await read(`INVENTORY_ALERT_OUTBOX#${eventId}`)).status, "PUBLISHED");
});

test("engine HTTP: the composition flag writes an outbox event and retains the legacy response shape", async () => {
  const { createNestApp } = await import("../dist/src/core/app/create-app.js");
  const { databaseConfig } = await import("../dist/src/config/database-config.js");
  const { identityConfig: env } = await import("../dist/src/config/identity-config.js");
  const previous = { flag: databaseConfig.INVENTORY_ALERT_OUTBOX_ENABLED, auth: env.AUTH_ALLOW_UNVERIFIED_JWT };
  databaseConfig.INVENTORY_ALERT_OUTBOX_ENABLED = true; env.AUTH_ALLOW_UNVERIFIED_JWT = true;
  const app = await createNestApp();
  try {
    const id = await seedProduct();
    const token = Buffer.from(JSON.stringify({ sub: actor.subject, email, role: "admin" })).toString("base64url");
    const response = await app.getHttpAdapter().getInstance().inject({ method: "PATCH", url: `/api/shopping-items/${id}`,
      headers: { authorization: `Bearer header.${token}.signature` }, payload: { stock: 5, version: 1 } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().stock, 5); assert.equal(response.json().version, 2);
    assert.equal((await read(`INVENTORY_ALERT_OUTBOX#inventory.stock.alert:${id}:2`)).event.stock, 5);
  } finally { await app.close(); databaseConfig.INVENTORY_ALERT_OUTBOX_ENABLED = previous.flag; env.AUTH_ALLOW_UNVERIFIED_JWT = previous.auth; }
});

test("engine: legacy completion commits status/audit together and never creates audit for a rejected transition", async () => {
  const id = randomUUID(), adapter = new DynamoNotifiedOrders();
  await put({ PK: `ORDER#${id}`, SK: "DETAIL", id, entityType: "ORDER", customerEmail: email, status: "pending" });
  await put({ PK: `NOTIFICATION#${id}`, SK: "DETAIL", entityType: "NOTIFICATION", customerEmail: email,
    channel: "system", status: "sent", metadata: { orderId: id } });
  const flow = new CompleteNotifiedOrder(adapter);
  assert.equal((await flow.execute(id)).completed, true);
  assert.equal((await flow.execute(id)).changed, false);
  assert.equal((await read(`ORDER#${id}`)).status, "done");
  const audit = await rawDb.send(new QueryCommand({ TableName: table, ConsistentRead: true,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: marshall({ ":pk": `ORDER#${id}`, ":prefix": "DETAIL#STATUS_CHANGE#" }) }));
  assert.equal(audit.Items.length, 1);
  const rejected = randomUUID(); await put({ PK: `ORDER#${rejected}`, SK: "DETAIL", status: "cancelled" });
  await assert.rejects(adapter.completePending(new Order({ id: rejected, customerEmail: email, totalAmount: 0, status: "done" })), { name: "TransactionCanceledException" });
  assert.equal(await read(`ORDER#${rejected}`, "DETAIL#STATUS_CHANGE#done"), null);
});

test("engine: recovery checkpoint progresses across a filtered-empty GSI page and rejects stale attempt claims", async () => {
  const recovery = new DynamoPaymentRecovery();
  // Lexically old timestamps isolate these records before all current orders/payments.
  for (const [index, status] of ["failed", "pending"].entries()) await put({ PK: `PAYMENT#engine-${index}`, SK: "DETAIL",
    txnRef: `engine-${index}`, entityType: "PAYMENT_SESSION", status, updatedAt: `2000-01-0${index + 1}T00:00:00.000Z` });
  let found = false;
  for (let pageNumber = 0; pageNumber < 6; pageNumber++) {
    const page = await recovery.page("pending", 1);
    if (pageNumber === 0) assert.deepEqual(page.ids, []);
    if (page.ids.includes("engine-1")) found = true;
    await recovery.checkpoint("pending", page.checkpoint);
    if (found) break;
  }
  assert.equal(found, true);
  await recovery.defer("engine-1", 1, "2030-01-01T00:00:00.000Z");
  await assert.rejects(recovery.defer("engine-1", 1, "2030-01-01T00:00:00.000Z"), { name: "ConditionalCheckFailedException" });
  assert.equal((await read("PAYMENT#engine-1")).recoveryAttempts, 1);
});

async function holdCheckout(orders, input) {
  let order = await orders.findById(input.orderId);
  if (order) order.assertCheckoutReplay(input.email, input.items, order.items, new Date().toISOString());
  else order = await orders.create(Order.create({ id: input.orderId, customerEmail: input.email, items: input.items,
    products: await orders.loadPrices(input.items), holdSeconds: input.holdSeconds, now: Date.now() }));
  return { order: order, items: order.items };
}
