import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { marshall } from "@aws-sdk/util-dynamodb";
import { GetProduct, ListProducts } from "../src/modules/storefront/application/read-catalog/read-catalog.js";
import type { CatalogReader, CatalogProduct } from "../src/modules/storefront/application/ports/catalog-reader.js";
import { GetOrderDetails, ListMyOrders } from "../src/modules/storefront/application/read-orders/read-orders.js";
import type { OrderReader, OrderView } from "../src/modules/storefront/application/ports/order-reader.js";
import { CompleteNotifiedOrder } from "../src/modules/notifications/application/complete-notified-order.js";
import { DynamoCatalogReader, catalogProjection } from "../src/modules/storefront/infrastructure/persistence/dynamo-catalog-reader.js";
import { DynamoOrderReader } from "../src/modules/storefront/infrastructure/persistence/dynamo-order-reader.js";
import { DynamoNotifiedOrders } from "../src/modules/notifications/infrastructure/dynamo-notified-orders.js";
import { rawDb } from "../src/database/dynamodb/client.js";
import { transport } from "./helpers/payment-transport.js";

const email = "owner@example.test", id = "12345678-1234-4234-8234-123456789013";
const now = Date.parse("2026-10-21T00:00:00.000Z");
const product: CatalogProduct = { id, name: "Product", stock: 12, status: "active", price: 100, originalPrice: 100, color: "red" };
function catalog(overrides: Partial<CatalogReader> = {}): CatalogReader {
  return { async findById() { return product; }, async activeCampaigns() { return []; },
    async list() { return { items: [product], limit: 12, hasNextPage: false }; }, ...overrides };
}
const order: OrderView = { id: "order-1", customerEmail: email, status: "paid", totalAmount: 100,
  createdAt: "created", updatedAt: "updated", items: [] };
function orders(overrides: Partial<OrderReader> = {}): OrderReader {
  return { async findLegacy() { return null; }, async findCheckout() { return order; },
    async listItems() { return []; }, async listByCustomer() { return [order]; }, ...overrides };
}

test("catalog projection and public detail exclude internal metadata, including future columns", async () => {
  const projected = catalogProjection({ ...product, status: "active", PK: "internal", ownerSub: "private-owner", version: 9,
    inventoryAlertSent: true, auditActorId: "private-actor", futureSecret: "secret" });
  assert.equal("ownerSub" in projected, false);
  assert.equal("futureSecret" in projected, false);
  const response = await new GetProduct(catalog({ async findById() { return projected; } })).execute(id);
  assert.deepEqual(response.attributes, { color: "red" });
  assert.equal(JSON.stringify(response).includes("private"), false);
});

test("catalog keeps manual price when cheaper than campaign and shares stock thresholds", async () => {
  const reader = catalog({ async activeCampaigns() { return [{ id: "sale", discountPercent: 20, productIds: [id], endAt: "end" }]; },
    async findById() { return { ...product, stock: 10, price: 70 }; } });
  const detail = await new GetProduct(reader).execute(id);
  assert.equal(detail.price, 70); assert.equal(detail.saleDiscountPercent, 30); assert.equal(detail.status, "low_stock");
});

test("missing, sold-out and invalid-stock products are hidden before campaign lookup", async () => {
  let calls = 0;
  for (const item of [null, { ...product, stock: 0 }, { ...product, stock: Number.NaN }]) {
    await assert.rejects(new GetProduct(catalog({ async findById() { return item; },
      async activeCampaigns() { calls++; return []; } })).execute(id), { code: "NOT_FOUND" });
  }
  assert.equal(calls, 0);
});

test("sold-out page retains next cursor rather than falsely ending pagination", async () => {
  const result = await new ListProducts(catalog({ async list() {
    return { items: [{ ...product, stock: 0 }], limit: 12, cursor: "current", nextCursor: "next", hasNextPage: true };
  } })).execute({ limit: 12, searchField: "name" });
  assert.deepEqual(result.items, []); assert.equal(result.pageInfo.nextCursor, "next"); assert.equal(result.pageInfo.hasNextPage, true);
});

test("catalog propagates storage failures instead of converting them to missing data", async () => {
  await assert.rejects(new GetProduct(catalog({ async findById() { throw new Error("database unavailable"); } })).execute(id), /unavailable/);
});

test("order detail hides foreign/missing orders and never loads their items", async () => {
  let items = 0;
  for (const legacy of [null, order]) {
    const useCase = new GetOrderDetails(orders({ async findLegacy() { return legacy; }, async listItems() { items++; return []; } }));
    await assert.rejects(useCase.execute("other", "order-1"), { code: "NOT_FOUND" });
  }
  await assert.rejects(new GetOrderDetails(orders({ async findCheckout() { return null; } })).execute(email, "missing"), { code: "NOT_FOUND" });
  assert.equal(items, 0);
});

