import "reflect-metadata";
import { databaseConfig } from "../src/config/database-config.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DynamoDBClient, TransactWriteItemsCommandInput, UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { IncrementProductField } from "../src/modules/shopping/application/increment-product-field/increment-product-field.js";
import { CreateProduct } from "../src/modules/shopping/application/create-product/create-product.js";
import { DeleteProduct } from "../src/modules/shopping/application/delete-product/delete-product.js";
import { ProductMutationError } from "../src/modules/shopping/application/product-mutation.error.js";
import type { ProductCounterRepository } from "../src/modules/shopping/application/ports/product-counter-repository.js";
import type { ProductCreator } from "../src/modules/shopping/application/ports/product-creator.js";
import type { ProductDeleter } from "../src/modules/shopping/application/ports/product-deleter.js";
import type { InventoryStockAlert } from "../src/modules/shopping/application/ports/inventory-alert-publisher.js";
import { Product, type NewProductDetails, type ProductSnapshot } from "../src/modules/shopping/domain/product.js";
import { incrementCounter } from "../src/modules/shopping/domain/counter-policy.js";
import { DynamoProductCounterRepository } from "../src/modules/shopping/infrastructure/persistence/dynamo-product-counter-repository.js";
import { DynamoProductCreator } from "../src/modules/shopping/infrastructure/persistence/dynamo-product-creator.js";
import { DynamoProductDeleter } from "../src/modules/shopping/infrastructure/persistence/dynamo-product-deleter.js";
import { rawDb } from "../src/database/dynamodb/client.js";
import { auditContext } from "../src/modules/audit-log/audit-context.js";

const id = "10000000-0000-4000-8000-000000000001";
const owner = { subject: "owner", isAdmin: false };
const admin = { subject: "admin", isAdmin: true };
const snapshot: ProductSnapshot = { id, ownerId: "owner", name: "Product", sku: "SKU-1",
  stock: 20, soldCount: 3, status: "active", version: 1 };
const details: NewProductDetails = { name: "Product", category: "Gia dung", brand: "Brand", sku: "SKU-1",
  stock: 20, price: 2000, imageUrl: "https://example.test/p.png", location: "HCM", description: "Product description" };
const hasCode = (code: string) => (error: unknown) => error instanceof ProductMutationError && error.code === code;

function incrementFixture(current: ProductSnapshot | null = snapshot) {
  const writes: Array<Parameters<ProductCounterRepository<string>["increment"]>[0]> = [];
  const alerts: InventoryStockAlert[] = [];
  const repository: ProductCounterRepository<string> = {
    async findById() { return current ? new Product(current) : null; },
    async increment(input) {
      writes.push(input);
      return { product: new Product({ ...snapshot, [input.field]: input.nextValue, status: input.status, version: 2 }), representation: "saved" };
    }
  };
  const publisher = { async publish(alert: InventoryStockAlert) { alerts.push(alert); } };
  return { repository, publisher, writes, alerts, useCase: new IncrementProductField(repository, publisher, "direct") };
}

test("counter policy preserves clamp and checks safe integer overflow without a new 999999 cap", () => {
  assert.equal(incrementCounter(3, -5), 0);
  assert.equal(incrementCounter(3, 0), 3);
  assert.equal(incrementCounter(999999, 1), 1000000);
  for (const [value, delta] of [[1.5, 1], [1, NaN], [Number.MAX_SAFE_INTEGER, 1], [-1, 1]]) {
    assert.throws(() => incrementCounter(value, delta), RangeError);
  }
});

