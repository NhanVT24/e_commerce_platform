import { Order, type OrderData } from "../src/modules/storefront/domain/order.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import type { DynamoDBClient, TransactWriteItemsCommandInput, UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { CancelOrder } from "../src/modules/storefront/application/cancel-order/cancel-order.js";
import { RequestRefund } from "../src/modules/storefront/application/request-refund/request-refund.js";
import { RefreshRefundStatus } from "../src/modules/storefront/application/refresh-refund-status/refresh-refund-status.js";
import { ReconcilePendingRefunds } from "../src/modules/storefront/application/reconcile-pending-refunds/reconcile-pending-refunds.js";
import { RefundResolution } from "../src/modules/storefront/application/refund-resolution.js";
import { OrderActionError } from "../src/modules/storefront/application/order-action.error.js";
import type { RefundGateway, RefundNotifier, RefundOrderRepository, RefundOutcome, OrderOperationLogger } from "../src/modules/storefront/application/ports/order-lifecycle-ports.js";
import { isRefundEligible, REFUND_WINDOW_MS } from "../src/modules/storefront/domain/order-refund.js";
import { DynamoRefundOrders } from "../src/modules/storefront/infrastructure/persistence/dynamo-refund-orders.js";
import { DynamoOrderCancellation } from "../src/modules/storefront/infrastructure/persistence/dynamo-order-cancellation.js";
import { VnpayRefundGateway } from "../src/modules/storefront/infrastructure/payments/vnpay-refund-gateway.js";
import { rawDb } from "../src/database/dynamodb/client.js";
import { auditContext } from "../src/modules/audit-log/audit-context.js";

const now = Date.parse("2026-10-20T01:00:00.000Z");
const orderId = "order-1";
const email = "owner@example.test";
const paid = (): OrderData => ({ id: orderId, customerEmail: email, status: "paid", totalAmount: 2000,
  paymentTxnRef: "pay-1", paymentConfirmedAt: new Date(now - 60000).toISOString() });
const pending = (): OrderData => ({ ...paid(), status: "refund_pending", refundRequestId: "refund-1", refundStatus: "pending" });
const sent: RefundOutcome = { status: "refund_sent", gatewayStatus: "06", transactionNo: "99" };
const hasCode = (code: string) => (error: unknown) => error instanceof OrderActionError && error.code === code;

function fixture(initial: OrderData = paid()) {
  let order: OrderData | null = { ...initial };
  let sends = 0;
  const notices: Array<Parameters<RefundNotifier["send"]>[0]> = [];
  const events: string[] = [];
  const orders: RefundOrderRepository = {
    async findById() { return order ? new Order(order) : null; },
    async listPending() { return order ? [new Order(order)] : []; },
    async claim(claim) { const input = { ...claim.order, requestId: claim.order.refundRequestId };
      if (!order || order.status !== "paid" || order.refundRequestId || order.customerEmail !== input.customerEmail) {
        throw new OrderActionError("CONFLICT", "already claimed");
      }
      order = { ...order, status: "refund_pending", refundRequestId: input.requestId, refundStatus: "pending" };
    },
    async saveOutcome(entity) { const snapshot = entity; const input = { requestId: snapshot.refundRequestId, outcome: { status: snapshot.status, gatewayStatus: snapshot.refundStatus, transactionNo: snapshot.refundTransactionNo } };
      if (!order || order.refundRequestId !== input.requestId) throw new OrderActionError("CONFLICT", "request changed");
      if (order.status === "refund_sent" || order.status === "refund_rejected") return { order: new Order(order), changed: false };
      order = { ...order, status: input.outcome.status, refundStatus: input.outcome.gatewayStatus,
        refundTransactionNo: input.outcome.transactionNo };
      return { order: new Order(order), changed: true };
    }
  };
  const gateway: RefundGateway = {
    async findPayment() { return { reference: "pay-1", amount: 2000, status: "success", orderId }; },
    assertReady() {},
    async request() { sends++; return sent; },
    async query() { return sent; }
  };
  const notifier: RefundNotifier = { async send(notice) { notices.push(notice); } };
  const log: OrderOperationLogger = { warn(event) { events.push(event); }, error(event) { events.push(event); } };
  const resolution = new RefundResolution(orders, gateway, notifier, log);
  return { orders, gateway, notifier, notices, events, resolution,
    request: new RequestRefund(orders, gateway, resolution, log, () => "refund-1", () => now),
    refresh: new RefreshRefundStatus(orders, resolution),
    reconcile: new ReconcilePendingRefunds(orders, resolution, log),
    sends: () => sends, current: () => order, setOrder(value: OrderData | null) { order = value; } };
}

