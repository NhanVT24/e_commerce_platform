import { transport } from "./helpers/payment-transport.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { CreateCheckout } from "../src/modules/storefront/application/create-checkout/create-checkout.js";
import { ConfirmOrderPayment } from "../src/modules/storefront/application/confirm-order-payment/confirm-order-payment.js";
import { ExpireOrders } from "../src/modules/storefront/application/expire-orders/expire-orders.js";
import { FinalizeOrder } from "../src/modules/storefront/application/finalize-order/finalize-order.js";
import { normalizeCheckoutItems } from "../src/modules/storefront/application/checkout-items.js";
import { PaymentProcessing } from "../src/modules/vnpay/application/payment-processing.js";
import { CreatePayment } from "../src/modules/vnpay/application/create-payment.js";
import type { PaymentSession, VerifiedPaymentCallback } from "../src/modules/vnpay/domain/payment.js";
import type { PaymentSessions, PaymentEvents } from "../src/modules/vnpay/application/ports/payment-ports.js";
import { DynamoPaymentSessions } from "../src/modules/vnpay/infrastructure/dynamo-payment-sessions.js";
import { DynamoCheckoutOrders } from "../src/modules/storefront/infrastructure/persistence/dynamo-checkout-orders.js";
import { DynamoOrderFinalization } from "../src/modules/storefront/infrastructure/persistence/dynamo-order-finalization.js";
import { inventoryTransaction } from "../src/modules/shopping/infrastructure/persistence/inventory-transaction.js";
import { rawDb } from "../src/database/dynamodb/client.js";
import { signVnpayParams } from "../src/modules/vnpay/vnpay-signature.js";

const email = "owner@example.test";
const id = "12345678-1234-4234-8234-123456789012";
const productId = "12345678-1234-4234-8234-123456789013";
const items = [{ productId, quantity: 2 }];
const clock = Date.parse("2026-10-20T01:00:00.000Z");
const log = { error() {} };
const callback: VerifiedPaymentCallback = { txnRef: "NXtest", amountMinor: "200000", transactionStatus: "success",
  gatewayTransactionStatus: "00", responseCode: "00", transactionNo: "123", bankCode: "TEST", payDate: "20261020080000" };
const initialPayment = (): PaymentSession => ({ txnRef: "NXtest", orderId: id, email, amount: 2000, orderInfo: "Order", status: "pending" });

function paymentFixture() {
  let session: PaymentSession | null = initialPayment();
  let writes = 0, publishes = 0, releases = 0;
  let failMarker = false;
  const sessions: PaymentSessions = {
    async find() { return session && { ...session }; },
    async confirm(input) {
      if (session!.status !== "pending") return { session, changed: false };
      writes++;
      session = { ...session!, ...input, status: input.transactionStatus };
      return { session, changed: true };
    },
    async markDispatched() { if (failMarker) { failMarker = false; throw new Error("marker unavailable"); } session!.paymentEventEnqueuedAt = "now"; }
  };
  const events: PaymentEvents = { async publishCompleted() { publishes++; }, async publishFailed() { publishes++; } };
  const processing = new PaymentProcessing(sessions, events, { async release() { releases++; } }, log);
  return { sessions, events, processing, stats: () => ({ writes, publishes, releases }),
    set(value: PaymentSession | null) { session = value; }, current: () => session, failMarker() { failMarker = true; } };
}

test("IPN core commits once, suppresses duplicates after marker and rejects a conflicting outcome", async () => {
  const f = paymentFixture();
  assert.equal((await f.processing.confirm(callback)).outcome, "confirmed");
  assert.equal((await f.processing.confirm(callback)).outcome, "already_confirmed");
  assert.deepEqual(f.stats(), { writes: 1, publishes: 1, releases: 0 });
  await assert.rejects(f.processing.confirm({ ...callback, transactionStatus: "failed", responseCode: "24" }), /Conflicting/);
});

test("IPN amount and missing-session checks precede all writes", async () => {
  const f = paymentFixture();
  assert.equal((await f.processing.confirm({ ...callback, amountMinor: "999" })).outcome, "invalid_amount");
  f.set(null);
  assert.equal((await f.processing.confirm(callback)).outcome, "not_found");
  assert.equal(f.stats().writes, 0);
});