test("increment handles stock and soldCount, snapshot version, owner/admin and alert transitions", async () => {
  const f = incrementFixture();
  assert.equal(await f.useCase.execute({ productId: id, field: "stock", incrementBy: -15, actor: owner }), "saved");
  assert.equal(f.writes[0].nextValue, 5);
  assert.equal(f.writes[0].expectedVersion, 1);
  assert.equal(f.writes[0].expectedOwnerId, "owner");
  assert.equal(f.alerts[0].source, "admin.increment");
  assert.equal(f.alerts[0].status, "low_stock");
  const g = incrementFixture();
  await g.useCase.execute({ productId: id, field: "soldCount", incrementBy: -10, actor: admin });
  assert.equal(g.writes[0].nextValue, 0);
  assert.equal(g.writes[0].expectedOwnerId, undefined);
  assert.equal(g.alerts.length, 0);
  const h = incrementFixture({ ...snapshot, stock: 4, status: "low_stock" });
  await h.useCase.execute({ productId: id, field: "stock", incrementBy: -1, actor: owner });
  assert.equal(h.alerts.length, 0);
});

test("increment rejects missing/forbidden/invalid requests before writing", async () => {
  const missing = incrementFixture(null);
  await assert.rejects(missing.useCase.execute({ productId: id, field: "stock", incrementBy: 1, actor: owner }), hasCode("NOT_FOUND"));
  const forbidden = incrementFixture();
  await assert.rejects(forbidden.useCase.execute({ productId: id, field: "stock", incrementBy: 1,
    actor: { subject: "other", isAdmin: false } }), hasCode("FORBIDDEN"));
  const f = incrementFixture();
  for (const incrementBy of [1.5, NaN, Infinity, 100000, -100000]) {
    await assert.rejects(f.useCase.execute({ productId: id, field: "stock", incrementBy, actor: owner }), hasCode("INVALID_INPUT"));
  }
  await assert.rejects(f.useCase.execute({ productId: id, field: "price" as "stock", incrementBy: 1, actor: owner }), hasCode("INVALID_INPUT"));
  const overflow = incrementFixture({ ...snapshot, soldCount: Number.MAX_SAFE_INTEGER });
  await assert.rejects(overflow.useCase.execute({ productId: id, field: "soldCount", incrementBy: 1, actor: owner }), hasCode("INVALID_INPUT"));
  assert.equal(f.writes.length + missing.writes.length + forbidden.writes.length + overflow.writes.length, 0);
});

test("invalid stored state is asserted before counter updates or deletion", async () => {
  const bad = { ...snapshot, soldCount: -1 };
  const increment = incrementFixture(bad);
  await assert.rejects(increment.useCase.execute({ productId: id, field: "stock", incrementBy: 1, actor: owner }), hasCode("INVALID_INPUT"));
  assert.equal(increment.writes.length, 0); assert.equal(increment.alerts.length, 0);
  let deletes = 0;
  const remove = new DeleteProduct({ async findById() { return new Product(bad); }, async delete() { deletes++; } });
  await assert.rejects(remove.execute({ productId: id, actor: owner }), hasCode("INVALID_INPUT"));
  assert.equal(deletes, 0);
});

