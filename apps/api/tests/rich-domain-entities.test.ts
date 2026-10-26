import assert from "node:assert/strict";
import { test } from "node:test";
import { Product, type ProductSnapshot } from "../src/modules/shopping/domain/product.js";
import { ProductMutationError } from "../src/modules/shopping/domain/product.error.js";
import { Order } from "../src/modules/storefront/domain/order.js";
import { OrderItems } from "../src/modules/storefront/domain/order-items.js";
import { Payment } from "../src/modules/vnpay/domain/payment-session.js";
import { PaymentDraft } from "../src/modules/vnpay/domain/payment-draft.js";
import { Campaign } from "../src/modules/sales/domain/sale-campaign.js";
import type { SaleCampaign } from "../src/modules/sales/domain/campaign.js";
import { UserAccount } from "../src/modules/customers/authorization/domain/user-account.js";
import { UserProfile, ProfileChange } from "../src/modules/customers/authorization/domain/user-profile.js";
import { EmailDelivery } from "../src/modules/email-deliveries/domain/email-delivery.js";
import { EmailRecipient } from "../src/modules/email-deliveries/domain/email-recipient.js";
import { EmailCampaign } from "../src/modules/email-deliveries/domain/email-campaign.js";
import { EmailRoute } from "../src/modules/email-deliveries/domain/email-route.js";
import { Notification } from "../src/modules/notifications/domain/notification.js";
import { RevenueReport } from "../src/modules/storefront/domain/revenue-report.js";
import { UploadScope } from "../src/modules/uploads/domain/upload-scope.js";
import { SignUpEmail } from "../src/modules/customers/authorization/domain/sign-up-email.js";
import { CreatePayment } from "../src/modules/vnpay/application/create-payment.js";

const snapshot: ProductSnapshot = { id: "product", ownerId: "owner", name: "Product", stock: 20, status: "active", version: 3, soldCount: 2 };
const now = Date.parse("2026-10-22T00:00:00Z");

test("Product rehydration creates real methods; snapshots do not share mutable entity state", () => {
  const input = { ...snapshot };
  const product = new Product(input);
  input.stock = 0;
  assert.equal(product.stock, 20);
  const serialized = JSON.parse(JSON.stringify(product.toSnapshot()));
  assert.equal(serialized.decreaseStock, undefined);
  const restored = new Product(serialized);
  assert.ok(restored instanceof Product);
  assert.equal(restored.decreaseStock(15).stock, 5);
  assert.equal(restored.stock, 20);
  assert.equal(restored.version, 3);
  const output = restored.toSnapshot(); Reflect.set(output, "stock", 0);
  assert.equal(restored.stock, 20);
});

test("Product construction copies data; necessary write invariants are explicit", () => {
  for (const patch of [{ stock: -1 }, { stock: NaN }, { soldCount: -1 }, { version: -1 }, { version: Infinity }]) {
    const raw = { ...snapshot, ...patch };
    const entity = new Product(raw);
    assert.ok(entity instanceof Product);
    assert.throws(() => entity.assertValidState(), { code: "INVALID_INPUT" });
    assert.throws(() => entity.update({ name: "Next" }), { code: "INVALID_INPUT" });
    assert.throws(() => entity.adjustCounter("stock", 1), { code: "INVALID_INPUT" });
    assert.throws(() => entity.changeInventory({ stock: 0, sold: 0 }), { code: "INVALID_INPUT" });
  }
  const valid = new Product(snapshot);
  assert.throws(() => valid.update({ soldCount: -1 }), { code: "INVALID_INPUT" });
  assert.equal(valid.soldCount, 2);
});

