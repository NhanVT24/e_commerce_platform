import assert from "node:assert/strict";
import { test } from "node:test";
import { checkoutFixture } from "./helpers/checkout-fixture.js";
import { CreateCheckout } from "../src/modules/storefront/application/create-checkout/create-checkout.js";
import { WorkflowCheckout, ReadWorkflowPayment } from "../src/modules/storefront/application/workflow-checkout/workflow-checkout.js";
import { InsufficientOrderStock, type OrderFinalizationEffects } from "../src/modules/storefront/application/ports/order-finalization-ports.js";
import { BuildWeeklyRevenue } from "../src/modules/storefront/application/weekly-revenue.js";
import { DeliverWeeklyRevenue } from "../src/modules/storefront/application/deliver-weekly-revenue.js";
import { ManagedProducts } from "../src/modules/shopping/application/managed-products.js";
import { AuditQueries, type AuditIdentity, type AuditReadPort } from "../src/modules/audit-log/application/audit-queries.js";
import { CleanupData, type CleanupStore } from "../src/modules/data-cleanup/application/cleanup-data.js";

function workflowFixture() {
  const f = checkoutFixture();
  f.order.paymentTxnRef = undefined;
  f.newOrderRequest();
  const effects: OrderFinalizationEffects = {
    async succeeded() { assert.fail("Checkout must not finalize inventory before confirmed payment"); },
    async failed(email, items, requestId, reason) {
      f.events.push("failed");
      assert.equal(email, f.order.customerEmail);
      assert.deepEqual(items, [{ productId: "product-1", quantity: 2 }]);
      assert.equal(requestId, f.order.id);
      assert.match(reason, /Insufficient stock/);
    }
  };
  const checkout = new CreateCheckout(f.orders, {
    async create(input) {
      f.events.push("payment");
      assert.equal(input.orderId, "order-1");
      assert.equal(input.amount, 2000);
      assert.equal(input.expiresAt, f.order.lockedUntil);
      return { paymentUrl: "https://payment.example.test/pay", txnRef: "payment-1" };
    }
  }, { error() {} }, () => { throw new Error("Workflow must reuse its requestId"); });
  return { ...f, effects, flow: new WorkflowCheckout(checkout, effects),
    execute() { return this.flow.execute(f.order.customerEmail, [{ productId: "product-1", quantity: 2 }], f.order.id); } };
}

test("checkout workflow creates a held order and payment before returning workflow output", async () => {
  const f = workflowFixture();
  const result = await f.execute();
  assert.deepEqual(f.events, ["hold", "payment", "attach"]);
  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") assert.fail("Expected success");
  assert.equal(result.status, "awaiting_payment");
  assert.equal(result.requestId, "order-1");
  assert.equal(result.customer, "customer@example.test");
  assert.equal(result.itemCount, 1);
  assert.equal(result.paymentUrl, "https://payment.example.test/pay");
});

test("checkout workflow rejects a missing stable identity before any write", async () => {
  const f = workflowFixture();
  await assert.rejects(f.flow.execute(f.order.customerEmail, [], ""), { code: "INVALID_INPUT" });
  assert.deepEqual(f.events, []);
});

test("checkout workflow converts only insufficient stock into a business failure", async () => {
  const f = workflowFixture();
  f.orders.create = async () => { throw new InsufficientOrderStock("Sold out"); };
  const result = await f.execute();
  assert.equal(result.outcome, "failed");
  assert.equal(result.orderId, "");
  assert.deepEqual(f.events, ["failed"]);
});

test("checkout workflow propagates storage errors without reporting an out-of-stock outcome", async () => {
  const f = workflowFixture(), failure = new Error("database unavailable");
  f.orders.create = async () => { throw failure; };
  await assert.rejects(f.execute(), error => error === failure);
  assert.deepEqual(f.events, []);
});

test("checkout workflow does not acknowledge an undelivered failure effect", async () => {
  const f = workflowFixture(), failure = new Error("failure event unavailable");
  f.orders.create = async () => { throw new InsufficientOrderStock("Sold out"); };
  f.effects.failed = async () => { throw failure; };
  await assert.rejects(f.execute(), error => error === failure);
});

test("workflow payment read hides foreign and absent orders and strips customer identity", async () => {
  const payment = { customerEmail: "owner@example.test", paymentUrl: "signed", txnRef: "txn", amount: 2000, orderInfo: "Order", expiresAt: "later" };
  const flow = new ReadWorkflowPayment({ async find() { return payment; } });
  await assert.rejects(flow.execute("other@example.test", "order"), { code: "NOT_FOUND" });
  const { customerEmail: _email, ...publicPayment } = payment;
  assert.deepEqual(await flow.execute(payment.customerEmail, "order"), { ...publicPayment, timeoutMinutes: 5 });
  await assert.rejects(new ReadWorkflowPayment({ async find() { return null; } }).execute(payment.customerEmail, "missing"), { code: "NOT_FOUND" });
});

