import { PaymentReview as PaymentReviewEntity } from "../src/modules/storefront/domain/payment-review.js";
import { holdCheckout, transitionCheckout, attachCheckout } from "./helpers/hold-checkout.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { RecoverPayments } from "../src/modules/vnpay/application/recover-payments.js";
import type { PaymentRecoveryQueue, PaymentRecoverySessions, RecoverablePayment } from "../src/modules/vnpay/application/ports/payment-recovery-ports.js";
import { PaymentProcessing } from "../src/modules/vnpay/application/payment-processing.js";
import { DynamoPaymentRecovery } from "../src/modules/vnpay/infrastructure/dynamo-payment-recovery.js";
import { VnpayStatusGateway } from "../src/modules/vnpay/infrastructure/vnpay-status-gateway.js";
import { VnpayPaymentLinkIssuer } from "../src/modules/vnpay/infrastructure/vnpay-payment-link-issuer.js";
import { DynamoPaymentReviews } from "../src/modules/storefront/infrastructure/persistence/dynamo-payment-reviews.js";
import { DynamoCheckoutOrders } from "../src/modules/storefront/infrastructure/persistence/dynamo-checkout-orders.js";
import { DynamoRefundOrders } from "../src/modules/storefront/infrastructure/persistence/dynamo-refund-orders.js";
import { CreateCheckout } from "../src/modules/storefront/application/create-checkout/create-checkout.js";
import { ConfirmOrderPayment } from "../src/modules/storefront/application/confirm-order-payment/confirm-order-payment.js";
import { PaymentReviewRequired } from "../src/modules/storefront/application/ports/payment-review.js";
import { ResumeCheckoutProvisioning } from "../src/modules/vnpay/infrastructure/checkout-provisioning.js";
import { DurableSettledPayments } from "../src/modules/vnpay/infrastructure/settled-payment-reader.js";
import { DynamoPaymentSessions } from "../src/modules/vnpay/infrastructure/dynamo-payment-sessions.js";
import { rawDb } from "../src/database/dynamodb/client.js";
import { transport } from "./helpers/payment-transport.js";

const email = "owner@example.test", id = "12345678-1234-4234-8234-123456789012";
const productId = "12345678-1234-4234-8234-123456789013", items = [{ productId, quantity: 2 }];
const config = { vnpayTmnCode: "TEST", vnpayHashSecret: "test-secret", vnpayPaymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  vnpayReturnUrl: "https://shop.example.test/return", vnpayIpnUrl: "https://shop.example.test/ipn" };
const log = { error() {} };
const now = Date.parse("2026-10-21T01:00:00.000Z");
const pending = (): RecoverablePayment => ({ txnRef: "NXtest", orderId: id, email, amount: 2000, orderInfo: "Order", status: "pending",
  createdAt: new Date(now - 120000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), transactionDate: "20261021075800" });
const callback = { txnRef: "NXtest", amountMinor: "200000", transactionStatus: "success" as const, gatewayTransactionStatus: "00",
  responseCode: "00", transactionNo: "123", bankCode: "TEST", payDate: "20261021080000" };

function fixture() {
  let session = pending(), queries = 0, dispatches = 0, resumes = 0, reviews = 0;
  const checkpoints: string[] = [];
  const queue: PaymentRecoveryQueue = { async page(lane) { return { ids: lane === "pending" ? [session.txnRef] : lane === "checkout" ? [id] : [], checkpoint: lane }; },
    async checkpoint(lane) { checkpoints.push(lane); } };
  const sessions: PaymentRecoverySessions = { async find() { return { ...session }; },
    async defer(_id, attempts, nextAt) { session = { ...session, recoveryAttempts: attempts, recoveryNextAt: nextAt }; } };
  const gateway = { async query() { queries++; return callback as typeof callback | null; } };
  const processing = { async confirm() { session.status = "success"; return { outcome: "confirmed" as const }; },
    async resumeDispatch() { dispatches++; } };
  const checkouts = { async resume() { resumes++; } };
  const writer = { async open() { reviews++; } };
  return { queue, sessions, gateway, processing, checkouts, writer, checkpoints,
    job: new RecoverPayments(queue, sessions, gateway, processing, checkouts, writer, log, () => now),
    stats: () => ({ queries, dispatches, resumes, reviews }), current: () => session,
    set(value: RecoverablePayment) { session = value; } };
}

