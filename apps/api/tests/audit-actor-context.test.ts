import assert from "node:assert/strict";
import { test } from "node:test";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { PutItemCommandInput, UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import { auditContext, type AuditWriteContext } from "../src/modules/audit-log/audit-context.js";
import { stampAuditWrite } from "../src/modules/audit-log/audit-write.js";

const actor: AuditWriteContext = { auditActorType: "ADMIN", auditActorId: "admin-1", auditActorRole: "admin",
  auditSource: "PATCH /api/shopping-items/:id", auditReason: "authenticated_mutation", auditRequestId: "request-1" };

test("stamp respects table boundaries and existing SET/REMOVE/ADD clauses", () => {
  const update: UpdateItemCommandInput = { TableName: "source", Key: marshall({ PK: "PRODUCT#p1", SK: "DETAIL" }),
    UpdateExpression: "SET #stock = :stock REMOVE inventoryAlertSentAt ADD #version :one",
    ExpressionAttributeNames: { "#stock": "stock", "#version": "version" }, ExpressionAttributeValues: marshall({ ":stock": 10, ":one": 1 }) };
  auditContext.run(actor, () => stampAuditWrite("UpdateItemCommand", update, "source"));
  assert.match(update.UpdateExpression!, /REMOVE inventoryAlertSentAt ADD #version :one$/);
  assert.equal(update.ExpressionAttributeValues?.[":_audit_auditActorId"]?.S, actor.auditActorId);
  const foreign = { ...update, TableName: "audit" };
  const original = JSON.stringify(foreign);
  stampAuditWrite("UpdateItemCommand", foreign, "source");
  assert.equal(JSON.stringify(foreign), original);
});

test("authenticated caller replaces legacy service attribution without duplicate SET paths", () => {
  const update: UpdateItemCommandInput = { TableName: "source", Key: marshall({ PK: "ORDER#o1", SK: "ORDER" }),
    UpdateExpression: "SET #actor = :actor, auditSource = :source, #status = :status",
    ExpressionAttributeNames: { "#actor": "auditActorId", "#status": "status" }, ExpressionAttributeValues: marshall({ ":actor": "service:refund", ":source": "REFUND_API", ":status": "refund_pending" }) };
  auditContext.run(actor, () => stampAuditWrite("UpdateItemCommand", update, "source"));
  assert.equal(update.ExpressionAttributeValues?.[":actor"]?.S, actor.auditActorId);
  assert.equal(update.ExpressionAttributeValues?.[":source"]?.S, actor.auditSource);
  assert.equal(update.ExpressionAttributeValues?.[":status"]?.S, "refund_pending");
  assert.equal(update.ExpressionAttributeNames?.["#_audit_auditActorId"], undefined);
});

test("the audited client context overrides spoofed actor fields even without an HTTP principal", () => {
  const update: UpdateItemCommandInput = { TableName: "source", Key: marshall({ PK: "ORDER#o1", SK: "ORDER" }),
    UpdateExpression: "SET auditActorId = :actor, auditSource = :source, #status = :status",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: marshall({ ":actor": "user-supplied", ":source": "USER_INPUT", ":status": "paid" }) };
  stampAuditWrite("UpdateItemCommand", update, "source");
  assert.equal(update.ExpressionAttributeValues?.[":actor"]?.S, process.env.AWS_LAMBDA_FUNCTION_NAME ?? "service:backend");
  assert.equal(update.ExpressionAttributeValues?.[":source"]?.S, process.env.AWS_LAMBDA_FUNCTION_NAME ?? "BACKEND");
});

test("concurrent async requests keep distinct actors on transactional writes", async () => {
  const ids = await Promise.all(["user-1", "user-2"].map((id) => auditContext.run({ ...actor, auditActorId: id }, async () => {
    await new Promise((resolve) => setTimeout(resolve, id === "user-1" ? 5 : 1));
    const put: PutItemCommandInput = { TableName: "source", Item: marshall({ PK: "PRODUCT#p1", SK: "DETAIL", stock: 1 }) };
    stampAuditWrite("TransactWriteItemsCommand", { TransactItems: [{ Put: put }] }, "source");
    return put.Item?.auditActorId?.S;
  })));
  assert.deepEqual(ids, ["user-1", "user-2"]);
});

test("password reset updates only its completion timestamp and does not hand-write audit metadata", async () => {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { TriggerPostConfirmation } = await import("../src/entrypoints/lambda/cognito/triggers/post-confirmation.js");
  const db = new DynamoDBClient({ region: "ap-southeast-1" });
  let input: UpdateItemCommandInput | undefined;
  db.send = (async (command: { input: UpdateItemCommandInput }) => { input = command.input; return {}; }) as typeof db.send;
  await TriggerPostConfirmation(db, { triggerSource: "PostConfirmation_ConfirmForgotPassword", userPoolId: "pool", userName: "user",
    request: { userAttributes: { sub: "u1" }, code: "do-not-store", clientMetadata: { password: "do-not-store" } }, response: {} });
  assert.ok(input?.UpdateExpression?.includes("passwordResetAt"));
  assert.ok(!input?.UpdateExpression?.includes("displayName"));
  assert.ok(!JSON.stringify(input).includes("do-not-store"));
  assert.equal(input?.ExpressionAttributeValues?.[":subject"]?.S, "u1");
  assert.ok(!input?.UpdateExpression?.includes("auditActorId"));
  db.destroy();
});

test("HTTP interceptor establishes actor context and blocks external operations when the initial ledger fails", async () => {
  const { rawDb } = await import("../src/database/dynamodb/client.js");
  const { identityConfig: env } = await import("../src/config/identity-config.js");
  const { AuditMutationInterceptor } = await import("../src/modules/audit-log/audit-mutation.interceptor.js");
  const { lastValueFrom, defer } = await import("rxjs");
  const originalSend = rawDb.send;
  const originalAuthFlag = env.AUTH_ALLOW_UNVERIFIED_JWT;
  env.AUTH_ALLOW_UNVERIFIED_JWT = true;
  const payload = Buffer.from(JSON.stringify({ sub: "admin-1", email: "admin@example.test", role: "admin" })).toString("base64url");
  function context(route: string) {
    return { switchToHttp: () => ({ getRequest: () => ({ method: "POST", routeOptions: { url: route }, url: route,
      headers: { authorization: `Bearer header.${payload}.signature` }, params: {} }) }) } as unknown as import("@nestjs/common").ExecutionContext;
  }
  try {
    const interceptor = new AuditMutationInterceptor();
    const result = await lastValueFrom(await interceptor.intercept(context("/api/shopping-items"), {
      handle: () => defer(async () => { await Promise.resolve(); return auditContext.getStore()?.auditActorId; })
    }));
    assert.equal(result, "admin-1");
    assert.equal(auditContext.getStore(), undefined);
    let handlerCalls = 0;
    rawDb.send = (async () => { throw new Error("ledger unavailable"); }) as typeof rawDb.send;
    await assert.rejects(lastValueFrom(await interceptor.intercept(context("/api/admin/ops/dlq/replay"), {
      handle: () => { handlerCalls++; return defer(async () => "replayed"); }
    })), /ledger unavailable/);
    assert.equal(handlerCalls, 0);
  } finally { rawDb.send = originalSend; env.AUTH_ALLOW_UNVERIFIED_JWT = originalAuthFlag; }
});

test("HTTP interceptor attributes unauthenticated mutations to the HTTP service", async () => {
  const { AuditMutationInterceptor } = await import("../src/modules/audit-log/audit-mutation.interceptor.js");
  const { lastValueFrom, defer } = await import("rxjs");
  const request = { method: "POST", routeOptions: { url: "/api/vnpay/ipn" }, url: "/api/vnpay/ipn", headers: {}, params: {} };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as import("@nestjs/common").ExecutionContext;
  const result = await lastValueFrom(await new AuditMutationInterceptor().intercept(context, {
    handle: () => defer(async () => auditContext.getStore())
  }));
  assert.ok(result && typeof result === "object");
  assert.equal("auditActorType" in result ? result.auditActorType : undefined, "SERVICE");
  assert.equal("auditActorId" in result ? result.auditActorId : undefined, "service:http-api");
  assert.equal("auditSource" in result ? result.auditSource : undefined, "POST /api/vnpay/ipn");
});