test("weekly revenue workflow builds a real summary then delivers it once", async () => {
  const summary = await new BuildWeeklyRevenue({ async list() { return [{ id: "order", customerEmail: "customer@example.test", status: "paid", totalAmount: 2000,
    createdAt: "2026-10-21T12:00:00Z", items: [{ productId: "p", productName: "Product", quantity: 2, lineTotal: 2000 }] }]; } })
    .execute(new Date("2026-10-22T00:00:00Z"));
  let sends = 0;
  const delivery = new DeliverWeeklyRevenue({ async send(input) {
    sends++; assert.equal(input.totalRevenue, 2000); assert.equal(input.orderCount, 1);
    assert.equal(input.topProducts[0].quantity, 2);
  } });
  assert.deepEqual(await delivery.execute(summary), { sent: true, mailType: "weekly-revenue-report" });
  assert.equal(sends, 1);
});

test("weekly revenue provider timeout propagates without an unsafe automatic resend", async () => {
  const summary = await new BuildWeeklyRevenue({ async list() { return []; } }).execute(new Date("2026-10-22T00:00:00Z"));
  const failure = new Error("provider response lost"); let sends = 0;
  const flow = new DeliverWeeklyRevenue({ async send() { sends++; throw failure; } });
  await assert.rejects(flow.execute(summary), error => error === failure);
  assert.equal(sends, 1);
});

test("managed product ownership filters mixed-owner candidates and handles an empty result", async () => {
  const flow = new ManagedProducts({ async list() { return []; }, async all() { return []; }, async cursor() { return []; }, async find() { return null; },
    async ownedCandidates() { return [{ ownerId: "owner", item: { id: "mine" } }, { ownerId: "other", item: { id: "private" } }]; } });
  assert.deepEqual(await flow.owned("owner"), { items: [{ id: "mine" }] });
  assert.deepEqual(await flow.owned("absent"), { items: [] });
});

function auditFixture() {
  const items: AuditIdentity[] = [
    { resourceType: "USER", resourceId: "owner", actor: { type: "ADMIN", id: "admin" } },
    { resourceType: "ORDER", resourceId: "order", actor: { type: "USER", id: "owner" } },
    { resourceType: "ORDER_ITEM", resourceId: "line", parentResourceId: "order", actor: { type: "SYSTEM", id: "worker" } }
  ];
  const userReads: string[] = [], orderReads: string[][] = [];
  const reads: AuditReadPort<AuditIdentity> = {
    async list() { return { items, nextCursor: "next-page" }; }, async get() { return items[1]; },
    async userEmail(subject) { userReads.push(subject); return subject === "owner" ? "owner@example.test" : undefined; },
    async orderEmails(ids) { orderReads.push(ids); return new Map([["order", "buyer@example.test"]]); }
  };
  return { items, reads, userReads, orderReads, flow: new AuditQueries(reads) };
}

test("audit enrichment deduplicates identities, resolves parent orders and preserves cursor without mutating source", async () => {
  const f = auditFixture();
  const page = await f.flow.list({ cursor: "previous", limit: 3 });
  assert.equal(page.nextCursor, "next-page");
  assert.deepEqual(f.userReads.sort(), ["admin", "owner"]);
  assert.deepEqual(f.orderReads, [["order"]]);
  assert.equal(page.items[0].ownerEmail, "owner@example.test");
  assert.equal(page.items[1].ownerEmail, "buyer@example.test");
  assert.equal(page.items[2].ownerEmail, "buyer@example.test");
  assert.equal(page.items[0].actor.email, undefined);
  assert.equal(page.items[1].actor.email, "owner@example.test");
  assert.equal("email" in f.items[1].actor, false);
  assert.equal("ownerEmail" in f.items[1], false);
});

test("audit detail enriches the same ownership/actor fields as list", async () => {
  const f = auditFixture();
  const detail = await f.flow.detail({ pk: "audit", sk: "entry" });
  assert.equal(detail.ownerEmail, "buyer@example.test");
  assert.equal(detail.actor.email, "owner@example.test");
});

test("audit enrichment propagates lookup failures instead of reporting a misleading empty owner", async () => {
  const f = auditFixture(), failure = new Error("directory unavailable");
  f.reads.userEmail = async () => { throw failure; };
  await assert.rejects(f.flow.list({}), error => error === failure);
});

test("cleanup deletion failure never records successful completion", async () => {
  const failure = new Error("delete failed"); let completed = false, lists = 0;
  const store: CleanupStore<string> = { async tryStartDataCleanup() { return true; },
    async listCleanupCandidates() { lists++; return { candidates: ["candidate"], hasRemainingBacklog: false }; },
    async deleteCleanupCandidates() { throw failure; }, async markDataCleanupCompleted() { completed = true; } };
  await assert.rejects(new CleanupData(store).execute(new Date("2026-10-22T00:00:00Z")), error => error === failure);
  assert.equal(completed, false);
  assert.equal(lists, 1);
});