test("Product owns counter transitions, limits, ownership, version and alert decisions", () => {
  const product = new Product(snapshot);
  const low = product.decreaseStock(15);
  assert.equal(low.status, "low_stock");
  assert.equal(low.stockAlertSince(product)?.previousStock, 20);
  assert.equal(low.decreaseStock(1).stockAlertSince(low), null);
  assert.throws(() => low.decreaseStock(50), /Invalid inventory transition/);
  assert.equal(low.adjustCounter("stock", -50).stock, 0);
  assert.equal(new Product({ ...snapshot, stock: 999999 }).increaseStock(1).stock, 1000000);
  assert.equal(product.adjustCounter("soldCount", -10).soldCount, 0);
  for (const quantity of [-1, 1.5, NaN, Infinity]) assert.throws(() => product.decreaseStock(quantity), ProductMutationError);
  assert.throws(() => product.assertVersion(2), { code: "CONFLICT" });
  assert.throws(() => product.assertCanBeManagedBy({ subject: "other", isAdmin: false }), { code: "FORBIDDEN" });
  product.assertCanBeManagedBy({ subject: "admin", isAdmin: true });
  assert.throws(() => product.update({ stock: 1000000 }), { code: "INVALID_INPUT" });
  const exhaustedVersion = new Product({ ...snapshot, version: Number.MAX_SAFE_INTEGER });
  assert.throws(() => exhaustedVersion.update({ name: "Next" }), /version overflow/);
  assert.throws(() => exhaustedVersion.increaseStock(1), /version overflow/);
  assert.equal(product.stock, 20);
});

test("Inventory checkout changes reject overselling instead of applying the administrative clamp", () => {
  const product = new Product({ ...snapshot, stock: 3 });
  const sold = product.changeInventory({ stock: -3, sold: 3 });
  assert.equal(sold.stock, 0); assert.equal(sold.soldCount, 5);
  assert.throws(() => product.changeInventory({ stock: -4, sold: 0 }), /Invalid inventory transition/);
  assert.throws(() => product.changeInventory({ stock: -1, sold: 0 }, 3), /Invalid inventory transition/);
  assert.throws(() => product.changeInventory({ stock: 0, sold: -3 }), /Invalid inventory transition/);
  assert.equal(product.stock, 3); assert.equal(product.version, 3);
});

test("Order owns hidden ownership, refund window, correlation and pending claim state", () => {
  const order = new Order({ id: "order", customerEmail: "owner@test.com", status: "paid", totalAmount: 1000,
    paymentTxnRef: "payment", paymentConfirmedAt: new Date(now).toISOString() });
  assert.throws(() => order.assertOwnedBy("other@test.com"), { code: "NOT_FOUND" });
  assert.equal(order.isRefundEligibleAt(now + 299999), true);
  assert.equal(order.isRefundEligibleAt(now + 300000), false);
  assert.equal(order.matchesRefundPayment({ amount: 1000, status: "success", orderId: "other" }), false);
  assert.equal(order.matchesRefundPayment({ amount: 1000, status: "success", orderId: "order" }), true);
  const claimed = order.claimRefund("stable-refund-id", now);
  assert.equal(claimed.toSnapshot().refundRequestId, "stable-refund-id");
  assert.equal(claimed.refundResponse().status, "refund_pending");
  assert.equal(order.toSnapshot().status, "paid");
  assert.throws(() => order.claimRefund("late", now + 300000), { code: "CONFLICT" });
});

test("OrderItems normalize duplicates and isolate constructor/output arrays", () => {
  const lines = [{ productId: "PRODUCT#one", quantity: 2 }, { productId: "one", quantity: 3 }];
  const cart = OrderItems.create(lines); lines[0].quantity = 50;
  const output = cart.toSnapshot(); assert.deepEqual(output, [{ productId: "one", quantity: 5 }]);
  output[0].quantity = 50; assert.equal(cart.toSnapshot()[0].quantity, 5);
  assert.throws(() => OrderItems.create([{ productId: "one", quantity: 30 }, { productId: "one", quantity: 30 }]), /Maximum quantity/);
});

