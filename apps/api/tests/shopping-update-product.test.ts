import "reflect-metadata";
import { databaseConfig } from "../src/config/database-config.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DynamoDBClient, TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { UpdateProduct } from "../src/modules/shopping/application/update-product/update-product.js";
import { ProductMutationError } from "../src/modules/shopping/application/product-mutation.error.js";
import type { ProductWriteRepository } from "../src/modules/shopping/application/ports/product-write-repository.js";
import type { InventoryStockAlert } from "../src/modules/shopping/application/ports/inventory-alert-publisher.js";
import { deriveStockStatus } from "../src/modules/shopping/domain/stock-policy.js";
import { Product, type ProductSnapshot } from "../src/modules/shopping/domain/product.js";
import { DynamoProductWriteRepository } from "../src/modules/shopping/infrastructure/persistence/dynamo-product-write-repository.js";
import { rawDb } from "../src/database/dynamodb/client.js";
import { auditContext } from "../src/modules/audit-log/audit-context.js";

const id = "10000000-0000-4000-8000-000000000001";
const product: ProductSnapshot = { id, ownerId: "owner", name: "Product", sku: "SKU-1", stock: 20, status: "active", version: 1 };
const command = { productId: id, changes: { stock: 5 }, expectedVersion: 1, actor: { subject: "owner", isAdmin: false } };
const hasCode = (code: string) => (error: unknown) => error instanceof ProductMutationError && error.code === code;

function fixture(current: ProductSnapshot | null = product) {
  const alerts: InventoryStockAlert[] = [];
  const writes: Array<Parameters<ProductWriteRepository<{ marker: string }>["update"]>[0]> = [];
  const representation = { marker: "legacy-response" };
  const repository: ProductWriteRepository<typeof representation> = {
    async findById() { return current ? new Product(current) : null; },
    async update(input) {
      writes.push(input);
      return { product: new Product({ ...input.product.toSnapshot(), version: 2 }), representation };
    }
  };
  const publisher = { async publish(alert: InventoryStockAlert) { alerts.push(alert); } };
  return { useCase: new UpdateProduct(repository, publisher, "direct"), repository, publisher, alerts, writes, representation };
}

test("stock policy keeps the exact 0/1/10/11 boundaries", () => {
  assert.deepEqual([0, 1, 10, 11].map(deriveStockStatus), ["out_of_stock", "low_stock", "low_stock", "active"]);
});

test("owner update retains opaque response, conditional ownership and transition alert", async () => {
  const f = fixture();
  assert.equal(await f.useCase.execute(command), f.representation);
  assert.equal(f.writes[0].expectedOwnerId, "owner");
  assert.equal(f.writes[0].expectedVersion, 1);
  assert.equal(f.writes[0].product.status, "low_stock");
  assert.deepEqual(f.alerts, [{ productId: id, productName: "Product", sku: "SKU-1", stock: 5,
    previousStock: 20, status: "low_stock", previousStatus: "active", source: "admin.update" }]);
});

test("admin can update another owner's product without an owner condition", async () => {
  const f = fixture();
  await f.useCase.execute({ ...command, actor: { subject: "admin", isAdmin: true } });
  assert.equal(f.writes[0].expectedOwnerId, undefined);
});

test("missing product, other owner and stale version cannot write or publish", async () => {
  for (const [current, actor, code] of [
    [null, command.actor, "NOT_FOUND"],
    [product, { subject: "other", isAdmin: false }, "FORBIDDEN"],
    [{ ...product, version: 2 }, command.actor, "CONFLICT"]
  ] as const) {
    const f = fixture(current);
    await assert.rejects(f.useCase.execute({ ...command, actor }), hasCode(code));
    assert.equal(f.writes.length, 0);
    assert.equal(f.alerts.length, 0);
  }
});

test("invalid stock/version/identity is rejected before persistence", async () => {
  for (const stock of [-1, 1.5, NaN, Infinity, 1000000]) {
    const f = fixture();
    await assert.rejects(f.useCase.execute({ ...command, changes: { stock } }), hasCode("INVALID_INPUT"));
    assert.equal(f.writes.length, 0);
  }
  for (const expectedVersion of [0, -1, 1.5, NaN]) {
    await assert.rejects(fixture().useCase.execute({ ...command, expectedVersion }), hasCode("INVALID_INPUT"));
  }
  await assert.rejects(fixture().useCase.execute({ ...command, actor: { subject: "", isAdmin: true } }), hasCode("INVALID_INPUT"));
});

