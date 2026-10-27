import assert from "node:assert/strict";
import { test } from "node:test";
import { checkoutFixture } from "./helpers/checkout-fixture.js";
import { NotificationUseCases, type NotificationEvent } from "../src/modules/notifications/application/notifications.js";
import type { NotificationConfig, NotificationEffects, NotificationRecord } from "../src/modules/notifications/application/ports.js";
import { CompleteNotifiedOrder, type NotifiedOrders } from "../src/modules/notifications/application/complete-notified-order.js";
import { ConfirmOrderPayment } from "../src/modules/storefront/application/confirm-order-payment/confirm-order-payment.js";
import type { SettledPayments } from "../src/modules/storefront/application/ports/checkout-ports.js";
import type { PaymentReview } from "../src/modules/storefront/application/ports/payment-review.js";

const customer = "customer@example.test";
const principal = { email: "operator@example.test", role: "admin" as const };
function notification(id: string, email: string, extra: Partial<NotificationRecord> = {}): NotificationRecord {
  return { id, customerEmail: email, title: "Notice", message: "Message", channel: "system", status: "pending", isRead: false,
    createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", ...extra };
}

function setup(config: Partial<NotificationConfig> = {}) {
  const checkout = checkoutFixture();
  const rows = [notification("own", customer), notification("foreign", "foreign@example.test"),
    notification("admin", "legacy-admin@example.test", { metadata: { audience: "admin" } }),
    notification("configured", "reports@example.test", { isRead: true }), notification("operator", principal.email)];
  const events: string[] = [], published: Array<Parameters<NotificationEffects["publish"]>[0]> = [];
  const confirmations: Array<Parameters<NotificationEffects["orderConfirmation"]>[0]> = [];
  const reviews: PaymentReview[] = [], deleted: string[] = [];
  const legacy: NotifiedOrders = {
    async findById() { events.push("legacy:find"); return { customerEmail: customer, status: "pending" }; },
    async hasSentSystemNotification() { events.push("legacy:sent-check"); return true; },
    async completePending() { events.push("legacy:complete"); return true; }
  };
  const payments: SettledPayments = { async find() { return { status: "success", amount: 2000, email: customer, orderId: "order-1", paymentConfirmedAt: "2026-10-22T00:01:00Z" }; } };
  const effects: NotificationEffects = { newId: () => "test-notification",
    store: {
      async createNotification(entity) { events.push("create"); const input = entity.toSnapshot(); const row = notification(input.id, input.customerEmail, input); rows.push(row); return row; },
      async deleteNotification(id) { deleted.push(id); return true; }, async deleteNotifications(ids) { deleted.push(...ids); },
      async listAllNotifications() { return rows; }, async listNotificationsByCustomer(email) { return rows.filter(row => row.customerEmail === email); },
      async markNotificationAsRead(id) { events.push(`read:${id}`); }, async markNotificationAsSent(id) { events.push(`sent:${id}`); }
    },
    async findCheckout() { return { createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z" }; },
    async publish(input) { published.push(input); events.push(`publish:${input.detailType}`); return { eventId: "event", eventBusName: "bus" }; },
    async adminAlert() { events.push("admin-alert"); return { messageId: "alert", topicArn: "topic" }; },
    async orderConfirmation(input) { confirmations.push(input); events.push("confirmation"); return { status: "queued", emailJobId: "mail" }; },
    async paymentFailure() { events.push("failure-email"); }
  };
  const flow = new NotificationUseCases(new ConfirmOrderPayment(checkout.orders, payments, { async open(review) { reviews.push(review.toSnapshot()); } }),
    new CompleteNotifiedOrder(legacy), effects,
    { platformEventsEnabled: true, paymentEventsEnabled: true, commerceEventsEnabled: true, adminAlertsEnabled: true, adminEmail: "reports@example.test", ...config },
    { log() {}, warn() {}, error() {} });
  return { flow, effects, events, rows, published, deleted, legacy, checkout, payments, reviews, confirmations };
}

test("notification creation persists system messages before publishing their durable identity", async () => {
  const f = setup();
  const saved = await f.flow.createPendingNotification({ email: customer, title: "Title", message: "Message", channel: "system" });
  assert.deepEqual(f.events, ["create", "publish:notifications.pending"]);
  assert.equal(saved.status, "pending");
  assert.equal(f.published[0].detail.notificationId, saved.id);
  assert.equal(f.published[0].detail.email, customer);
});

test("notification creation rejects direct email delivery before any side effect", async () => {
  const f = setup();
  await assert.rejects(f.flow.createPendingNotification({ email: customer, title: "Title", message: "Message", channel: "email" }), /email route/);
  assert.deepEqual(f.events, []);
});

test("notification write failure never publishes an event", async () => {
  const f = setup(), failure = new Error("storage unavailable");
  f.effects.store.createNotification = async () => { throw failure; };
  await assert.rejects(f.flow.createPendingNotification({ email: customer, title: "T", message: "M", channel: "system" }), error => error === failure);
  assert.deepEqual(f.published, []);
});

test("notification event failure propagates after persistence without retrying the write", async () => {
  const f = setup(), failure = new Error("event response lost"); let attempts = 0;
  f.effects.publish = async () => { attempts++; throw failure; };
  await assert.rejects(f.flow.createPendingNotification({ email: customer, title: "T", message: "M", channel: "system" }), error => error === failure);
  assert.deepEqual(f.events, ["create"]);
  assert.equal(f.rows.length, 6);
  assert.equal(attempts, 1);
});

test("disabled platform bus still persists notification without attempting publication", async () => {
  const f = setup({ platformEventsEnabled: false });
  await f.flow.createPendingNotification({ email: customer, title: "T", message: "M", channel: "system" });
  assert.deepEqual(f.events, ["create"]);
});

test("admin notification list includes admin audience and configured mailbox but hides customer messages", async () => {
  const f = setup(), page = await f.flow.listForPrincipal(principal);
  assert.deepEqual(page.items.map(row => row.id), ["admin", "configured", "operator"]);
  assert.equal(page.pendingCount, 2);
});

test("customer cannot read or delete a foreign notification", async () => {
  const f = setup();
  await assert.rejects(f.flow.markAsRead(customer, "foreign"), { code: "NOT_FOUND" });
  await assert.rejects(f.flow.remove(customer, "foreign"), { code: "NOT_FOUND" });
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.deleted, []);
});

test("admin mutations apply the same audience boundary as listing", async () => {
  const f = setup();
  await assert.rejects(f.flow.markAsReadForPrincipal(principal, "foreign"), { code: "NOT_FOUND" });
  await assert.rejects(f.flow.removeForPrincipal(principal, "foreign"), { code: "NOT_FOUND" });
  await f.flow.markAsReadForPrincipal(principal, "admin");
  assert.deepEqual(f.events, ["read:admin"]);
  assert.deepEqual(await f.flow.removeAllForPrincipal(principal), { success: true, deletedCount: 3 });
  assert.deepEqual(f.deleted, ["admin", "configured", "operator"]);
});

test("customer bulk deletion targets only the authenticated customer's messages", async () => {
  const f = setup();
  assert.deepEqual(await f.flow.removeAllForPrincipal({ email: customer, role: "customer" }), { success: true, deletedCount: 1 });
  assert.deepEqual(f.deleted, ["own"]);
});

test("pending notification is marked sent before legacy completion is evaluated", async () => {
  const f = setup();
  const result = await f.flow.processEvent({ type: "notification.pending", notificationId: "own", metadata: { orderId: "legacy-order" } });
  assert.deepEqual(f.events, ["sent:own", "legacy:find", "legacy:sent-check", "legacy:complete"]);
  assert.ok(result && "orderCompleted" in result);
  assert.equal(result.orderCompleted, true);
});

test("notification without an order never attempts legacy completion", async () => {
  const f = setup();
  const result = await f.flow.processEvent({ type: "notification.pending", notificationId: "own" });
  assert.ok(result && "orderCompleted" in result);
  assert.equal(result.orderCompleted, false);
  assert.deepEqual(f.events, ["sent:own"]);
});

test("failed sent marker leaves event retryable and cannot complete its order", async () => {
  const f = setup(), failure = new Error("marker failed");
  f.effects.store.markNotificationAsSent = async () => { throw failure; };
  await assert.rejects(f.flow.processEvent({ type: "notification.pending", notificationId: "own", metadata: { orderId: "legacy" } }), error => error === failure);
  assert.deepEqual(f.events, []);
});

for (const payload of [{ type: "unknown" }, { type: "notification.pending" }, { type: "payment.completed" }, { type: "payment.failed" }] satisfies NotificationEvent[]) {
  test(`malformed/unsupported event ${payload.type} is ignored without side effects`, async () => {
    const f = setup();
    assert.equal(await f.flow.processEvent(payload), null);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.checkout.events, []);
  });
}

const paid: NotificationEvent = { type: "payment.completed", email: " Customer@Example.Test ", txnRef: "payment-1", requestId: "order-1", amount: 2000 };

test("payment notification verifies durable payment and commits order before downstream confirmation", async () => {
  const f = setup();
  f.effects.orderConfirmation = async input => {
    assert.deepEqual(f.checkout.events, ["transition:paid"]);
    f.confirmations.push(input); return { status: "queued", emailJobId: "mail" };
  };
  const result = await f.flow.processEvent(paid);
  assert.ok(result && "orderId" in result);
  assert.equal(result.orderId, "order-1");
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.confirmations[0].toEmail, customer);
  assert.equal(f.confirmations[0].paymentConfirmedAt, "2026-10-22T00:01:00Z");
  assert.deepEqual(f.confirmations[0].items, [{ productName: "Keyboard", quantity: 2, unitPrice: 1000, originalUnitPrice: undefined, lineTotal: 2000 }]);
});