test("invalid order ids fail before persistence; legacy and checkout retain response semantics", async () => {
  let calls = 0;
  const useCase = new GetOrderDetails(orders({ async findLegacy() { calls++; return null; } }), () => now);
  for (const invalid of ["  ", "a".repeat(129)]) await assert.rejects(useCase.execute(email, invalid), { code: "NOT_FOUND" });
  assert.equal(calls, 0);
  assert.equal((await useCase.execute(email, " order-1 ")).serverNow, new Date(now).toISOString());
  const legacy = new GetOrderDetails(orders({ async findLegacy() { return order; }, async findCheckout() { throw new Error("must not load"); } }));
  assert.equal((await legacy.execute(email, "order-1")).id, "order-1");
});

test("customer list applies ownership defense even with a faulty reader", async () => {
  const result = await new ListMyOrders(orders({ async listByCustomer() { return [order, { ...order, customerEmail: "foreign" }]; } })).execute(email);
  assert.deepEqual(result, [order]);
});

test("Dynamo read adapters map legacy/checkout item prices without leaking persistence metadata", async () => {
  const db = transport(rawDb);
  try {
    db.put({ PK: "ORDER#order-1", SK: "ORDER", ...order, entityType: "ORDER", auditActorId: "private" });
    db.put({ PK: "ORDER#order-1", SK: "ORDER_ITEM#product", entityType: "ORDER_ITEM", productId: id,
      productName: "Product", unitPrice: 80, originalUnitPrice: 100, quantity: 2, lineTotal: 160 });
    const result = await new GetOrderDetails(new DynamoOrderReader()).execute(email, "order-1");
    assert.equal(result.items[0].price, 80); assert.equal("PK" in result, false); assert.equal("auditActorId" in result, false);
    db.put({ PK: "ORDER#legacy", SK: "DETAIL", ...order, id: "legacy", items: [{ productId: id, productName: "Old", price: 50, quantity: 1, lineTotal: 50 }] });
    assert.equal((await new GetOrderDetails(new DynamoOrderReader()).execute(email, "legacy")).items[0].price, 50);
    assert.equal((await new DynamoCatalogReader().findById(id))?.id, id);
  } finally { db.close(); }
});

test("completion policy requires pending legacy order and sent system notification", async () => {
  let status: string | null = null, sent = false, writes = 0;
  const flow = new CompleteNotifiedOrder({ async findById() { return status ? { customerEmail: email, status } : null; },
    async hasSentSystemNotification() { return sent; }, async completePending() { writes++; status = "done"; return true; } });
  assert.equal((await flow.execute("order-1")).completed, false);
  status = "paid"; assert.equal((await flow.execute("order-1")).completed, false);
  status = "pending"; assert.equal((await flow.execute("order-1")).completed, false);
  sent = true; assert.deepEqual(await flow.execute("order-1"), { changed: true, completed: true });
  assert.deepEqual(await flow.execute("order-1"), { changed: false, completed: true }); assert.equal(writes, 1);
});

test("completion finds sent notification after an empty scan page", async () => {
  let pages = 0;
  rawDb.middlewareStack.add(() => async args => {
    const input = args.input as any; pages++;
    assert.equal(input.ConsistentRead, true);
    if (pages === 1) return { response: {}, output: { $metadata: {}, Items: [], LastEvaluatedKey: marshall({ PK: "cursor", SK: "DETAIL" }) } };
    assert.ok(input.ExclusiveStartKey);
    return { response: {}, output: { $metadata: {}, Items: [marshall({ entityType: "NOTIFICATION", customerEmail: email,
      channel: "system", status: "sent", metadata: { orderId: "order-1" } })] } };
  }, { step: "initialize", name: "completionScan", priority: "high" });
  try { assert.equal(await new DynamoNotifiedOrders().hasSentSystemNotification("order-1", email), true); assert.equal(pages, 2); }
  finally { rawDb.middlewareStack.remove("completionScan"); }
});