test("hydrating an invalid stored product is passive but its update cannot write or publish", async () => {
  const f = fixture({ ...product, soldCount: -1 });
  assert.ok(await f.repository.findById(id) instanceof Product);
  await assert.rejects(f.useCase.execute(command), hasCode("INVALID_INPUT"));
  assert.equal(f.writes.length, 0); assert.equal(f.alerts.length, 0);
});

test("alerts only on entering low/out status, including updates without a stock patch", async () => {
  for (const [current, changes, expectedAlerts] of [
    [product, { stock: 0 }, 1],
    [{ ...product, stock: 5, status: "low_stock" }, { stock: 4 }, 0],
    [{ ...product, stock: 5, status: "low_stock" }, { stock: 20 }, 0],
    [product, { name: "Renamed" }, 0],
    [{ ...product, stock: 5, status: "active" }, { name: "Renamed" }, 1]
  ] as const) {
    const f = fixture(current);
    await f.useCase.execute({ ...command, changes });
    assert.equal(f.alerts.length, expectedAlerts);
  }
});

test("write failure never publishes; publish failure occurs after commit and is not retried", async () => {
  const f = fixture();
  const failure = new Error("storage unavailable");
  f.repository.update = async () => { throw failure; };
  await assert.rejects(f.useCase.execute(command), error => error === failure);
  assert.equal(f.alerts.length, 0);

  const g = fixture();
  const publishFailure = new Error("publish unavailable");
  let attempts = 0;
  g.publisher.publish = async () => { attempts++; assert.equal(g.writes.length, 1); throw publishFailure; };
  await assert.rejects(g.useCase.execute(command), error => error === publishFailure);
  assert.equal(g.writes.length, 1);
  assert.equal(attempts, 1);
});

const record = () => ({ PK: `PRODUCT#${id}`, SK: "DETAIL", entityType: "PRODUCT" as const, id, ownerSub: "owner",
  name: "Product", category: "Gia dung", brand: "Brand", sku: "SKU-1", price: 2000, originalPrice: 3000,
  stock: 20, status: "active" as const, version: 1, createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z", inventoryAlertSent: true, inventoryAlertSentAt: "old-alert",
  customLegacyMetadata: "preserve-me" });

/**
 * In-process SDK middleware transport, not a DynamoDB emulator or live service.
 * Real audit middleware runs before this transport. Conditions are simulated;
 * command assertions verify the adapter contract, not AWS expression execution.
 */
function fakeDynamo(client: DynamoDBClient, table: string) {
  let current: Record<string, unknown> | null = record();
  let failure: unknown;
  const transactions: TransactWriteItemsCommandInput[] = [];
  client.middlewareStack.add((_next, context) => async args => {
    if (context.commandName === "GetItemCommand") {
      const input = args.input as { ConsistentRead?: boolean; TableName?: string };
      assert.equal(input.ConsistentRead, true);
      assert.equal(input.TableName, table);
      return { response: {}, output: { $metadata: {}, Item: current ? marshall(current) : undefined } };
    }
    assert.equal(context.commandName, "TransactWriteItemsCommand");
    const input = args.input as TransactWriteItemsCommandInput;
    transactions.push(input);
    if (failure) throw failure;
    const update = input.TransactItems?.[0]?.Update;
    assert.ok(update);
    const values = unmarshall(update.ExpressionAttributeValues!);
    assert.match(update.ConditionExpression!, /attribute_exists\(PK\).*#version = :expectedVersion/);
    assert.equal(update.TableName, table);
    if (!current || current.version !== values[":expectedVersion"] ||
      (values[":expectedOwnerSub"] !== undefined && current.ownerSub !== values[":expectedOwnerSub"])) {
      throw Object.assign(new Error("condition failed"), { name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] });
    }
    assert.equal(input.TransactItems?.length, 3);
    assert.ok(input.TransactItems?.[1]?.Delete);
    const indexed = unmarshall(input.TransactItems![2].Put!.Item!);
    current = { ...(indexed.product as Record<string, unknown>) };
    return { response: {}, output: { $metadata: {} } };
  }, { step: "initialize", priority: "low", name: "shoppingTestTransport" });
  return {
    transactions,
    setCurrent(value: Record<string, unknown> | null) { current = value; },
    setFailure(value: unknown) { failure = value; },
    current: () => current,
    close: () => { client.middlewareStack.remove("shoppingTestTransport"); }
  };
}

