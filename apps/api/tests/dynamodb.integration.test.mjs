import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CreateTableCommand, DeleteTableCommand, GetItemCommand, ListTablesCommand, PutItemCommand, QueryCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
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
const { Product } = await import("../dist/src/modules/shopping/domain/product.js");
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
  await assert.rejects(profiles.update(subject, { displayName: "User" }), { code: "INVALID_INPUT" });
  assert.equal(await read(`USER#${subject}`, "PROFILE"), null);
  await put({ PK: `USER#${subject}`, SK: "PROFILE", entityType: "OTHER", displayName: "Original" });
  await assert.rejects(profiles.update(subject, { displayName: "Wrong" }), { code: "INVALID_INPUT" });
  assert.equal((await read(`USER#${subject}`, "PROFILE")).displayName, "Original");
  await put({ PK: `USER#${subject}`, SK: "PROFILE", entityType: "USER_PROFILE", displayName: "Original", avatarKey: "" });
  await profiles.update(subject, { displayName: "Updated" });
  assert.equal((await profiles.find(subject)).displayName, "Updated");
});

test("engine: optimistic product writes allow one version winner and enforce owner at the write boundary", async () => {
  const id = await seedProduct(), repository = new DynamoProductWriteRepository();
  const flow = new UpdateProduct(repository, { async publish() {} });
  const results = await Promise.allSettled(["Winner A", "Winner B"].map(name => flow.execute({ productId: id,
    changes: { name }, expectedVersion: 1, actor })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await read(`PRODUCT#${id}`)).version, 2);
  await assert.rejects(repository.update({ id, changes: { name: "Wrong owner" }, expectedVersion: 2,
    expectedOwnerId: "foreign", status: "active" }), { code: "CONFLICT" });
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
  const results = await Promise.allSettled(ids.map(orderId => orders.hold(input(orderId))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = ids[results.findIndex(result => result.status === "fulfilled")];
  assert.equal((await read(`PRODUCT#${id}`)).stock, 1);
  await orders.hold(input(winner)); assert.equal((await read(`PRODUCT#${id}`)).stock, 1);
  const details = await new GetOrderDetails(new DynamoOrderReader()).execute(email, winner);
  assert.equal(details.items[0].price, 1000); assert.equal(details.totalAmount, 3000);
  await assert.rejects(new GetOrderDetails(new DynamoOrderReader()).execute("foreign", winner), { code: "NOT_FOUND" });
  assert.equal((await orders.transition({ orderId: winner, expectedCustomerEmail: email, status: "cancelled" })).changed, true);
  assert.equal((await orders.transition({ orderId: winner, expectedCustomerEmail: email, status: "cancelled" })).changed, false);
  assert.equal((await read(`PRODUCT#${id}`)).stock, 4);
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
  await assert.rejects(adapter.completePending(rejected), { name: "TransactionCanceledException" });
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