test("publish success / marker failure replays the event without recording money twice", async () => {
  const f = paymentFixture();
  f.failMarker();
  await assert.rejects(f.processing.confirm(callback), /marker unavailable/);
  assert.equal(f.current()?.status, "success");
  assert.equal(f.current()?.paymentEventEnqueuedAt, undefined);
  assert.equal((await f.processing.confirm(callback)).outcome, "already_confirmed");
  assert.deepEqual(f.stats(), { writes: 1, publishes: 2, releases: 0 });
});

test("disabled publisher remains recoverable; non-final sessions cannot dispatch", async () => {
  const f = paymentFixture();
  f.events.publishCompleted = async () => { throw new Error("disabled"); };
  await assert.rejects(f.processing.confirm(callback), /disabled/);
  assert.equal(f.current()?.paymentEventEnqueuedAt, undefined);
  f.events.publishCompleted = async () => {};
  await f.processing.resumeDispatch((await f.sessions.find("NXtest"))!);
  const g = paymentFixture();
  await g.processing.resumeDispatch((await g.sessions.find("NXtest"))!);
  assert.equal(g.stats().publishes, 0);
});

test("failed payment releases its matching order before hand-off; mismatch prevents marker", async () => {
  const f = paymentFixture();
  await f.processing.confirm({ ...callback, transactionStatus: "failed", gatewayTransactionStatus: "02", responseCode: "24" });
  assert.deepEqual(f.stats(), { writes: 1, publishes: 1, releases: 1 });
  const g = paymentFixture();
  g.set({ ...initialPayment(), email: undefined });
  await assert.rejects(g.processing.confirm(callback), /no customer email/);
  assert.equal(g.current()?.status, "success");
  assert.equal(g.stats().publishes, 0);
});

test("checkout item policy rejects fractions, empty carts and merged quantity overflow", () => {
  assert.deepEqual(normalizeCheckoutItems([...items, ...items]), [{ productId, quantity: 4 }]);
  for (const bad of [[], [{ productId, quantity: 1.5 }], [{ productId, quantity: 30 }, { productId, quantity: 30 }]]) {
    assert.throws(() => normalizeCheckoutItems(bad));
  }
});

test("checkout keeps the hold on ambiguous payment failure instead of compensating a concurrent winner", async () => {
  const calls: string[] = [];
  const held = { id, customerEmail: email, status: "awaiting_payment" as const, totalAmount: 2000, lockedUntil: "future" };
  const orders = { async hold() { calls.push("hold"); return { order: held, items: [{ ...items[0], productName: "P", unitPrice: 1000, lineTotal: 2000 }] }; },
    async transition() { calls.push("release"); throw new Error("release unavailable"); }, async attachPayment() { calls.push("attach"); },
    async findById() { return held; }, async *expiredCandidates() {} };
  const useCase = new CreateCheckout(orders, { async create() { calls.push("payment"); throw new Error("payment unavailable"); } },
    { error(event) { calls.push(event); } }, () => id);
  await assert.rejects(useCase.execute(email, { items }), /payment unavailable/);
  assert.deepEqual(calls, ["hold", "payment", "checkout.provisioning_interrupted"]);
});

test("payment creation trusts committed checkout price and validates amount/expiry before issuing", async () => {
  let reads = 0, issues = 0;
  const useCase = new CreatePayment({ async find() { reads++; return { stock: 10, price: 999 }; } },
    { async issue(_input, details) { issues++; return { paymentUrl: "url", txnRef: "ref", amount: details.amount, orderInfo: "Order", expiresAt: details.expiresAt.toISOString(), timeoutMinutes: 5 }; } }, () => clock);
  assert.equal((await useCase.execute({ email, items }, "127.0.0.1", { amount: 2000, skipStockValidation: true })).amount, 2000);
  assert.equal(reads, 0);
  await assert.rejects(useCase.execute({ items }, "ip", { amount: 0 }), /positive integer/);
  await assert.rejects(useCase.execute({ items }, "ip", { amount: 10000000000 }), /positive integer/);
  await assert.rejects(useCase.execute({ items }, "ip", { expiresAt: new Date(clock).toISOString() }), /expired/);
  assert.equal(issues, 1);
});