test("payment sync failure propagates for queue retry without creating success notification or email", async () => {
  const f = setup(), failure = new Error("transaction failed");
  f.checkout.orders.transition = async () => { throw failure; };
  await assert.rejects(f.flow.processEvent(paid), error => error === failure);
  assert.equal(f.events.includes("create"), false);
  assert.deepEqual(f.confirmations, []);
  assert.equal(f.published[0].detail.eventType, "payments.vnpay.completed.sync_failed");
});

test("paid-after-release opens durable manual review without selling inventory or sending success email", async () => {
  const f = setup(); f.checkout.order.status = "expired";
  const result = await f.flow.processEvent(paid);
  assert.ok(result && "status" in result);
  assert.equal(result.status, "manual_review");
  assert.deepEqual(f.reviews, [{ txnRef: "payment-1", orderId: "order-1", amount: 2000, reason: "PAID_AFTER_RELEASE" }]);
  assert.deepEqual(f.checkout.events, []);
  assert.deepEqual(f.confirmations, []);
  assert.deepEqual(f.events, ["admin-alert"]);
});

test("post-commit email routing failure does not undo paid order or resend payment", async () => {
  const f = setup();
  f.effects.orderConfirmation = async () => { throw new Error("email route down"); };
  const result = await f.flow.processEvent(paid);
  assert.ok(result && "orderId" in result);
  assert.equal(result.orderId, "order-1");
  assert.deepEqual(f.checkout.events, ["transition:paid"]);
  assert.equal(f.published.at(-1)?.detail.eventType, "payments.vnpay.completed");
});