test("recovery queries old pending sessions, persists backoff first and progresses all lanes", async () => {
  const f = fixture();
  f.gateway.query = async () => { assert.ok(f.current().recoveryNextAt); return callback; };
  assert.deepEqual(await f.job.execute(), { checked: 2, recovered: 2, failed: 0 });
  assert.equal(f.current().status, "success");
  assert.deepEqual(f.checkpoints, ["pending", "success", "failed", "checkout"]);
});

test("unknown/timeout provider results preserve pending and are not immediately retried", async () => {
  const f = fixture();
  f.gateway.query = async () => { throw new Error("timeout"); };
  assert.equal((await f.job.execute()).failed, 1);
  assert.equal(f.current().status, "pending");
  f.gateway.query = async () => { throw new Error("must not query during backoff"); };
  assert.equal((await f.job.execute()).failed, 0);
  const g = fixture(); g.gateway.query = async () => null;
  assert.equal((await g.job.execute()).failed, 0);
  assert.equal(g.current().status, "pending");
});

test("stale GSI terminal candidates are strong-read and dispatch failure remains retryable on wrap", async () => {
  const f = fixture();
  f.queue.page = async lane => ({ ids: lane === "success" ? ["NXtest"] : [], checkpoint: lane });
  assert.equal((await f.job.execute()).recovered, 1); // pending is queried from durable state
  f.set({ ...pending(), status: "success" });
  f.processing.resumeDispatch = async () => { throw new Error("publisher disabled"); };
  assert.equal((await f.job.execute()).failed, 1);
  assert.deepEqual(f.checkpoints.slice(-4), ["pending", "success", "failed", "checkout"]);
});

test("bounded provider budget leaves an interrupted page uncheckpointed; invalid budgets are rejected", async () => {
  const f = fixture(); let timestamp = now;
  f.queue.page = async lane => ({ ids: lane === "pending" ? ["a", "b"] : [], checkpoint: lane });
  f.gateway.query = async () => { timestamp += 5000; return callback; };
  const job = new RecoverPayments(f.queue, f.sessions, f.gateway, f.processing, f.checkouts, f.writer, log, () => timestamp);
  assert.equal((await job.execute(2, 1000)).checked, 1);
  assert.deepEqual(f.checkpoints, []);
  await assert.rejects(job.execute(11), /budget/);
});

test("long-running unconfirmed payment is escalated to durable manual review without inventing failure", async () => {
  const f = fixture(); f.set({ ...pending(), recoveryAttempts: 11 }); f.gateway.query = async () => null;
  await f.job.execute();
  assert.equal(f.stats().reviews, 1);
  assert.equal(f.current().status, "pending");
  const timedOut = fixture(); timedOut.set({ ...pending(), recoveryAttempts: 11 });
  timedOut.gateway.query = async () => { throw new Error("timeout"); };
  assert.equal((await timedOut.job.execute()).failed, 1);
  assert.equal(timedOut.stats().reviews, 1);
  assert.equal(timedOut.current().status, "pending");
});

test("durable checkpoints advance past filtered-empty pages and wrap, without a table scan", async () => {
  const db = transport(rawDb), queue = new DynamoPaymentRecovery();
  try {
    for (let i = 0; i < 4; i++) db.put({ PK: `PAYMENT#old${i}`, SK: "DETAIL", entityType: "PAYMENT_SESSION", txnRef: `old${i}`,
      status: "success", updatedAt: `2026-10-20T00:00:0${i}.000Z`, paymentEventEnqueuedAt: "done" });
    db.put({ PK: "PAYMENT#target", SK: "DETAIL", entityType: "PAYMENT_SESSION", txnRef: "target", status: "success", updatedAt: "2026-10-21T00:00:00.000Z" });
    const first = await queue.page("success", 2); assert.deepEqual(first.ids, []); await queue.checkpoint("success", first.checkpoint);
    const second = await queue.page("success", 2); assert.deepEqual(second.ids, []); await queue.checkpoint("success", second.checkpoint);
    const third = await queue.page("success", 2); assert.deepEqual(third.ids, ["target"]); await queue.checkpoint("success", third.checkpoint);
    assert.deepEqual((await queue.page("success", 2)).ids, []);
    // An overlapping job with an old revision cannot overwrite the winner.
    await queue.checkpoint("success", first.checkpoint);
    assert.equal(db.get("RECOVERY_CURSOR#payment#success", "DETAIL")?.revision, 3);
  } finally { db.close(); }
});