test("expiry continues after a per-order failure and passes an exact deadline to the transaction", async () => {
  const useCase = new ExpireOrders({ async *expiredCandidates() { yield "a"; yield "b"; },
    async transition(input) { assert.equal(input.expiresBefore, new Date(clock).toISOString());
      if (input.orderId === "a") throw new Error("contention"); return { changed: true, order: null!, items: [] }; },
    async hold() { throw new Error("unused"); }, async findById() { return null; }, async attachPayment() {} }, log, () => clock);
  assert.deepEqual(await useCase.execute(), { ok: false, releasedCount: 1, failed: 1, checkedAt: new Date(clock).toISOString() });
});

// SDK transport fake: exercises real adapters/audit middleware and transaction
// construction. This is NOT a DynamoDB expression engine or an AWS integration.

test("inventory builder atomically mirrors status/counters and prevents duplicate index keys in one millisecond", () => {
  const product = { id: productId, category: "Food", stock: 1, soldCount: 0, version: 1, updatedAt: new Date(clock).toISOString() };
  const ops = inventoryTransaction(product, { stock: -1, sold: 1 }, new Date(clock).toISOString());
  const index = unmarshall(ops[2].Put!.Item!);
  assert.equal(index.product.status, "out_of_stock");
  assert.equal(index.product.stock, 0);
  assert.equal(index.product.soldCount, 1);
  assert.notDeepEqual(ops[1].Delete!.Key, marshall({ PK: index.PK, SK: index.SK }));
  assert.throws(() => inventoryTransaction(product, { stock: -2, sold: 0 }, new Date(clock).toISOString()));
});

test("SDK checkout hold/cancel preserve snapshot and duplicate request cannot deduct stock twice", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders();
  try {
    await orders.hold({ orderId: id, email, items, holdSeconds: 300 });
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 10);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.status, "low_stock");
    assert.equal((await orders.hold({ orderId: id, email, items, holdSeconds: 300 })).order.id, id);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 10);
    await orders.transition({ orderId: id, expectedCustomerEmail: email, status: "cancelled" });
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 12);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.status, "active");
    const indexes = db.rows().filter(row => row.entityType === "PRODUCT_CATEGORY_INDEX");
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0].product.version, 3);
  } finally { db.close(); }
});

test("SDK worker verifies durable payment, commits sold once and tolerates replay after refund", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders();
  try {
    await orders.hold({ orderId: id, email, items, holdSeconds: 300 });
    await orders.attachPayment(id, "NXtest", email, "https://gateway.example.test/pay");
    db.put({ ...initialPayment(), PK: "PAYMENT#NXtest", SK: "DETAIL", entityType: "PAYMENT_SESSION", status: "success" });
    const useCase = new ConfirmOrderPayment(orders, new DynamoPaymentSessions(), { async open() {} });
    const input = { orderId: id, email, txnRef: "NXtest", amount: 2000 };
    await assert.rejects(useCase.execute({ ...input, amount: 1 }), /not durable/);
    assert.equal((await useCase.execute(input)).changed, true);
    assert.equal((await useCase.execute(input)).changed, false);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.soldCount, 2);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 10);
    db.put({ ...db.get(`ORDER#${id}`), status: "refund_sent" });
    assert.equal((await useCase.execute(input)).changed, false);
  } finally { db.close(); }
});

test("expiry cannot release a recorded successful payment, including success racing with its transaction", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders();
  try {
    await orders.hold({ orderId: id, email, items, holdSeconds: 300 });
    await orders.attachPayment(id, "NXtest", email, "https://gateway.example.test/pay");
    db.put({ ...initialPayment(), PK: "PAYMENT#NXtest", SK: "DETAIL", status: "pending" });
    const future = new Date(Date.now() + 600000).toISOString();
    db.race(() => db.put({ ...db.get("PAYMENT#NXtest", "DETAIL"), status: "success" }));
    const expired = await orders.transition({ orderId: id, status: "expired", expiresBefore: future });
    assert.equal(expired.changed, false);
    assert.equal(db.get(`ORDER#${id}`)?.status, "awaiting_payment");
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 10);
    assert.equal((await orders.transition({ orderId: id, status: "expired", expiresBefore: future })).changed, false);
    await assert.rejects(orders.transition({ orderId: id, status: "cancelled" }), /Payment confirmed/);
  } finally { db.close(); }
});