test("payment failure email outage still records system notification and failure audit", async () => {
  const f = setup();
  f.effects.paymentFailure = async () => { throw new Error("SES unavailable"); };
  const result = await f.flow.processEvent({ ...paid, type: "payment.failed", failureReason: "declined" });
  assert.ok(result && "failureReason" in result);
  assert.equal(result.failureReason, "declined");
  assert.equal(f.rows.at(-1)?.metadata?.paymentStatus, "failed");
  assert.equal(f.published.at(-1)?.detail.eventType, "payments.vnpay.failed");
  assert.deepEqual(f.checkout.events, []);
});

test("inventory alert persists an admin-only notification even if SNS is unavailable", async () => {
  const f = setup(); f.effects.adminAlert = async () => { throw new Error("SNS unavailable"); };
  const result = await f.flow.processEvent({ type: "inventory.stock.alert", productId: "product-1", productName: "Keyboard", stock: 0, previousStock: 2, status: "out_of_stock" });
  assert.ok(result && "alertLevel" in result);
  assert.equal(result.alertLevel, "out_of_stock");
  assert.equal(f.rows.at(-1)?.customerEmail, "reports@example.test");
  assert.equal(f.rows.at(-1)?.metadata?.audience, "admin");
  assert.equal(f.published.at(-1)?.detail.eventType, "inventory.stock.alerted");
});