test("Payment rejects inconsistent outcomes and builds only final undispatched events", () => {
  const session = { txnRef: "payment", orderId: "order", email: "owner@test.com", orderInfo: "Order", amount: 1000,
    status: "success" as const, responseCode: "00", transactionNo: "123", gatewayTransactionStatus: "00" };
  const payment = new Payment(session);
  const callback = { txnRef: "payment", amountMinor: "100000", transactionStatus: "success" as const,
    responseCode: "00", transactionNo: "123", gatewayTransactionStatus: "00", bankCode: "", payDate: "" };
  assert.equal(payment.matchesAmount("100000"), true);
  assert.equal(payment.matchesAmount("999"), false);
  assert.equal(payment.matchesOutcome(callback), true);
  assert.equal(payment.matchesOutcome({ ...callback, transactionNo: "foreign" }), false);
  assert.equal(payment.dispatchEvent().requestId, "order");
  assert.equal(payment.failureRelease(), null);
  assert.equal(new Payment({ ...session, paymentEventEnqueuedAt: "sent" }).needsDispatch, false);
  assert.throws(() => new Payment({ ...session, status: "pending" }).dispatchEvent(), /non-final/);
  assert.equal(new Payment({ ...session, status: "failed", responseCode: "24" }).failureRelease()?.cancelled, true);
});

test("PaymentDraft owns supported amount, duplicate quantities and expiration", () => {
  const draft = new PaymentDraft([{ productId: "one", quantity: 2 }, { productId: "one", quantity: 3 }]);
  assert.deepEqual(draft.quantities(), [["one", 5]]);
  assert.equal(draft.lineAmount("one", { price: 200, stock: 5 }), 1000);
  assert.throws(() => draft.lineAmount("one", { name: "One", price: 200, stock: 4 }), /Insufficient stock/);
  assert.equal(draft.amount(1000, 2000), 2000);
  assert.throws(() => draft.amount(0), /positive integer/);
  assert.throws(() => draft.expiresAt(new Date(now), new Date(now).toISOString()), /expired/);
  assert.equal(draft.expiresAt(new Date(now)).getTime(), now + 300000);
});

test("Campaign owns editable states, removal and late schedule decisions", () => {
  const data: SaleCampaign = { id: "sale", name: "Sale", campaignStatus: "scheduled", discountPercent: 10,
    productIds: ["one"], startAt: new Date(now + 120000).toISOString(), endAt: new Date(now + 240000).toISOString(),
    startScheduleName: "start", endScheduleName: "end", version: 1, createdAt: "", updatedAt: "" };
  const campaign = new Campaign(data); data.productIds.push("external");
  assert.deepEqual(campaign.removeProduct("one").productIds, []);
  assert.equal(campaign.removeProduct("one").closed, true);
  assert.equal(campaign.scheduledTransition("start", now + 240000)?.to, "ended");
  assert.throws(() => new Campaign({ ...data, campaignStatus: "ended" }).removeProduct("one"), /Only scheduled or active/);
  assert.throws(() => Campaign.assertCreation({ ...data, startAt: "invalid" }, now), /Sale must start/);
});

test("UserAccount and profile changes own sign-in, self-block and avatar ownership rules", () => {
  const user = new UserAccount({ subject: "owner", status: " suspended " });
  assert.throws(() => user.assertCanReceiveTokens(), /not allowed/);
  assert.throws(() => user.statusChangedBy("owner", "BLOCKED"), /own account/);
  assert.equal(user.statusChangedBy("admin", "ACTIVE").canSignIn, true);
  assert.throws(() => new ProfileChange("owner", { avatarKey: "public/avatars/other/image" }).assertAllowed(), /not allowed/);
  const change = new ProfileChange("owner", { avatarKey: "" });
  assert.deepEqual(change.toSnapshot(), { avatarKey: "" });
  const profile = new UserProfile("owner", { displayName: "User", avatarKey: "", addresses: [] });
  assert.equal(profile.update({ displayName: "Next" }).toSnapshot().displayName, "Next");
  assert.equal(profile.toSnapshot().displayName, "User");
});