test("increment never retries commit/publish and never alerts after a failed write", async () => {
  const f = incrementFixture();
  const failure = new Error("timeout with unknown result");
  let attempts = 0;
  f.repository.increment = async () => { attempts++; throw failure; };
  await assert.rejects(f.useCase.execute({ productId: id, field: "stock", incrementBy: -15, actor: owner }), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(f.alerts.length, 0);
  const g = incrementFixture();
  let publishes = 0;
  g.publisher.publish = async () => { publishes++; throw failure; };
  await assert.rejects(g.useCase.execute({ productId: id, field: "stock", incrementBy: -15, actor: owner }), error => error === failure);
  assert.equal(g.writes.length, 1);
  assert.equal(publishes, 1);
});

test("create uses trusted actor, deterministic ID/time, defaults/status and propagates failure", async () => {
  const writes: Array<Parameters<ProductCreator<string>["create"]>[0]> = [];
  const repository: ProductCreator<string> = { async create(input) { writes.push(input); return "created"; } };
  const useCase = new CreateProduct(repository, () => id, () => new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(await useCase.execute({ details: { ...details, stock: 0 }, actor: owner }), "created");
  assert.equal(writes[0].product.ownerId, "owner");
  assert.equal(writes[0].product.id, id);
  assert.equal(writes[0].createdAt, writes[0].updatedAt);
  assert.equal(writes[0].product.status, "out_of_stock");
  assert.equal(writes[0].product.toSnapshot().rating, 4.8);
  assert.equal(writes[0].product.soldCount, 0);
  assert.equal(writes[0].product.toSnapshot().featured, false);
  await assert.rejects(useCase.execute({ details: { ...details, stock: -1 }, actor: owner }), hasCode("INVALID_INPUT"));
  await assert.rejects(useCase.execute({ details, actor: { subject: "", isAdmin: true } }), hasCode("INVALID_INPUT"));
  const failure = new Error("create unavailable");
  repository.create = async () => { throw failure; };
  await assert.rejects(useCase.execute({ details, actor: owner }), error => error === failure);
});

test("delete verifies access and carries the authorized snapshot into the conditional delete", async () => {
  let current: ProductSnapshot | null = snapshot;
  const writes: Array<Parameters<ProductDeleter["delete"]>[0]> = [];
  const repository: ProductDeleter = { async findById() { return current ? new Product(current) : null; }, async delete(input) { writes.push(input); } };
  const useCase = new DeleteProduct(repository);
  await useCase.execute({ productId: id, actor: owner });
  assert.deepEqual(writes[0], { id, expectedVersion: 1, expectedOwnerId: "owner" });
  await useCase.execute({ productId: id, actor: admin });
  assert.equal(writes[1].expectedOwnerId, undefined);
  await assert.rejects(useCase.execute({ productId: id, actor: { subject: "other", isAdmin: false } }), hasCode("FORBIDDEN"));
  current = null;
  await assert.rejects(useCase.execute({ productId: id, actor: owner }), hasCode("NOT_FOUND"));
  assert.equal(writes.length, 2);
});

function productRecord(): Record<string, unknown> {
  return { ...details, PK: `PRODUCT#${id}`, SK: "DETAIL", id, entityType: "PRODUCT", ownerSub: "owner",
    stock: 20, soldCount: 3, status: "active", version: 1, originalPrice: 3000,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    inventoryAlertSent: true, inventoryAlertSentAt: "previous-alert", customMetadata: "keep" };
}

function cancellation(position: number, code = "ConditionalCheckFailed") {
  return Object.assign(new Error(code), { name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length: 3 }, (_, index) => ({ Code: index === position ? code : "None" })) });
}