test("late payment after release remains recorded and requires reconciliation without selling inventory", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders();
  try {
    await orders.hold({ orderId: id, email, items, holdSeconds: 300 });
    await orders.attachPayment(id, "NXtest", email, "https://gateway.example.test/pay");
    await orders.transition({ orderId: id, status: "expired", expiresBefore: new Date(Date.now() + 600000).toISOString() });
    db.put({ ...initialPayment(), PK: "PAYMENT#NXtest", SK: "DETAIL", status: "success" });
    await assert.rejects(new ConfirmOrderPayment(orders, new DynamoPaymentSessions(), { async open() {} }).execute({ orderId: id, email, txnRef: "NXtest", amount: 2000 }), /reconciliation required/);
    assert.equal(db.get("PAYMENT#NXtest", "DETAIL")?.status, "success");
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 12);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.soldCount, 0);
  } finally { db.close(); }
});

test("inventory version race rolls back order and index changes", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders();
  try {
    db.race(() => db.put({ ...db.get(`PRODUCT#${productId}`, "DETAIL"), version: 2, stock: 11 }));
    await assert.rejects(orders.hold({ orderId: id, email, items, holdSeconds: 300 }));
    assert.equal(db.get(`ORDER#${id}`), undefined);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 11);
    assert.equal(db.rows().filter(row => row.entityType === "PRODUCT_CATEGORY_INDEX").length, 0);
  } finally { db.close(); }
});

test("queued finalization retry after effect failure reuses the order and never sells twice", async () => {
  const db = transport(rawDb);
  let attempts = 0;
  const useCase = new FinalizeOrder(new DynamoOrderFinalization(), { async succeeded() {
    if (++attempts === 1) throw new Error("notification unavailable"); }, async failed() { throw new Error("unexpected failure"); } });
  try {
    await assert.rejects(useCase.execute(email, items, id), /notification unavailable/);
    const result = await useCase.execute(email, items, id);
    assert.equal(result.orderId, id);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 10);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.soldCount, 2);
    await assert.rejects(useCase.execute("other@example.test", items, id), /another order/);
    await assert.rejects(useCase.execute(email, items), /requestId/);
  } finally { db.close(); }
});