test("Dynamo adapter preserves transaction, category index, legacy response and audit actor", async () => {
  const db = fakeDynamo(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const adapter = new DynamoProductWriteRepository();
    const snapshot = await adapter.findById(id);
    assert.ok(snapshot instanceof Product);
    assert.equal(typeof snapshot.decreaseStock, "function");
    assert.equal(snapshot.stock, product.stock); assert.equal(snapshot.toSnapshot().category, "Gia dung");
    assert.equal("PK" in snapshot!, false);
    const result = await auditContext.run({ auditActorType: "USER", auditActorId: "owner", auditActorRole: "customer",
      auditSource: "PATCH /api/shopping-items/:id", auditReason: "authenticated_mutation", auditRequestId: "request-1" },
    () => adapter.update({ product: snapshot!.update({ stock: 5, category: "Dien tu", name: "Updated" }), fields: ["stock", "category", "name"], expectedVersion: 1, expectedOwnerId: "owner" }));
    assert.equal(result.representation.PK, `PRODUCT#${id}`);
    assert.equal(result.representation.customLegacyMetadata, "preserve-me");
    assert.equal(result.representation.version, 2);
    assert.equal(result.representation.inventoryAlertSent, false);
    assert.equal("inventoryAlertSentAt" in result.representation, false);
    const transaction = db.transactions[0];
    const update = transaction.TransactItems![0].Update!;
    assert.match(update.ConditionExpression!, /ownerSub = :expectedOwnerSub/);
    assert.match(update.UpdateExpression!, /REMOVE inventoryAlertSentAt/);
    assert.equal(unmarshall(update.ExpressionAttributeValues!)[":_audit_auditActorId"], "owner");
    assert.equal(unmarshall(transaction.TransactItems![1].Delete!.Key!).PK, "PRODUCT_CATEGORY#gia dung");
    const index = unmarshall(transaction.TransactItems![2].Put!.Item!);
    assert.equal(index.PK, "PRODUCT_CATEGORY#dien tu");
    assert.equal((index.product as Record<string, unknown>).version, 2);
    assert.equal((index.product as Record<string, unknown>).stock, 5);
  } finally { db.close(); }
});

test("metadata-only update retains inventory alert markers and original price", async () => {
  const db = fakeDynamo(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const saved = await new DynamoProductWriteRepository().update({ product: new Product(product).update({ name: "Renamed" }), fields: ["name"], expectedVersion: 1 });
    assert.equal(saved.representation.inventoryAlertSent, true);
    assert.equal(saved.representation.inventoryAlertSentAt, "old-alert");
    assert.equal(saved.representation.originalPrice, 3000);
    const update = db.transactions[0].TransactItems![0].Update!;
    assert.doesNotMatch(update.ConditionExpression!, /ownerSub/);
    assert.doesNotMatch(update.UpdateExpression!, /REMOVE inventoryAlertSentAt/);
  } finally { db.close(); }
});

test("two adapter writes with the same version have one winner in the conditional transport model", async () => {
  const db = fakeDynamo(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const adapter = new DynamoProductWriteRepository();
    const input = { product: new Product(product).update({ stock: 5 }), fields: ["stock"] as const, expectedVersion: 1, expectedOwnerId: "owner" };
    const results = await Promise.allSettled([adapter.update(input), adapter.update({ ...input, product: new Product(product).update({ stock: 8 }) })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(hasCode("CONFLICT")(rejected.reason));
    assert.equal(db.current()?.version, 2);
  } finally { db.close(); }
});

test("changed owner/deleted record fail safely, while infrastructure errors keep their identity", async () => {
  const db = fakeDynamo(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const adapter = new DynamoProductWriteRepository();
    const input = { product: new Product(product).update({ stock: 5 }), fields: ["stock"] as const, expectedVersion: 1, expectedOwnerId: "owner" };
    db.setCurrent({ ...record(), ownerSub: "new-owner" });
    await assert.rejects(adapter.update(input), hasCode("CONFLICT"));
    db.setCurrent(null);
    await assert.rejects(adapter.update(input), hasCode("CONFLICT"));
    db.setCurrent(record());
    for (const failure of [
      new Error("network timeout"),
      Object.assign(new Error("transaction contention"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] }),
      Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }),
      Object.assign(new Error("invalid expression"), { name: "ValidationException" })
    ]) {
      db.setFailure(failure);
      await assert.rejects(adapter.update(input), error => error === failure);
    }
  } finally { db.close(); }
});