/** SDK transport model, not a real DynamoDB engine. Actual audit middleware runs first. */
function transport(client: DynamoDBClient, table: string) {
  let current: Record<string, unknown> | null = productRecord();
  let fail: { command: string; error: unknown } | undefined;
  let race: (() => void) | undefined;
  const transactions: TransactWriteItemsCommandInput[] = [];
  const markers: UpdateItemCommandInput[] = [];
  const audits: Array<Record<string, unknown>> = [];
  function assertCondition(input: { ConditionExpression?: string; ExpressionAttributeValues?: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue> }, position?: number) {
    const values = unmarshall(input.ExpressionAttributeValues!);
    const expected = values[":expectedVersion"] ?? values[":deleteVersion"];
    if (!current || current.version !== expected || (values[":expectedOwnerSub"] !== undefined && current.ownerSub !== values[":expectedOwnerSub"])) {
      if (position !== undefined) throw cancellation(position);
      throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
    }
  }
  client.middlewareStack.add((_next, context) => async args => {
    if (context.commandName === "GetItemCommand") {
      assert.equal((args.input as { ConsistentRead?: boolean }).ConsistentRead, true);
      return { response: {}, output: { $metadata: {}, Item: current ? marshall(current) : undefined } };
    }
    if (race) { const effect = race; race = undefined; effect(); }
    const input = args.input as TransactWriteItemsCommandInput & UpdateItemCommandInput;
    if (context.commandName === "UpdateItemCommand") markers.push(input);
    else transactions.push(input);
    if (fail?.command === context.commandName) { const error = fail.error; fail = undefined; throw error; }
    if (context.commandName === "UpdateItemCommand") {
      assert.equal(input.TableName, table);
      assertCondition(input);
      assert.equal(unmarshall(input.ExpressionAttributeValues!)[":auditDeleteOutbox"], true);
      current = { ...current, auditDeleteOutbox: true };
    } else {
      assert.equal(context.commandName, "TransactWriteItemsCommand");
      const items = input.TransactItems!;
      if (items.length === 2) {
        assert.ok(items[0].Put && items[1].Put);
        assert.match(items[0].Put!.ConditionExpression!, /attribute_not_exists/);
        assert.match(items[1].Put!.ConditionExpression!, /attribute_not_exists/);
        if (current) throw cancellation(0);
        current = unmarshall(items[0].Put!.Item!);
        const index = unmarshall(items[1].Put!.Item!);
        assert.equal((index.product as Record<string, unknown>).id, current.id);
      } else if (items[0].Update) {
        const update = items[0].Update;
        assertCondition(update, 0);
        const values = unmarshall(update.ExpressionAttributeValues!);
        const field = update.ExpressionAttributeNames!["#field"];
        const next = { ...current, [field]: values[":fieldValue"], status: values[":status"],
          updatedAt: values[":updatedAt"], searchName: values[":searchName"], version: Number(current!.version) + 1 };
        if (field === "stock") { next.inventoryAlertSent = false; delete next.inventoryAlertSentAt; }
        const index = unmarshall(items[2].Put!.Item!);
        const indexed = index.product as Record<string, unknown>;
        assert.equal(indexed[field], next[field]);
        assert.equal(indexed.inventoryAlertSentAt, next.inventoryAlertSentAt);
        assert.equal(indexed.inventoryAlertSent, next.inventoryAlertSent);
        current = next;
      } else {
        assert.ok(items[0].Put && items[1].Delete && items[2].Delete);
        assertCondition(items[1].Delete!, 1);
        const event = unmarshall(items[0].Put!.Item!);
        assert.equal(event.entityType, "AUDIT_EVENT");
        audits.push(JSON.parse(String(event.auditRecord)));
        current = null;
      }
    }
    return { response: {}, output: { $metadata: {} } };
  }, { step: "initialize", priority: "low", name: "productMutationsTestTransport" });
  return { transactions, markers, audits, current: () => current,
    setCurrent(value: Record<string, unknown> | null) { current = value; },
    failNext(command: string, error: unknown) { fail = { command, error }; },
    beforeWrite(effect: () => void) { race = effect; },
    close() { client.middlewareStack.remove("productMutationsTestTransport"); } };
}

const incrementInput = { id, field: "stock" as const, incrementBy: -15, nextValue: 5,
  status: "low_stock" as const, expectedVersion: 1, expectedOwnerId: "owner" };

test("counter adapter fixes soldCount alert metadata and preserves stock reset/index/response", async () => {
  const db = transport(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const adapter = new DynamoProductCounterRepository();
    const sold = await adapter.increment({ ...incrementInput, field: "soldCount", incrementBy: 2, nextValue: 5, status: "active" });
    assert.equal(sold.representation.soldCount, 5);
    assert.equal(sold.representation.inventoryAlertSentAt, "previous-alert");
    assert.equal(sold.representation.customMetadata, "keep");
    const soldUpdate = db.transactions[0].TransactItems![0].Update!;
    assert.doesNotMatch(soldUpdate.UpdateExpression!, /REMOVE inventoryAlertSentAt/);
    db.setCurrent(productRecord());
    const stock = await adapter.increment(incrementInput);
    assert.equal(stock.representation.stock, 5);
    assert.equal(stock.representation.inventoryAlertSent, false);
    assert.equal("inventoryAlertSentAt" in stock.representation, false);
    assert.equal(stock.representation.version, 2);
    assert.match(db.transactions[1].TransactItems![0].Update!.ConditionExpression!, /ownerSub/);
  } finally { db.close(); }
});