test("overlapping jobs can claim one provider-query attempt only", async () => {
  const db = transport(rawDb), sessions = new DynamoPaymentRecovery();
  try {
    db.put({ ...pending(), PK: "PAYMENT#NXtest", SK: "DETAIL", entityType: "PAYMENT_SESSION" });
    const results = await Promise.allSettled([sessions.defer("NXtest", 1, "later"), sessions.defer("NXtest", 1, "later")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(db.get("PAYMENT#NXtest", "DETAIL")?.status, "pending");
  } finally { db.close(); }
});

test("interrupted checkout provisioning resumes without deducting inventory twice and commits one session/link", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders(), issuer = new VnpayPaymentLinkIssuer(() => config);
  try {
    await holdCheckout(orders, { orderId: id, email, items, holdSeconds: 300, bankCode: "NCB", locale: "en" });
    const checkout = new CreateCheckout(orders, { create: input => issuer.issue(input, { ipAddress: "127.0.0.1", amount: input.amount,
      orderId: input.orderId, createdAt: new Date(), expiresAt: new Date(input.expiresAt) }) }, log, () => id);
    await new ResumeCheckoutProvisioning(checkout).resume(id);
    const held = db.get(`ORDER#${id}`)!;
    assert.ok(held.paymentTxnRef); assert.ok(held.paymentUrl);
    assert.equal(new URL(held.paymentUrl).searchParams.get("vnp_BankCode"), "NCB");
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 10);
    const replay = await checkout.execute(email, { requestId: id, items });
    assert.equal(replay.paymentUrl, held.paymentUrl);
    assert.equal(db.rows().filter(row => row.entityType === "PAYMENT_SESSION").length, 1);
  } finally { db.close(); }
});

test("concurrent issuers replay the atomic winner and never leave an orphan session", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders(), issuer = new VnpayPaymentLinkIssuer(() => config);
  try {
    const hold = await holdCheckout(orders, { orderId: id, email, items, holdSeconds: 300 });
    const detail = { ipAddress: "ip", amount: 2000, orderId: id, createdAt: new Date(), expiresAt: new Date(hold.order.lockedUntil) };
    const results = await Promise.all([issuer.issue({ email, items }, detail), issuer.issue({ email, items }, detail)]);
    assert.equal(results[0].txnRef, results[1].txnRef);
    assert.equal(results[0].paymentUrl, results[1].paymentUrl);
    assert.equal(db.rows().filter(row => row.entityType === "PAYMENT_SESSION").length, 1);
  } finally { db.close(); }
});

test("an expiry race rolls back both session and link, without returning a usable payment URL", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders(), issuer = new VnpayPaymentLinkIssuer(() => config);
  try {
    const hold = await holdCheckout(orders, { orderId: id, email, items, holdSeconds: 300 });
    db.race(() => db.put({ ...db.get(`ORDER#${id}`), status: "expired" }));
    await assert.rejects(issuer.issue({ email, items }, { ipAddress: "ip", amount: 2000, orderId: id,
      createdAt: new Date(), expiresAt: new Date(hold.order.lockedUntil) }));
    assert.equal(db.get(`ORDER#${id}`)?.paymentTxnRef, undefined);
    assert.equal(db.rows().filter(row => row.entityType === "PAYMENT_SESSION").length, 0);
  } finally { db.close(); }
});

test("ambiguous atomic commit response replays its durable session instead of creating another", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders(), issuer = new VnpayPaymentLinkIssuer(() => config);
  try {
    const held = await holdCheckout(orders, { orderId: id, email, items, holdSeconds: 300 });
    db.loseNextTransactionResponse();
    const payment = await issuer.issue({ email, items }, { amount: 2000, orderId: id, ipAddress: "ip",
      createdAt: new Date(), expiresAt: new Date(held.order.lockedUntil) });
    assert.equal(db.get(`ORDER#${id}`)?.paymentTxnRef, payment.txnRef);
    assert.equal(db.rows().filter(row => row.entityType === "PAYMENT_SESSION").length, 1);
  } finally { db.close(); }
});