test("legacy maintenance export uses the same transaction implementation", async () => {
  const db = fakeDynamo(rawDb, databaseConfig.DYNAMODB_TABLE_NAME);
  try {
    const { updateShoppingItem } = await import("../src/modules/shopping/shopping.repository.js");
    const saved = await updateShoppingItem(id, { stock: 0 }, 1);
    assert.equal(saved.status, "out_of_stock");
    assert.equal(saved.version, 2);
    assert.equal(db.transactions.length, 1);
  } finally { db.close(); }
});

test("compiled Nest module wires real HTTP validation, authorization, errors, audit and legacy response", async () => {
  // Nest requires decorator metadata from tsc; esbuild/tsx does not emit it.
  const { NestFactory } = await import("@nestjs/core");
  const { FastifyAdapter } = await import("@nestjs/platform-fastify");
  const { ShoppingModule } = await import("../dist/src/modules/shopping/shopping.module.js");
  const { NotificationsService } = await import("../dist/src/modules/notifications/notifications.service.js");
  const { AppExceptionFilter } = await import("../dist/src/common/filters/app-exception.filter.js");
  const { AuditMutationInterceptor } = await import("../dist/src/modules/audit-log/audit-mutation.interceptor.js");
  const { rawDb: compiledDb } = await import("../dist/src/database/dynamodb/client.js");
  const { identityConfig: compiledEnv } = await import("../dist/src/config/identity-config.js");
  const { databaseConfig: compiledDatabaseConfig } = await import("../dist/src/config/database-config.js");
  const db = fakeDynamo(compiledDb, compiledDatabaseConfig.DYNAMODB_TABLE_NAME);
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
    const authorization = (subject = "owner", role = "customer", permissions = ["products:update-own"]) => {
      const payload = Buffer.from(JSON.stringify({ sub: subject, email: `${subject}@example.test`, role, permissions })).toString("base64url");
      return `Bearer header.${payload}.signature`;
    };
    async function patch(body: Record<string, unknown>, token?: string) {
      return http.inject({ method: "PATCH", url: `/api/shopping-items/${id}`, payload: body,
        headers: token ? { authorization: token } : {} });
    }
    assert.equal((await patch({ stock: 5, version: 1 })).statusCode, 403);
    assert.equal((await patch({ stock: 5, version: 1 }, authorization("owner", "customer", []))).statusCode, 403);
    assert.equal((await patch({ stock: -1, version: 1 }, authorization())).statusCode, 400);
    const forbidden = await patch({ stock: 5, version: 1 }, authorization("other"));
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().message, "You can only modify products that you created.");
    db.setCurrent(null);
    assert.equal((await patch({ stock: 5, version: 1 }, authorization())).statusCode, 404);
    db.setCurrent(record());
    const saved = await patch({ stock: 5, version: 1, ownerSub: "attacker", PK: "spoofed", status: "active" }, authorization());
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().PK, `PRODUCT#${id}`);
    assert.equal(saved.json().ownerSub, "owner");
    assert.equal(saved.json().status, "low_stock");
    assert.equal(saved.json().customLegacyMetadata, "preserve-me");
    assert.equal(published, 1);
    const update = db.transactions[0].TransactItems![0].Update!;
    assert.equal(unmarshall(update.ExpressionAttributeValues!)[":_audit_auditActorId"], "owner");
    assert.match(update.ConditionExpression!, /ownerSub/);
    const conflict = await patch({ stock: 8, version: 1 }, authorization());
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().message, "Record changed, missing, or condition failed");
    db.setCurrent(record());
    const admin = await patch({ stock: 30, version: 1 }, authorization("admin", "admin", []));
    assert.equal(admin.statusCode, 200);
    assert.doesNotMatch(db.transactions.at(-1)!.TransactItems![0].Update!.ConditionExpression!, /ownerSub/);
    db.setCurrent(record());
    db.setFailure(Object.assign(new Error("race"), { name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }] }));
    assert.equal((await patch({ stock: 5, version: 1 }, authorization())).statusCode, 409);
    db.setFailure(new Error("database unavailable"));
    assert.equal((await patch({ stock: 5, version: 1 }, authorization())).statusCode, 500);
  } finally {
    notifications.publishInventoryStockAlert = originalPublish;
    compiledEnv.AUTH_ALLOW_UNVERIFIED_JWT = originalAuth;
    db.close();
    await app.close();
  }
});