test("refund eligibility preserves the exact five-minute cutoff and paid requirements", () => {
  assert.equal(isRefundEligible(paid(), now), true);
  assert.equal(isRefundEligible({ ...paid(), paymentConfirmedAt: new Date(now - REFUND_WINDOW_MS).toISOString() }, now), false);
  assert.equal(isRefundEligible({ ...paid(), paymentConfirmedAt: "invalid" }, now), false);
  assert.equal(isRefundEligible({ ...paid(), status: "cancelled" }, now), false);
});

test("cancel verifies ownership and preserves released=false for repeated transitions", async () => {
  let order = { ...paid(), status: "awaiting_payment" as const } as OrderData;
  let releases = 0;
  const useCase = new CancelOrder({ async findById() { return new Order(order); }, async cancel() {
    const changed = order.status === "awaiting_payment";
    if (changed) { releases++; order = { ...order, status: "cancelled" }; }
    return { order: new Order(order), changed };
  } });
  await assert.rejects(useCase.execute("other@example.test", orderId), hasCode("NOT_FOUND"));
  assert.equal((await useCase.execute(email, orderId)).released, true);
  assert.equal((await useCase.execute(email, orderId)).released, false);
  assert.equal(releases, 1);
});

test("request claims before provider, reuses identity on repeat and notifies after successful persistence", async () => {
  const f = fixture();
  assert.equal((await f.request.execute(email, orderId)).status, "refund_sent");
  assert.equal(f.current()?.refundRequestId, "refund-1");
  assert.equal(f.sends(), 1);
  assert.equal(f.notices.length, 1);
  assert.equal((await f.request.execute(email, orderId)).status, "refund_sent");
  assert.equal(f.sends(), 1);
  assert.equal(f.notices.length, 1);
});