test("refund recovery progresses past filtered-out paid orders on the existing entity index", async () => {
  const db = transport(rawDb), orders = new DynamoRefundOrders();
  try {
    for (let i = 0; i < 4; i++) db.put({ PK: `ORDER#old${i}`, SK: "ORDER", entityType: "ORDER", customerEmail: email,
      status: "paid", totalAmount: 2000, updatedAt: `2026-10-20T00:00:0${i}.000Z` });
    db.put({ PK: `ORDER#${id}`, SK: "ORDER", entityType: "ORDER", customerEmail: email, status: "refund_pending", totalAmount: 2000,
      paymentTxnRef: "NXtest", refundRequestId: "r1", updatedAt: "2026-10-21T00:00:00.000Z" });
    assert.deepEqual(await orders.listPending(2), []);
    assert.deepEqual(await orders.listPending(2), []);
    assert.equal((await orders.listPending(2))[0].id, id);
  } finally { db.close(); }
});

test("manual-review cursor is scoped, paginates and preserves independently resolved cases", async () => {
  const db = transport(rawDb), reviews = new DynamoPaymentReviews();
  try {
    for (const txnRef of ["NXa", "NXb"]) await reviews.open(PaymentReviewEntity.create({ txnRef, orderId: id, amount: 2000, reason: "PAID_AFTER_RELEASE" }));
    const first = await reviews.list(1);
    assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
    const second = await reviews.list(1, first.nextCursor!);
    assert.equal(second.items.length, 1); assert.notEqual(first.items[0].txnRef, second.items[0].txnRef);
    await assert.rejects(reviews.list(1, "invalid"));
    await reviews.resolve("NXa", "admin-1", "External refund verified", "refund-1");
    await reviews.open(PaymentReviewEntity.create({ txnRef: "NXa", orderId: id, amount: 2000, reason: "PAID_AFTER_RELEASE" }));
    assert.equal(db.get("PAYMENT_REVIEW#NXa", "DETAIL")?.status, "payment_review_resolved");
  } finally { db.close(); }
});

test("a later confirmed payment reopens an unconfirmed review and retains prior operator evidence", async () => {
  const db = transport(rawDb), reviews = new DynamoPaymentReviews();
  try {
    await reviews.open(PaymentReviewEntity.create({ txnRef: "NXtest", orderId: id, amount: 2000, reason: "PROVIDER_UNCONFIRMED" }));
    await reviews.resolve("NXtest", "admin-1", "No successful payment found at that time", "provider-query-123");
    await reviews.open(PaymentReviewEntity.create({ txnRef: "NXtest", orderId: id, amount: 2000, reason: "PAID_AFTER_RELEASE" }));
    const review = db.get("PAYMENT_REVIEW#NXtest", "DETAIL")!;
    assert.equal(review.status, "payment_review_open"); assert.equal(review.reason, "PAID_AFTER_RELEASE");
    assert.equal(review.resolvedBy, undefined);
    assert.equal(review.previousResolution.externalReference, "provider-query-123");
  } finally { db.close(); }
});

test("paid-after-release creates one durable review; a failed review write is never acknowledged", async () => {
  const db = transport(rawDb), orders = new DynamoCheckoutOrders(), reviews = new DynamoPaymentReviews();
  try {
    await holdCheckout(orders, { orderId: id, email, items, holdSeconds: 300 });
    await attachCheckout(orders, id, "NXtest", email, "https://gateway.test/pay");
    await transitionCheckout(orders, { orderId: id, status: "expired", expiresBefore: new Date(Date.now() + 600000).toISOString() });
    db.put({ ...pending(), status: "success", PK: "PAYMENT#NXtest", SK: "DETAIL", paidAt: new Date().toISOString() });
    const useCase = new ConfirmOrderPayment(orders, new DurableSettledPayments(), reviews);
    const input = { orderId: id, email, amount: 2000, txnRef: "NXtest" };
    await assert.rejects(useCase.execute(input), PaymentReviewRequired);
    await assert.rejects(useCase.execute(input), PaymentReviewRequired);
    assert.equal(db.rows().filter(row => row.entityType === "PAYMENT_REVIEW").length, 1);
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 12);
    await reviews.resolve("NXtest", "admin-1", "Provider refund verified", "provider-refund-123");
    await assert.rejects(reviews.resolve("NXtest", "admin-1", "duplicate", "ref"));
    assert.equal(db.get("PAYMENT_REVIEW#NXtest", "DETAIL")?.resolvedBy, "admin-1");
    const failed = new ConfirmOrderPayment(orders, new DurableSettledPayments(), { async open() { throw new Error("review store unavailable"); } });
    await assert.rejects(failed.execute(input), /review store unavailable/);
  } finally { db.close(); }
});