test("compiled HTTP checkout -> signed return/IPN -> actual payment worker keeps contracts and replay safety", async () => {
  const { NestFactory } = await import("@nestjs/core");
  const { FastifyAdapter } = await import("@nestjs/platform-fastify");
  const { StorefrontModule } = await import("../dist/src/modules/storefront/storefront.module.js");
  const { NotificationsService } = await import("../dist/src/modules/notifications/notifications.service.js");
  const { RuntimeConfigService } = await import("../dist/src/config/runtime-config.service.js");
  const { AppExceptionFilter } = await import("../dist/src/common/filters/app-exception.filter.js");
  const { rawDb: compiledDb } = await import("../dist/src/database/dynamodb/client.js");
  const { identityConfig: env } = await import("../dist/src/config/identity-config.js");
  const db = transport(compiledDb), previous = env.AUTH_ALLOW_UNVERIFIED_JWT;
  env.AUTH_ALLOW_UNVERIFIED_JWT = true;
  const app = await NestFactory.create(StorefrontModule, new FastifyAdapter(), { logger: false });
  const events: Array<Record<string, unknown>> = [];
  app.get(RuntimeConfigService).getPaymentConfig = () => ({ vnpayTmnCode: "TEST", vnpayHashSecret: "test-secret",
    vnpayPaymentUrl: "https://gateway.example.test/pay", vnpayReturnUrl: "https://shop.example.test/return", vnpayIpnUrl: "https://shop.example.test/ipn" });
  const notifications = app.get(NotificationsService);
  notifications.publishPaymentCompletedEvent = async (event: any) => { events.push(event); return { queued: true } as any; };
  notifications.publishAuditLog = async () => ({ queued: true } as any);
  notifications.createPendingNotification = async () => ({}) as any;
  // Email delivery is outside this test; exercise the worker orchestration.
  (notifications as any).queueOrderConfirmationEmailSafely = async () => {};
  app.useGlobalFilters(new AppExceptionFilter());
  try {
    await app.init(); const http = app.getHttpAdapter().getInstance(); await http.ready();
    const token = `Bearer header.${Buffer.from(JSON.stringify({ sub: "u1", email, role: "customer" })).toString("base64url")}.signature`;
    const response = await http.inject({ method: "POST", url: "/api/storefront/orders", headers: { authorization: token }, payload: { requestId: id, items } });
    assert.equal(response.statusCode, 202, response.body);
    const checkout = response.json(), paymentUrl = new URL(checkout.paymentUrl);
    const txnRef = paymentUrl.searchParams.get("vnp_TxnRef")!;
    assert.equal(checkout.totalAmount, 2000);
    const replay = await http.inject({ method: "POST", url: "/api/storefront/orders", headers: { authorization: token }, payload: { requestId: id, items } });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().paymentUrl, checkout.paymentUrl);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 10);
    const params = { vnp_TmnCode: "TEST", vnp_TxnRef: txnRef, vnp_Amount: "200000", vnp_ResponseCode: "00",
      vnp_TransactionStatus: "00", vnp_TransactionNo: "123", vnp_BankCode: "TEST", vnp_PayDate: "20261020080000" };
    const query = (changes = {}) => { const values = { ...params, ...changes }; return new URLSearchParams({ ...values, vnp_SecureHash: signVnpayParams(values, "test-secret") }).toString(); };
    const returned = await http.inject({ method: "GET", url: `/api/payments/vnpay/return?${query()}` });
    assert.equal(returned.json().transactionStatus, "pending");
    assert.equal(returned.headers["cache-control"], "no-store");
    assert.equal(events.length, 0);
    assert.equal(db.get(`PAYMENT#${txnRef}`, "DETAIL")?.status, "pending");
    const invalid = await http.inject({ method: "GET", url: `/api/payments/vnpay/ipn?${query()}&vnp_SecureHash=invalid` });
    assert.equal(invalid.json().RspCode, "97");
    assert.equal((await http.inject({ method: "GET", url: `/api/payments/vnpay/ipn?${query({ vnp_TmnCode: "OTHER" })}` })).json().RspCode, "99");
    assert.equal((await http.inject({ method: "GET", url: `/api/payments/vnpay/ipn?${query({ vnp_Amount: "100" })}` })).json().RspCode, "04");
    assert.equal((await http.inject({ method: "GET", url: `/api/payments/vnpay/ipn?${query()}` })).json().RspCode, "00");
    assert.equal((await http.inject({ method: "GET", url: `/api/payments/vnpay/ipn?${query()}` })).json().RspCode, "02");
    assert.equal(events.length, 1);
    const record = { messageId: "event-1", body: JSON.stringify({ detail: { type: "payment.completed", ...events[0] } }) };
    const result = await notifications.processQueueRecords([record]);
    assert.deepEqual(result.failedMessageIds, []);
    assert.equal(db.get(`ORDER#${id}`)?.status, "paid");
    assert.deepEqual((await notifications.processQueueRecords([record])).failedMessageIds, []);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.soldCount, 2);
    assert.equal(db.rows().filter(row => row.entityType === "PRODUCT_CATEGORY_INDEX").length, 1);
  } finally { db.close(); env.AUTH_ALLOW_UNVERIFIED_JWT = previous; await app.close(); }
});