test("competing completions write one atomic status audit and preserve done on replay", async () => {
  const db = transport(rawDb), adapter = new DynamoNotifiedOrders();
  try {
    db.put({ PK: "ORDER#order-1", SK: "DETAIL", ...order, status: "pending" });
    const results = await Promise.all([adapter.completePending("order-1"), adapter.completePending("order-1")]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(db.get("ORDER#order-1", "DETAIL")?.status, "done");
    assert.equal(db.rows().filter(row => row.entityType === "ORDER_STATUS_AUDIT").length, 1);
    assert.equal(db.writes[0].TransactItems?.length, 2);
  } finally { db.close(); }
});

test("completion acknowledges lost commit response but propagates failed transaction without orphan audit", async () => {
  const db = transport(rawDb), adapter = new DynamoNotifiedOrders();
  try {
    db.put({ PK: "ORDER#lost", SK: "DETAIL", ...order, status: "pending" });
    db.loseNextTransactionResponse(); assert.equal(await adapter.completePending("lost"), false);
    assert.equal(db.get("ORDER#lost", "DETAIL")?.status, "done");
    db.put({ PK: "ORDER#changed", SK: "DETAIL", ...order, status: "pending" });
    db.race(() => db.put({ PK: "ORDER#changed", SK: "DETAIL", ...order, status: "cancelled" }));
    await assert.rejects(adapter.completePending("changed"));
    assert.equal(db.get("ORDER#changed", "DETAIL#STATUS_CHANGE#done"), undefined);
  } finally { db.close(); }
});

test("compiled HTTP reads wire real adapters, hide private fields, enforce ownership and map errors", async () => {
  const { NestFactory } = await import("@nestjs/core");
  const { FastifyAdapter } = await import("@nestjs/platform-fastify");
  const { StorefrontModule } = await import("../dist/src/modules/storefront/storefront.module.js");
  const { AppExceptionFilter } = await import("../dist/src/common/filters/app-exception.filter.js");
  const { rawDb: compiledDb } = await import("../dist/src/database/dynamodb/client.js");
  const { identityConfig: env } = await import("../dist/src/config/identity-config.js");
  const { NotificationsService } = await import("../dist/src/modules/notifications/notifications.service.js");
  const previous = env.AUTH_ALLOW_UNVERIFIED_JWT, db = transport(compiledDb);
  env.AUTH_ALLOW_UNVERIFIED_JWT = true;
  const app = await NestFactory.create(StorefrontModule, new FastifyAdapter(), { logger: false });
  app.useGlobalFilters(new AppExceptionFilter());
  const token = (owner: string) => `Bearer header.${Buffer.from(JSON.stringify({ sub: "u1", email: owner, role: "customer" })).toString("base64url")}.signature`;
  try {
    db.put({ PK: `PRODUCT#${id}`, SK: "DETAIL", ...product, ownerSub: "private", auditActorId: "secret" });
    db.put({ PK: "ORDER#order-1", SK: "ORDER", ...order, entityType: "ORDER" });
    await app.init(); const http = app.getHttpAdapter().getInstance(); await http.ready();
    for (const path of [`/api/products/${id}`, `/api/storefront/products/${id}`]) {
      const response = await http.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json().attributes, { color: "red" });
      assert.equal(response.body.includes("secret"), false); assert.equal(response.body.includes("private"), false);
    }
    const path = "/api/storefront/orders/order-1/details";
    assert.equal((await http.inject({ method: "GET", url: path })).statusCode, 403);
    assert.equal((await http.inject({ method: "GET", url: path, headers: { authorization: token("other") } })).statusCode, 404);
    const owned = await http.inject({ method: "GET", url: path, headers: { authorization: token(email) } });
    assert.equal(owned.statusCode, 200, owned.body); assert.equal(owned.json().id, "order-1");
    db.put({ PK: `PRODUCT#${id}`, SK: "DETAIL", ...product, stock: 0 });
    assert.equal((await http.inject({ method: "GET", url: `/api/products/${id}` })).statusCode, 404);

    // Exercise the real notification queue branch, including its module wiring and replay.
    db.put({ PK: "ORDER#legacy", SK: "DETAIL", ...order, id: "legacy", status: "pending" });
    db.put({ PK: "NOTIFICATION#notice", SK: "DETAIL", entityType: "NOTIFICATION", customerEmail: email,
      channel: "system", status: "pending", metadata: { orderId: "legacy" } });
    compiledDb.middlewareStack.add((next, context) => async args => {
      if (context.commandName !== "ScanCommand") return next(args);
      return { response: {}, output: { $metadata: {}, Items: db.rows().filter(row => row.entityType === "NOTIFICATION")
        .map(row => marshall(row, { removeUndefinedValues: true })) } };
    }, { step: "initialize", priority: "high", name: "workerNotificationScan" });
    const worker = app.get(NotificationsService);
    const record = { messageId: "notice", body: JSON.stringify({ type: "notification.pending", notificationId: "notice", metadata: { orderId: "legacy" } }) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await worker.processQueueRecords([record]);
      assert.deepEqual(result.failedMessageIds, []);
      assert.equal(result.items[0]?.orderCompleted, true);
    }
    assert.equal(db.get("ORDER#legacy", "DETAIL")?.status, "done");
    assert.equal(db.rows().filter(row => row.entityType === "ORDER_STATUS_AUDIT").length, 1);
    compiledDb.middlewareStack.remove("workerNotificationScan");
  } finally {
    compiledDb.middlewareStack.remove("workerNotificationScan");
    await app.close(); db.close(); env.AUTH_ALLOW_UNVERIFIED_JWT = previous;
  }
});