test("counter adapter rejects competing version/owner and preserves infrastructure errors", async () => {
  const db = transport(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const adapter = new DynamoProductCounterRepository();
    const results = await Promise.allSettled([adapter.increment(incrementInput), adapter.increment(incrementInput)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && hasCode("CONFLICT")(result.reason)).length, 1);
    db.setCurrent(productRecord());
    db.beforeWrite(() => db.setCurrent({ ...productRecord(), ownerSub: "other" }));
    await assert.rejects(adapter.increment(incrementInput), hasCode("CONFLICT"));
    for (const failure of [new Error("timeout"), cancellation(0, "TransactionConflict"),
      Object.assign(new Error("throttle"), { name: "ProvisionedThroughputExceededException" })]) {
      db.setCurrent(productRecord());
      db.failNext("TransactWriteItemsCommand", failure);
      await assert.rejects(adapter.increment(incrementInput), error => error === failure);
    }
  } finally { db.close(); }
});

test("create adapter preserves response shape, atomic product/index payload and trusted identity", async () => {
  const db = transport(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  db.setCurrent(null);
  try {
    const creator = new DynamoProductCreator();
    const saved = await creator.create({ product: Product.create(id, "owner", details),
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(saved.id, id);
    assert.equal(saved.ownerSub, "owner");
    assert.equal(saved.version, 1);
    assert.equal(saved.originalPrice, 2000);
    assert.equal(saved.inventoryAlertSent, false);
    assert.equal("PK" in saved, false);
    assert.equal(db.current()?.PK, `PRODUCT#${id}`);
    await assert.rejects(creator.create({ product: Product.create(id, "owner", details), createdAt: "now", updatedAt: "now" }), hasCode("CONFLICT"));
    db.setCurrent(null);
    db.failNext("TransactWriteItemsCommand", cancellation(1));
    await assert.rejects(creator.create({ product: Product.create(id, "owner", details), createdAt: "now", updatedAt: "now" }), hasCode("CONFLICT"));
    assert.equal(db.current(), null);
    const unavailable = new Error("create storage unavailable");
    db.failNext("TransactWriteItemsCommand", unavailable);
    await assert.rejects(creator.create({ product: Product.create(id, "owner", details), createdAt: "now", updatedAt: "now" }), error => error === unavailable);
    assert.equal(db.current(), null);
  } finally { db.close(); }
});

test("delete preserves audited transaction and audit actor; failed transaction is safe to retry", async () => {
  const db = transport(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const adapter = new DynamoProductDeleter();
    const input = { id, expectedVersion: 1, expectedOwnerId: "owner" };
    const failure = new Error("transaction failed before commit");
    db.failNext("TransactWriteItemsCommand", failure);
    await assert.rejects(adapter.delete(input), error => error === failure);
    assert.equal(db.current()?.auditDeleteOutbox, true);
    assert.equal(db.audits.length, 0);
    await auditContext.run({ auditActorType: "USER", auditActorId: "owner", auditActorRole: "customer",
      auditSource: "DELETE /api/shopping-items/:id", auditReason: "authenticated_mutation", auditRequestId: "delete-1" },
    () => adapter.delete(input));
    assert.equal(db.current(), null);
    assert.equal(db.audits.length, 1);
    assert.equal((db.audits[0].actor as { id: string }).id, "owner");
    assert.match(db.transactions.at(-1)!.TransactItems![1].Delete!.ConditionExpression!, /#version = :deleteVersion.*ownerSub/);
    await assert.rejects(adapter.delete(input), hasCode("CONFLICT"));
    assert.equal(db.audits.length, 1);
  } finally { db.close(); }
});

test("delete marker failure does not run transaction; concurrent edit cannot delete/audit stale snapshot", async () => {
  const db = transport(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const adapter = new DynamoProductDeleter();
    const input = { id, expectedVersion: 1, expectedOwnerId: "owner" };
    const failure = new Error("marker unavailable");
    db.failNext("UpdateItemCommand", failure);
    await assert.rejects(adapter.delete(input), error => error === failure);
    assert.equal(db.transactions.length, 0);
    assert.equal(db.current()?.auditDeleteOutbox, undefined);
    db.beforeWrite(() => db.setCurrent({ ...productRecord(), version: 2 }));
    await assert.rejects(adapter.delete(input), hasCode("CONFLICT"));
    assert.equal(db.audits.length, 0);
    assert.equal(db.current()?.version, 2);
    // Marker commits, then an edit races before the delete transaction.
    db.setCurrent(productRecord());
    db.beforeWrite(() => db.beforeWrite(() => db.setCurrent({ ...db.current(), version: 2 })));
    await assert.rejects(adapter.delete(input), hasCode("CONFLICT"));
    assert.equal(db.current()?.auditDeleteOutbox, true);
    assert.equal(db.current()?.version, 2);
    assert.equal(db.audits.length, 0);
    db.setCurrent(productRecord());
    db.failNext("TransactWriteItemsCommand", cancellation(1));
    await assert.rejects(adapter.delete(input), hasCode("CONFLICT"));
    db.failNext("TransactWriteItemsCommand", cancellation(0));
    await assert.rejects(adapter.delete(input), error => !(error instanceof ProductMutationError));
  } finally { db.close(); }
});

test("seed/reseed/increment compatibility exports still share adapter implementations", async () => {
  const db = transport(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const { createShoppingItem, incrementItemValue, deleteShoppingItem } = await import("../src/modules/shopping/shopping.repository.js");
    await incrementItemValue(id, "soldCount", 2, "owner");
    assert.equal(db.current()?.soldCount, 5);
    await deleteShoppingItem(id, "owner");
    const saved = await createShoppingItem({ ...details }, "SYSTEM#SEED");
    assert.equal(saved.ownerSub, "SYSTEM#SEED");
    assert.equal(saved.version, 1);
    assert.equal(db.current()?.id, saved.id);
  } finally { db.close(); }
});

test("compiled HTTP create/increment/delete enforce permission, schemas, ownership, audit and response contracts", async () => {
  const { NestFactory } = await import("@nestjs/core");
  const { FastifyAdapter } = await import("@nestjs/platform-fastify");
  const { ShoppingModule } = await import("../dist/src/modules/shopping/shopping.module.js");
  const { NotificationsService } = await import("../dist/src/modules/notifications/notifications.service.js");
  const { AppExceptionFilter } = await import("../dist/src/common/filters/app-exception.filter.js");
  const { AuditMutationInterceptor } = await import("../dist/src/modules/audit-log/audit-mutation.interceptor.js");
  const { rawDb: compiledDb } = await import("../dist/src/database/dynamodb/client.js");
  const { identityConfig: compiledEnv } = await import("../dist/src/config/identity-config.js");
  const { databaseConfig: compiledDatabaseConfig } = await import("../dist/src/config/database-config.js");
  const db = transport(compiledDb, compiledDatabaseConfig.DYNAMODB_TABLE_NAME);
  const originalAuth = compiledEnv.AUTH_ALLOW_UNVERIFIED_JWT;
  compiledEnv.AUTH_ALLOW_UNVERIFIED_JWT = true;
  const app = await NestFactory.create(ShoppingModule, new FastifyAdapter(), { logger: false });
  const notifications = app.get(NotificationsService);
  const originalPublish = notifications.publishInventoryStockAlert;
  let published = 0;
  notifications.publishInventoryStockAlert = async () => { published++; return { queued: true }; };
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalInterceptors(new AuditMutationInterceptor());
  try {
    await app.init();
    const http = app.getHttpAdapter().getInstance();
    await http.ready();
    const authorization = (subject = "owner", role = "customer", permissions = ["products:create", "products:update-own", "products:delete-own"]) => {
      const payload = Buffer.from(JSON.stringify({ sub: subject, email: `${subject}@example.test`, role, permissions })).toString("base64url");
      return `Bearer header.${payload}.signature`;
    };
    const request = (method: "POST" | "PATCH" | "DELETE", suffix: string, payload?: Record<string, unknown>, token = authorization()) =>
      http.inject({ method, url: `/api/shopping-items${suffix}`, payload, headers: { authorization: token } });
    const forbidden = authorization("owner", "customer", []);
    assert.equal((await request("POST", "", { ...details }, forbidden)).statusCode, 403);
    assert.equal((await request("PATCH", `/${id}/increment`, { incrementBy: 1 }, forbidden)).statusCode, 403);
    assert.equal((await request("DELETE", `/${id}`, undefined, forbidden)).statusCode, 403);
    assert.equal((await request("PATCH", `/${id}/increment`, { field: "price", incrementBy: 1 })).statusCode, 400);
    assert.equal((await request("POST", "", { ...details, category: undefined })).statusCode, 400);
    assert.equal((await request("POST", "", { ...details, stock: -1 })).statusCode, 400);
    assert.equal((await request("PATCH", `/${id}/increment`, { incrementBy: 1 }, authorization("other"))).statusCode, 403);
    assert.equal((await request("DELETE", `/${id}`, undefined, authorization("other"))).statusCode, 403);
    const incremented = await request("PATCH", `/${id}/increment`, { field: "stock", incrementBy: -15 });
    assert.equal(incremented.statusCode, 200);
    assert.equal(incremented.json().stock, 5);
    assert.equal(published, 1);
    assert.equal(unmarshall(db.transactions[0].TransactItems![0].Update!.ExpressionAttributeValues!)[":_audit_auditActorId"], "owner");
    db.setCurrent(productRecord());
    const sold = await request("PATCH", `/${id}/increment`, { field: "soldCount", incrementBy: 2 });
    assert.equal(sold.json().inventoryAlertSentAt, "previous-alert");
    assert.equal(sold.json().soldCount, 5);
    db.setCurrent(productRecord());
    const adminWrite = await request("PATCH", `/${id}/increment`, { incrementBy: 1 }, authorization("admin", "admin", []));
    assert.equal(adminWrite.statusCode, 200);
    assert.doesNotMatch(db.transactions.at(-1)!.TransactItems![0].Update!.ConditionExpression!, /ownerSub/);
    const deleted = await request("DELETE", `/${id}`);
    assert.equal(deleted.statusCode, 204);
    assert.equal(deleted.body, "");
    assert.equal((db.audits.at(-1)!.actor as { id: string }).id, "owner");
    assert.equal((await request("DELETE", `/${id}`)).statusCode, 404);
    db.setCurrent(productRecord());
    const adminDelete = await request("DELETE", `/${id}`, undefined, authorization("admin", "admin", []));
    assert.equal(adminDelete.statusCode, 204);
    assert.equal((db.audits.at(-1)!.actor as { id: string }).id, "admin");
    assert.doesNotMatch(db.markers.at(-1)!.ConditionExpression!, /ownerSub/);
    const created = await request("POST", "", { ...details, id: "spoofed", ownerSub: "other", PK: "spoofed", version: 99, status: "out_of_stock" });
    assert.equal(created.statusCode, 201);
    assert.notEqual(created.json().id, "spoofed");
    assert.equal(created.json().ownerSub, "owner");
    assert.equal(created.json().version, 1);
    assert.equal(created.json().status, "active");
    assert.equal(created.json().rating, 4.8);
    assert.equal(created.json().PK, undefined);
    assert.equal(published, 1);
    db.setCurrent(productRecord());
    db.failNext("TransactWriteItemsCommand", cancellation(0));
    assert.equal((await request("PATCH", `/${id}/increment`, { incrementBy: 1 })).statusCode, 409);
    db.failNext("TransactWriteItemsCommand", new Error("storage unavailable"));
    assert.equal((await request("PATCH", `/${id}/increment`, { incrementBy: 1 })).statusCode, 500);
  } finally {
    notifications.publishInventoryStockAlert = originalPublish;
    compiledEnv.AUTH_ALLOW_UNVERIFIED_JWT = originalAuth;
    db.close();
    await app.close();
  }
});