test("compiled workflow retries reuse one held order/session and the committed price, without selling before IPN", async () => {
  const { createStandaloneContext } = await import("../dist/src/core/app/create-standalone-context.js");
  const { RuntimeConfigService } = await import("../dist/src/config/runtime-config.service.js");
  const { NotificationsService } = await import("../dist/src/modules/notifications/notifications.service.js");
  const { rawDb: compiledDb } = await import("../dist/src/database/dynamodb/client.js");
  const orderStep = await import("../dist/src/entrypoints/lambda/workflow/order-workflow-step.js");
  const paymentStep = await import("../dist/src/entrypoints/lambda/workflow/payment-workflow-step.js");
  const context = await createStandaloneContext(), db = transport(compiledDb);
  const config = context.get(RuntimeConfigService), oldConfig = config.getPaymentConfig;
  const notifications = context.get(NotificationsService), oldAudit = notifications.publishAuditLog;
  config.getPaymentConfig = () => ({ vnpayTmnCode: "TEST", vnpayHashSecret: "test-secret",
    vnpayPaymentUrl: "https://gateway.example.test/pay", vnpayReturnUrl: "https://shop.example.test/return", vnpayIpnUrl: "https://shop.example.test/ipn" });
  notifications.publishAuditLog = async () => ({ queued: true } as any);
  try {
    const event = { detail: { email, requestId: id, items } };
    const result = await orderStep.handler(event);
    assert.equal(result.outcome, "success");
    const repeat = await orderStep.handler(event);
    assert.equal(repeat.orderId, result.orderId);
    assert.equal(db.get(`ORDER#${id}`)?.status, "awaiting_payment");
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.soldCount, 0);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 10);
    db.put({ ...db.get(`PRODUCT#${productId}`, "DETAIL"), price: 999999 });
    const payment = await paymentStep.handler({ detail: { email }, orderResult: result });
    assert.equal(payment.amount, 2000);
    assert.deepEqual(await paymentStep.handler({ detail: { email }, orderResult: repeat }), payment);
    assert.equal(db.rows().filter(row => row.entityType === "PAYMENT_SESSION").length, 1);
    await assert.rejects(paymentStep.handler({ detail: { email: "other@example.test" }, orderResult: result }), /not found/);
  } finally { db.close(); config.getPaymentConfig = oldConfig; notifications.publishAuditLog = oldAudit; }
});

test("payment reconciliation and expiry jobs preserve cached context and per-invocation audit identity", async () => {
  const { createStandaloneContext } = await import("../dist/src/core/app/create-standalone-context.js");
  const { RecoverPayments: PaymentJob } = await import("../dist/src/modules/vnpay/application/recover-payments.js");
  const { ExpireOrders: ExpiryJob } = await import("../dist/src/modules/storefront/application/expire-orders/expire-orders.js");
  const { auditContext } = await import("../dist/src/modules/audit-log/audit-context.js");
  const payment = await import("../dist/src/entrypoints/lambda/jobs/reconcile-payment-events.js");
  const expiry = await import("../dist/src/entrypoints/lambda/jobs/release-expired-orders.js");
  const context = await createStandaloneContext(), requests: string[] = [];
  const paymentJob = context.get(PaymentJob), expiryJob = context.get(ExpiryJob);
  const oldPayment = paymentJob.execute, oldExpiry = expiryJob.execute, close = context.close;
  let closes = 0;
  context.close = async () => { closes++; };
  paymentJob.execute = async () => { requests.push(auditContext.getStore()!.auditRequestId!); return { checked: 0, recovered: 0, failed: 0 }; };
  expiryJob.execute = async () => { requests.push(auditContext.getStore()!.auditRequestId!); return { ok: true, releasedCount: 0, failed: 0, checkedAt: "now" }; };
  try {
    await payment.handler({}, { awsRequestId: "p1" }); await payment.handler({}, { awsRequestId: "p2" });
    await expiry.handler({}, { awsRequestId: "e1" }); await expiry.handler({}, { awsRequestId: "e2" });
    assert.deepEqual(requests, ["p1", "p2", "e1", "e2"]);
    assert.equal(closes, 0); assert.equal(auditContext.getStore(), undefined);
  } finally { paymentJob.execute = oldPayment; expiryJob.execute = oldExpiry; context.close = close; await context.close(); }
});