test("VNPay query signs requests and validates signed response identity, amount, type and status", async () => {
  const originalFetch = globalThis.fetch;
  let overrides: Record<string, string> = {}, invalidSignature = false;
  const fields = ["ResponseId", "Command", "ResponseCode", "Message", "TmnCode", "TxnRef", "Amount", "BankCode", "PayDate",
    "TransactionNo", "TransactionType", "TransactionStatus", "OrderInfo", "PromotionCode", "PromotionAmount"];
  globalThis.fetch = (async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    const ordered = ["RequestId", "Version", "Command", "TmnCode", "TxnRef", "TransactionDate", "CreateDate", "IpAddr", "OrderInfo"];
    const signed = createHmac("sha512", config.vnpayHashSecret).update(ordered.map(key => request[`vnp_${key}`]).join("|")).digest("hex");
    assert.equal(request.vnp_Command, "querydr"); assert.equal(request.vnp_SecureHash, signed);
    const response = { vnp_ResponseId: "response", vnp_Command: "querydr", vnp_ResponseCode: "00", vnp_Message: "OK", vnp_TmnCode: "TEST",
      vnp_TxnRef: "NXtest", vnp_Amount: "200000", vnp_BankCode: "TEST", vnp_PayDate: "20261021080000", vnp_TransactionNo: "123",
      vnp_TransactionType: "01", vnp_TransactionStatus: "00", vnp_OrderInfo: "Order", ...overrides } as Record<string, string>;
    response.vnp_SecureHash = createHmac("sha512", config.vnpayHashSecret).update(fields.map(key => response[`vnp_${key}`] ?? "").join("|")).digest("hex");
    if (invalidSignature) response.vnp_SecureHash = "0".repeat(128);
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof fetch;
  try {
    const gateway = new VnpayStatusGateway(() => config);
    assert.deepEqual(await gateway.query(pending()), callback);
    overrides = { vnp_Amount: "999" }; await assert.rejects(gateway.query(pending()), /correlation/);
    overrides = { vnp_TmnCode: "OTHER" }; await assert.rejects(gateway.query(pending()), /signed/);
    overrides = { vnp_TransactionType: "02" }; assert.equal(await gateway.query(pending()), null);
    overrides = { vnp_TransactionStatus: "01" }; assert.equal(await gateway.query(pending()), null);
    overrides = { vnp_ResponseCode: "91" }; assert.equal(await gateway.query(pending()), null);
    overrides = {}; invalidSignature = true; await assert.rejects(gateway.query(pending()), /signed/);
  } finally { globalThis.fetch = originalFetch; }
});

test("missing IPN recovery commits success then resumes event delivery after marker failure", async () => {
  const db = transport(rawDb), sessions = new DynamoPaymentSessions(); let publishes = 0, markerFails = true;
  const mark = sessions.markDispatched.bind(sessions);
  sessions.markDispatched = async ref => { if (markerFails) { markerFails = false; throw new Error("marker failed"); } await mark(ref); };
  const processing = new PaymentProcessing(sessions, { async publishCompleted() { publishes++; }, async publishFailed() {} }, { async release() {} }, log);
  try {
    db.put({ ...pending(), PK: "PAYMENT#NXtest", SK: "DETAIL", entityType: "PAYMENT_SESSION" });
    const queue = new DynamoPaymentRecovery();
    const job = new RecoverPayments(queue, queue, { async query() { return callback; } }, processing,
      { async resume() {} }, new DynamoPaymentReviews(), log, () => now);
    await job.execute();
    assert.equal(db.get("PAYMENT#NXtest", "DETAIL")?.status, "success");
    await job.execute();
    assert.ok(db.get("PAYMENT#NXtest", "DETAIL")?.paymentEventEnqueuedAt);
    assert.equal(publishes, 2);
  } finally { db.close(); }
});

test("compiled manual-review API enforces admin role and resolution records evidence without moving money", async () => {
  const { NestFactory } = await import("@nestjs/core"); const { FastifyAdapter } = await import("@nestjs/platform-fastify");
  const { PaymentRecoveryModule } = await import("../dist/src/modules/vnpay/payment-recovery.module.js");
  const { NotificationsService } = await import("../dist/src/modules/notifications/notifications.service.js");
  const { ConfirmOrderPayment: CompiledConfirm } = await import("../dist/src/modules/storefront/application/confirm-order-payment/confirm-order-payment.js");
  const { AppExceptionFilter } = await import("../dist/src/common/filters/app-exception.filter.js");
  const { rawDb: compiledDb } = await import("../dist/src/database/dynamodb/client.js");
  const { identityConfig: env } = await import("../dist/src/config/identity-config.js"); const previous = env.AUTH_ALLOW_UNVERIFIED_JWT;
  env.AUTH_ALLOW_UNVERIFIED_JWT = true;
  const db = transport(compiledDb), app = await NestFactory.create(PaymentRecoveryModule, new FastifyAdapter(), { logger: false });
  app.useGlobalFilters(new AppExceptionFilter());
  (app.get(NotificationsService) as any).publishAdminAlertSafely = async () => {};
  const token = (role: string) => `Bearer header.${Buffer.from(JSON.stringify({ sub: "admin-1", email, role })).toString("base64url")}.signature`;
  try {
    await app.init(); const http = app.getHttpAdapter().getInstance(); await http.ready();
    assert.equal((await http.inject({ method: "GET", url: "/api/admin/ops/payment-reviews" })).statusCode, 403);
    assert.equal((await http.inject({ method: "GET", url: "/api/admin/ops/payment-reviews", headers: { authorization: token("customer") } })).statusCode, 403);
    db.put({ PK: `ORDER#${id}`, SK: "ORDER", entityType: "ORDER", customerEmail: email, status: "expired", totalAmount: 2000, paymentTxnRef: "NXtest", lockedUntil: "old" });
    db.put({ ...pending(), PK: "PAYMENT#NXtest", SK: "DETAIL", status: "success", paidAt: new Date().toISOString() });
    const result = await app.get(NotificationsService).processQueueRecords([{ messageId: "m1", body: JSON.stringify({ type: "payment.completed", email,
      requestId: id, txnRef: "NXtest", amount: 2000 }) }]);
    assert.deepEqual(result.failedMessageIds, []);
    const listed = await http.inject({ method: "GET", url: "/api/admin/ops/payment-reviews", headers: { authorization: token("admin") } });
    assert.equal(listed.statusCode, 200); assert.equal(listed.json().items[0].reason, "PAID_AFTER_RELEASE");
    const resolved = await http.inject({ method: "POST", url: "/api/admin/ops/payment-reviews/NXtest/resolve", headers: { authorization: token("admin") },
      payload: { note: "External refund verified", externalReference: "provider-123" } });
    assert.equal(resolved.statusCode, 201, resolved.body);
    assert.equal(db.get(`ORDER#${id}`)?.status, "expired");
    assert.equal(db.get("PAYMENT#NXtest", "DETAIL")?.status, "success");
    assert.equal(db.get(`PRODUCT#${productId}`, "DETAIL")?.stock, 12);
    db.put({ ...db.get(`ORDER#${id}`), paymentTxnRef: "NXother" });
    db.put({ ...pending(), txnRef: "NXother", PK: "PAYMENT#NXother", SK: "DETAIL", status: "success" });
    (app.get(CompiledConfirm) as any).reviews.open = async () => { throw new Error("review store unavailable"); };
    (app.get(NotificationsService) as any).publishAuditLogSafely = async () => ({ queued: false });
    const failed = await app.get(NotificationsService).processQueueRecords([{ messageId: "m2", body: JSON.stringify({ type: "payment.completed", email,
      requestId: id, txnRef: "NXother", amount: 2000 }) }]);
    assert.deepEqual(failed.failedMessageIds, ["m2"]);
    assert.equal(db.get("PAYMENT_REVIEW#NXother", "DETAIL"), undefined);
  } finally { db.close(); env.AUTH_ALLOW_UNVERIFIED_JWT = previous; await app.close(); }
});