test("Value object constructors copy input; explicit assertions enforce action-specific rules", () => {
  const email = new SignUpEmail("");
  assert.equal(email.value, "");
  assert.throws(() => email.assertAllowedBy({ allowedDomains: [], blockedDomains: [], blockedEmails: [] }), /Email is required/);
  const change = new ProfileChange("owner", { avatarKey: "public/avatars/other/image" });
  assert.equal(change.avatarKey, "public/avatars/other/image");
  assert.throws(() => change.assertAllowed(), /not allowed/);
  const cart = new OrderItems([{ productId: "one", quantity: 0 }]);
  assert.equal(cart.toSnapshot()[0].quantity, 0);
  assert.throws(() => cart.assertValid(), /Invalid checkout item/);
  const draft = new PaymentDraft([{ productId: "one", quantity: 0 }]);
  assert.throws(() => draft.assertValidItems(), /Invalid payment item/);
});

test("Payment validation still precedes provider calls when checkout supplies an amount override", async () => {
  let reads = 0, issues = 0;
  const flow = new CreatePayment({ async find() { reads++; return null; } }, {
    async issue() { issues++; throw new Error("Provider must not be called"); }
  });
  await assert.rejects(flow.execute({ items: [{ productId: "one", quantity: 0 }] }, "127.0.0.1",
    { skipStockValidation: true, amount: 1000 }), /Invalid payment item/);
  assert.equal(reads, 0); assert.equal(issues, 0);
});

test("Email entities retain uncertainty, affected-recipient attribution and content redaction", () => {
  const delivery = new EmailDelivery({ id: "mail", html: "<p>private</p>", text: "private" }, [
    { recipientEmail: "unknown@test.com", status: "unknown" }, { recipientEmail: "failed@test.com", status: "failed" },
    { recipientEmail: "sent@test.com", status: "accepted" }
  ]);
  assert.deepEqual(delivery.retryRecipients(), ["failed@test.com"]);
  assert.deepEqual(delivery.publicSnapshot(), { id: "mail" });
  const recipient = new EmailRecipient("a@test.com", "delivered");
  assert.equal(recipient.canTransitionTo("accepted"), false);
  assert.equal(recipient.canTransitionTo("bounced"), true);
  assert.equal(recipient.isAffected(["A@test.com"]), true);
  assert.equal(recipient.isAffected(["b@test.com"]), false);
  const route = new EmailRoute({ emailJobId: "route", publishAttempts: 3 });
  assert.equal(route.exhausted(3), true); assert.equal(route.hasPublishPayload, false);
  const campaign = new EmailCampaign("campaign", "Subject", "<script>&", Array.from({ length: 51 }, (_, i) => `${i}@test.com`));
  assert.deepEqual(campaign.batches().map(batch => batch.length), [50, 1]);
  assert.equal(campaign.html, "&lt;script&gt;&amp;");
});

test("Notification and UploadScope retain audience and private-storage boundaries", () => {
  const notification = new Notification({ id: "one", customerEmail: "customer@test.com", isRead: false, metadata: { audience: "admin" } });
  assert.equal(notification.isVisibleToAdmin("admin@test.com"), true); assert.equal(notification.isUnread, true);
  assert.equal(new UploadScope("avatars").imagePrefixFor({ subject: "owner", isAdmin: false }), "public/avatars/owner");
  assert.throws(() => new UploadScope("private/admin-reports").imagePrefixFor({ subject: "owner", isAdmin: true }), /not allowed/);
});

test("RevenueReport snapshots never expose internal order/item references", () => {
  const orders = [{ id: "order", customerEmail: "owner@test.com", status: "paid", createdAt: new Date(now - 1000).toISOString(),
    totalAmount: 1000, items: [{ productId: "one", productName: "One", quantity: 1, lineTotal: 1000 }] }];
  const report = new RevenueReport(orders, new Date(now));
  orders[0].items[0].lineTotal = 0;
  const first = report.toSnapshot(); first.orders[0].items[0].lineTotal = 0;
  assert.equal(report.toSnapshot().topProducts[0].revenue, 1000);
});