test("request rejects ownership/window/payment mismatch/config and competing claims before provider", async () => {
  const f = fixture();
  await assert.rejects(f.request.execute("other", orderId), hasCode("NOT_FOUND"));
  f.setOrder({ ...paid(), paymentConfirmedAt: new Date(now - REFUND_WINDOW_MS).toISOString() });
  await assert.rejects(f.request.execute(email, orderId), hasCode("CONFLICT"));
  f.setOrder(paid());
  f.gateway.findPayment = async () => ({ reference: "pay-1", amount: 9999, status: "success" });
  await assert.rejects(f.request.execute(email, orderId), hasCode("CONFLICT"));
  assert.equal(f.sends(), 0);
  const config = fixture();
  config.gateway.assertReady = () => { throw new OrderActionError("CONFLICT", "not configured"); };
  await assert.rejects(config.request.execute(email, orderId), hasCode("CONFLICT"));
  assert.equal(config.current()?.refundRequestId, undefined);
  const race = fixture();
  const results = await Promise.allSettled([race.request.execute(email, orderId), race.request.execute(email, orderId)]);
  assert.equal(race.sends(), 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
});

test("ambiguous provider timeout stays pending with the same identity; persistence failure never resends", async () => {
  const f = fixture();
  let attempts = 0;
  f.gateway.request = async () => { attempts++; throw new Error("timeout after provider accepted"); };
  assert.equal((await f.request.execute(email, orderId)).status, "refund_pending");
  assert.equal(f.current()?.refundRequestId, "refund-1");
  await f.request.execute(email, orderId);
  assert.equal(attempts, 1);
  assert.ok(f.events.includes("refund.provider_result_unknown"));
  const g = fixture();
  g.orders.saveOutcome = async () => { throw new Error("write unavailable"); };
  assert.equal((await g.request.execute(email, orderId)).status, "refund_pending");
  assert.equal(g.sends(), 1);
  assert.ok(g.events.includes("refund.persistence_failed"));
  assert.equal(g.notices.length, 0);
});

test("notification failure cannot turn a committed refund into pending or trigger a second provider call", async () => {
  const f = fixture();
  f.notifier.send = async () => { throw new Error("SES unavailable"); };
  assert.equal((await f.request.execute(email, orderId)).status, "refund_sent");
  assert.equal(f.sends(), 1);
  assert.ok(f.events.includes("refund.notification_failed"));
  assert.equal(f.events.includes("refund.provider_result_unknown"), false);
});

test("polling and scheduled reconciliation share one conditional winner and notification", async () => {
  const f = fixture(pending());
  const results = await Promise.all([f.refresh.execute(email, orderId), f.reconcile.execute()]);
  assert.equal(results[0].status, "refund_sent");
  assert.equal(f.current()?.status, "refund_sent");
  assert.equal(f.notices.length, 1);
  assert.equal(f.sends(), 0);
  await f.refresh.execute(email, orderId);
  assert.equal(f.notices.length, 1);
});

test("refresh preserves pending on query failure/null and reports invalid payment without sending", async () => {
  const f = fixture(pending());
  f.gateway.query = async () => { throw new Error("query timeout"); };
  assert.equal((await f.refresh.execute(email, orderId)).status, "refund_pending");
  f.gateway.query = async () => null;
  assert.equal((await f.refresh.execute(email, orderId)).status, "refund_pending");
  f.gateway.findPayment = async () => null;
  await assert.rejects(f.refresh.execute(email, orderId), hasCode("CONFLICT"));
  assert.equal(f.sends(), 0);
});

test("job skips stale terminal GSI candidates, bounds work and continues after an item failure", async () => {
  const f = fixture(pending());
  const other = { ...pending(), id: "order-2" };
  f.orders.listPending = async limit => { assert.equal(limit, 100); return [new Order(pending()), new Order(other)]; };
  f.orders.findById = async id => new Order(id === "order-2" ? { ...other, status: "refund_sent" } : pending());
  f.gateway.query = async () => { throw new Error("one query failed"); };
  assert.deepEqual(await f.reconcile.execute(500), { checked: 2, resolved: 0, failed: 1 });
  await assert.rejects(f.reconcile.execute(0), hasCode("INVALID_INPUT"));
});

function rawOrder(status = "paid"): Record<string, unknown> {
  return { PK: `ORDER#${orderId}`, SK: "ORDER", entityType: "ORDER", customerEmail: email,
    status, totalAmount: 2000, itemCount: 1, paymentTxnRef: "pay-1", paymentConfirmedAt: new Date(now - 60000).toISOString(),
    createdAt: new Date(now - 120000).toISOString(), updatedAt: new Date(now).toISOString(), lockedUntil: new Date(now + 60000).toISOString(),
    ...(status.startsWith("refund_") ? { refundRequestId: "refund-1", refundStatus: "pending" } : {}) };
}

/** In-process command model. Executes the real audit middleware, not DynamoDB expressions. */
function transport(client: DynamoDBClient) {
  let order: Record<string, unknown> | null = rawOrder();
  let product = { stock: 5, soldCount: 10, version: 1 };
  let failure: unknown;
  let beforeTransaction: (() => void) | undefined;
  const writes: Array<UpdateItemCommandInput | TransactWriteItemsCommandInput> = [];
  const session = { PK: "PAYMENT#pay-1", SK: "DETAIL", entityType: "PAYMENT_SESSION", txnRef: "pay-1",
    orderId, amount: 2000, status: "success", transactionNo: "123", transactionDate: "20261020075900",
    orderInfo: "Order", createdAt: "now", updatedAt: "now", expiresAt: "later" };
  const line = { PK: `ORDER#${orderId}`, SK: "ORDER_ITEM#p1", entityType: "ORDER_ITEM", orderId,
    productId: "p1", quantity: 2, customerEmail: email, productName: "Product", unitPrice: 1000, lineTotal: 2000 };
  const conditional = (index?: number) => Object.assign(new Error("condition failed"), index === undefined
    ? { name: "ConditionalCheckFailedException" } : { name: "TransactionCanceledException",
      CancellationReasons: [{ Code: index === 0 ? "ConditionalCheckFailed" : "None" }, { Code: index === 1 ? "ConditionalCheckFailed" : "None" }] });
  function check(update: UpdateItemCommandInput, index?: number) {
    const values = unmarshall(update.ExpressionAttributeValues!);
    if (!order) throw conditional(index);
    if (values[":paid"] && (order.status !== "paid" || order.refundRequestId || order.paymentConfirmedAt !== values[":paidAt"] ||
      String(order.paymentConfirmedAt) <= String(values[":cutoff"]) || order.customerEmail !== values[":customerEmail"])) throw conditional(index);
    if (values[":requestId"] && !values[":paid"] && (order.status !== "refund_pending" || order.refundRequestId !== values[":requestId"])) throw conditional(index);
    if (values[":awaitingPayment"] && (order.status !== "awaiting_payment" ||
      (values[":expectedCustomerEmail"] && values[":expectedCustomerEmail"] !== order.customerEmail))) throw conditional(index);
    return values;
  }
  function apply(values: Record<string, unknown>) {
    if (values[":paid"]) order = { ...order, status: "refund_pending", refundRequestId: values[":requestId"], refundStatus: "pending" };
    else order = { ...order, status: values[":status"],
      ...(values[":gatewayStatus"] ? { refundStatus: values[":gatewayStatus"], refundTransactionNo: values[":transactionNo"] } : {}) };
  }
  const recoveryCursors = new Map<string, Record<string, unknown>>();
  client.middlewareStack.add((_next, context) => async args => {
    const candidate = args.input as any;
    if (candidate.Key?.PK?.S?.startsWith("RECOVERY_CURSOR#")) {
      const pk = candidate.Key.PK.S;
      if (context.commandName === "GetItemCommand") return { response: {}, output: { $metadata: {},
        Item: recoveryCursors.has(pk) ? marshall(recoveryCursors.get(pk)!) : undefined } };
      const fields = unmarshall(candidate.ExpressionAttributeValues);
      recoveryCursors.set(pk, { cursor: fields[":cursor"], revision: fields[":revision"] });
      return { response: {}, output: { $metadata: {} } };
    }
    if (context.commandName === "GetItemCommand") {
      const input = args.input as { Key: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>; ConsistentRead: boolean };
      assert.equal(input.ConsistentRead, true);
      const key = unmarshall(input.Key);
      const record = String(key.PK).startsWith("PAYMENT#") ? session : String(key.PK).startsWith("PRODUCT#")
        ? { ...product, PK: "PRODUCT#p1", SK: "DETAIL", id: "p1", entityType: "PRODUCT", name: "Product", category: "Food", updatedAt: "2026-10-19T00:00:00.000Z" } : order;
      return { response: {}, output: { $metadata: {}, Item: record ? marshall(record, { removeUndefinedValues: true }) : undefined } };
    }
    if (context.commandName === "QueryCommand") {
      const query = args.input as { IndexName?: string };
      return { response: {}, output: { $metadata: {}, Items: query.IndexName ? (order ? [marshall(order, { removeUndefinedValues: true })] : []) : [marshall(line)] } };
    }
    writes.push(args.input as UpdateItemCommandInput);
    if (failure) { const error = failure; failure = undefined; throw error; }
    if (context.commandName === "UpdateItemCommand") apply(check(args.input as UpdateItemCommandInput));
    else {
      assert.equal(context.commandName, "TransactWriteItemsCommand");
      if (beforeTransaction) { const effect = beforeTransaction; beforeTransaction = undefined; effect(); }
      const input = args.input as TransactWriteItemsCommandInput;
      const values = check(input.TransactItems![0].Update!, 0);
      const stockWrite = input.TransactItems![1].Update!;
      assert.ok(stockWrite);
      const stockValues = unmarshall(stockWrite.ExpressionAttributeValues!);
      if (stockValues[":expectedVersion"] !== product.version) throw conditional(1);
      const indexRecord = unmarshall(input.TransactItems![3].Put!.Item!);
      assert.equal(indexRecord.product.stock, stockValues[":stock"]);
      assert.equal(indexRecord.product.soldCount, stockValues[":sold"]);
      assert.equal(indexRecord.product.status, stockValues[":status"]);
      assert.equal(indexRecord.product.version, stockValues[":version"]);
      apply(values);
      product = { stock: stockValues[":stock"], soldCount: stockValues[":sold"], version: stockValues[":version"] };
    }
    return { response: {}, output: { $metadata: {} } };
  }, { step: "initialize", priority: "low", name: "orderLifecycleTestTransport" });
  return { writes, session, order: () => order, product: () => product,
    setOrder(value: Record<string, unknown> | null) { order = value; session.status = value?.status === "awaiting_payment" ? "pending" : "success"; }, setFailure(value: unknown) { failure = value; },
    setProduct(value: typeof product) { product = value; }, race(effect: () => void) { beforeTransaction = effect; },
    close() { client.middlewareStack.remove("orderLifecycleTestTransport"); } };
}

test("Dynamo claim guards owner/window/request identity and refund restoration commits once with audit", async () => {
  const db = transport(rawDb);
  try {
    const orders = new DynamoRefundOrders();
    await assert.rejects(orders.claim({ order: new Order({ ...paid(), customerEmail: "other@example.test" }).claimRefund("spoofed", now), now }), hasCode("CONFLICT"));
    assert.equal(db.order()?.status, "paid");
    await orders.claim({ order: new Order({ ...paid(), customerEmail: email }).claimRefund("refund-1", now), now });
    assert.match((db.writes[0] as UpdateItemCommandInput).ConditionExpression!, /customerEmail = :customerEmail/);
    await assert.rejects(orders.claim({ order: new Order({ ...paid(), customerEmail: email }).claimRefund("other", now), now }), hasCode("CONFLICT"));
    await auditContext.run({ auditActorType: "USER", auditActorId: "owner", auditActorRole: "customer", auditSource: "REFUND_API", auditReason: "refund", auditRequestId: "r1" }, async () => {
      const results = await Promise.all([orders.saveOutcome(new Order(pending()).recordRefundOutcome(sent)), orders.saveOutcome(new Order(pending()).recordRefundOutcome(sent))]);
      assert.equal(results.filter(result => result.changed).length, 1);
    });
    assert.deepEqual(db.product(), { stock: 7, soldCount: 8, version: 2 });
    assert.equal(db.order()?.status, "refund_sent");
    const transaction = db.writes.find(write => "TransactItems" in write) as TransactWriteItemsCommandInput;
    assert.match(transaction.TransactItems![0].Update!.ConditionExpression!, /refundRequestId = :requestId AND #status = :pending/);
    const fields = unmarshall(transaction.TransactItems![0].Update!.ExpressionAttributeValues!);
    assert.equal(fields[":auditActorId"], "owner");
  } finally { db.close(); }
});

test("inventory failure rolls back terminal transition and is not a competing-order conflict", async () => {
  const db = transport(rawDb);
  db.setOrder(rawOrder("refund_pending"));
  db.setProduct({ stock: 5, soldCount: 0, version: 1 });
  try {
    await assert.rejects(new DynamoRefundOrders().saveOutcome(new Order(pending()).recordRefundOutcome(sent)),
      error => !(error instanceof OrderActionError));
    assert.equal(db.order()?.status, "refund_pending");
    assert.deepEqual(db.product(), { stock: 5, soldCount: 0, version: 1 });
    const rejected = await new DynamoRefundOrders().saveOutcome(new Order(pending()).recordRefundOutcome({ status: "refund_rejected", gatewayStatus: "09" }));
    assert.equal(rejected.order.status, "refund_rejected");
    assert.deepEqual(db.product(), { stock: 5, soldCount: 0, version: 1 });
  } finally { db.close(); }
});

test("Dynamo cancel releases once and a competing payment wins without double release", async () => {
  const db = transport(rawDb);
  db.setOrder(rawOrder("awaiting_payment"));
  try {
    const useCase = new CancelOrder(new DynamoOrderCancellation());
    assert.equal((await useCase.execute(email, orderId)).released, true);
    assert.equal((await useCase.execute(email, orderId)).released, false);
    assert.equal(db.product().stock, 7);
    db.setOrder(rawOrder("awaiting_payment"));
    db.race(() => db.setOrder(rawOrder("paid")));
    assert.equal((await useCase.execute(email, orderId)).released, false);
    assert.equal(db.product().stock, 7);
    const first = db.writes[0] as TransactWriteItemsCommandInput;
    assert.match(first.TransactItems![0].Update!.ConditionExpression!, /customerEmail = :expectedCustomerEmail/);
    db.setOrder(rawOrder("awaiting_payment"));
    db.race(() => db.setOrder({ ...rawOrder("awaiting_payment"), customerEmail: "other@example.test" }));
    await assert.rejects(useCase.execute(email, orderId), hasCode("NOT_FOUND"));
    assert.equal(db.product().stock, 7);
  } finally { db.close(); }
});

test("moved VNPay client still signs requests and rejects invalid signed responses", async () => {
  const db = transport(rawDb);
  const originalFetch = globalThis.fetch;
  const secret = "test-only-secret";
  let invalid = false;
  let responseAmount = "200000";
  let calls = 0;
  const config = { vnpayTmnCode: "TEST", vnpayHashSecret: secret, vnpayPaymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
    vnpayReturnUrl: "https://example.test/return", vnpayIpnUrl: "https://example.test/ipn" };
  globalThis.fetch = (async (_url, options) => {
    calls++;
    const request = JSON.parse(String(options?.body));
    assert.equal(request.vnp_TxnRef, "pay-1");
    const requestKeys = request.vnp_Command === "refund"
      ? ["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TransactionType", "vnp_TxnRef", "vnp_Amount", "vnp_TransactionNo", "vnp_TransactionDate", "vnp_CreateBy", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"]
      : ["vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TxnRef", "vnp_TransactionDate", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo"];
    assert.equal(request.vnp_SecureHash, createHmac("sha512", secret).update(requestKeys.map(key => request[key] ?? "").join("|")).digest("hex"));
    const fields: Record<string, string> = { vnp_ResponseId: "response-1", vnp_Command: request.vnp_Command,
      vnp_ResponseCode: "00", vnp_Message: "OK", vnp_TmnCode: "TEST", vnp_TxnRef: "pay-1", vnp_Amount: responseAmount,
      vnp_BankCode: "", vnp_PayDate: "", vnp_TransactionNo: "99", vnp_TransactionType: "02", vnp_TransactionStatus: "06", vnp_OrderInfo: "Refund" };
    const keys = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo"];
    if (request.vnp_Command === "querydr") keys.push("vnp_PromotionCode", "vnp_PromotionAmount");
    fields.vnp_SecureHash = invalid ? "0".repeat(128) : createHmac("sha512", secret).update(keys.map(key => fields[key] ?? "").join("|")).digest("hex");
    return new Response(JSON.stringify(fields), { status: 200 });
  }) as typeof fetch;
  try {
    const gateway = new VnpayRefundGateway(() => config);
    gateway.assertReady();
    assert.equal((await gateway.request({ orderId, requestId: "refund-1", paymentReference: "pay-1", amount: 2000 })).status, "refund_sent");
    assert.equal((await gateway.query({ paymentReference: "pay-1", amount: 2000, refundTransactionNo: "99" }))?.status, "refund_sent");
    invalid = true;
    await assert.rejects(gateway.request({ orderId, requestId: "refund-1", paymentReference: "pay-1", amount: 2000 }), /Invalid VNPAY refund response/);
    invalid = false;
    responseAmount = "999";
    await assert.rejects(gateway.request({ orderId, requestId: "refund-1", paymentReference: "pay-1", amount: 2000 }), /Invalid VNPAY refund response/);
    assert.equal(await gateway.query({ paymentReference: "pay-1", amount: 2000, refundTransactionNo: "99" }), null);
    assert.equal(calls, 5);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("compiled HTTP module wires cancel/refund/polling/job and keeps auth/error/response contracts", async () => {
  const { NestFactory } = await import("@nestjs/core");
  const { FastifyAdapter } = await import("@nestjs/platform-fastify");
  const { StorefrontModule } = await import("../dist/src/modules/storefront/storefront.module.js");
  const { VnpayRefundGateway: Gateway } = await import("../dist/src/modules/storefront/infrastructure/payments/vnpay-refund-gateway.js");
  const { RefundEmailNotifier } = await import("../dist/src/modules/storefront/infrastructure/notifications/refund-email-notifier.js");
  const { ReconcilePendingRefunds: Job } = await import("../dist/src/modules/storefront/application/reconcile-pending-refunds/reconcile-pending-refunds.js");
  const { RequestRefund: Request } = await import("../dist/src/modules/storefront/application/request-refund/request-refund.js");
  const { AppExceptionFilter } = await import("../dist/src/common/filters/app-exception.filter.js");
  const { AuditMutationInterceptor } = await import("../dist/src/modules/audit-log/audit-mutation.interceptor.js");
  const { rawDb: compiledDb } = await import("../dist/src/database/dynamodb/client.js");
  const { identityConfig: env } = await import("../dist/src/config/identity-config.js");
  const db = transport(compiledDb);
  const authFlag = env.AUTH_ALLOW_UNVERIFIED_JWT;
  env.AUTH_ALLOW_UNVERIFIED_JWT = true;
  const app = await NestFactory.create(StorefrontModule, new FastifyAdapter(), { logger: false });
  let sends = 0;
  let notices = 0;
  const gateway = app.get(Gateway);
  gateway.assertReady = () => {};
  gateway.request = async () => { sends++; return sent; };
  gateway.query = async () => sent;
  app.get(RefundEmailNotifier).send = async () => { notices++; };
  // Clock is an injected function; fix it to the fixture's business timestamp.
  (app.get(Request) as unknown as { now: () => number }).now = () => now;
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalInterceptors(new AuditMutationInterceptor());
  try {
    await app.init();
    const http = app.getHttpAdapter().getInstance();
    await http.ready();
    const token = (mail = email, role = "customer") => `Bearer header.${Buffer.from(JSON.stringify({ sub: "u1", email: mail, role })).toString("base64url")}.signature`;
    const post = (suffix: string, authorization = token()) => http.inject({ method: "POST", url: `/api/storefront/orders/${orderId}/${suffix}`, headers: { authorization } });
    assert.equal((await post("refund", "")).statusCode, 403);
    assert.equal((await post("refund", token(email, "viewer"))).statusCode, 403);
    assert.equal((await post("refund", token("other@example.test"))).statusCode, 404);
    db.setOrder(rawOrder("awaiting_payment"));
    const cancel = await post("cancel");
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().released, true);
    assert.equal((await post("cancel")).json().released, false);
    db.setOrder(rawOrder("paid"));
    const refund = await post("refund");
    assert.equal(refund.statusCode, 200);
    assert.equal(refund.json().status, "refund_sent");
    assert.equal(refund.json().refundStatus, "06");
    assert.equal(sends, 1);
    assert.equal((await post("refund")).json().status, "refund_sent");
    assert.equal(sends, 1);
    db.setOrder(rawOrder("refund_pending"));
    assert.equal((await post("refund/status")).json().status, "refund_sent");
    db.setOrder(rawOrder("refund_pending"));
    assert.deepEqual(await app.get(Job).execute(), { checked: 1, resolved: 1, failed: 0 });
    assert.equal(notices, 3);
    db.setOrder(rawOrder("awaiting_payment"));
    assert.equal((await post("refund")).statusCode, 409);
  } finally { db.close(); env.AUTH_ALLOW_UNVERIFIED_JWT = authFlag; await app.close(); }
});

test("scheduled handler reuses its cached context across warm invocations and isolates audit request IDs", async () => {
  const { createStandaloneContext } = await import("../dist/src/core/app/create-standalone-context.js");
  const { ReconcilePendingRefunds: Job } = await import("../dist/src/modules/storefront/application/reconcile-pending-refunds/reconcile-pending-refunds.js");
  const { auditContext: compiledAudit } = await import("../dist/src/modules/audit-log/audit-context.js");
  const { handler } = await import("../dist/src/entrypoints/lambda/jobs/reconcile-pending-refunds.js");
  const context = await createStandaloneContext();
  const job = context.get(Job);
  const originalExecute = job.execute;
  const originalClose = context.close;
  const requests: string[] = [];
  let closes = 0;
  context.close = async () => { closes++; };
  job.execute = async () => {
    assert.equal(compiledAudit.getStore()?.auditActorId, "lambda:reconcile-pending-refunds");
    requests.push(compiledAudit.getStore()?.auditRequestId ?? "");
    return { checked: 0, resolved: 0, failed: 0 };
  };
  try {
    await handler({}, { awsRequestId: "invocation-1" });
    await handler({}, { awsRequestId: "invocation-2" });
    assert.deepEqual(requests, ["invocation-1", "invocation-2"]);
    assert.equal(closes, 0);
    assert.equal(compiledAudit.getStore(), undefined);
  } finally {
    job.execute = originalExecute;
    context.close = originalClose;
    await context.close();
  }
});
