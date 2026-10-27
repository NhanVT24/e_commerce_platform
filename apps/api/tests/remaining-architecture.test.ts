import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationError } from "../src/common/application/application-error.js";
import { UpdateProfile, ProfileQueries, type ProfileRepository, type ProfileAvatars } from "../src/modules/customers/authorization/application/profile.js";
import { AuthorizationUseCases, type AuthorizationStore } from "../src/modules/customers/authorization/application/authorization.js";
import { AccountAccess, ConfirmAccount } from "../src/modules/customers/authorization/application/account-lifecycle.js";
import { PrepareSignUp } from "../src/modules/customers/authorization/application/prepare-sign-up.js";
import { ObserveSuccessfulLogin } from "../src/modules/customers/authorization/application/observe-login.js";
import { SalesUseCases, type CampaignStore, type CampaignSchedules } from "../src/modules/sales/application/campaigns.js";
import type { SaleCampaign } from "../src/modules/sales/domain/campaign.js";
import { CleanupData } from "../src/modules/data-cleanup/application/cleanup-data.js";
import { BuildWeeklyRevenue } from "../src/modules/storefront/application/weekly-revenue.js";
import { ListVerifiedCustomers } from "../src/modules/customers/application/customer-directory.js";
import { UploadAccess, type UploadStorage } from "../src/modules/uploads/application/upload-access.js";
import { EmailAdministration } from "../src/modules/email-deliveries/application/email-administration.js";
import type { EmailAdministrationPorts } from "../src/modules/email-deliveries/application/ports.js";
import { RecoverEmailPublishes } from "../src/modules/email-deliveries/application/email-publish-recovery.js";
import type { EmailRecoveryPorts, RecoverableEmailRoute } from "../src/modules/email-deliveries/application/recovery-ports.js";
import { DeliverEmailJob, type EmailDeliveryPorts } from "../src/modules/email-deliveries/application/deliver-email-job.js";
import { QueueOrderConfirmation } from "../src/modules/email-deliveries/application/queue-order-confirmation.js";
import { AdminOperations, type AdminGateway, type QueueMessageSnapshot } from "../src/modules/admin-ops/application/admin-operations.js";
import { emailPublishRetryAt } from "../src/modules/email-deliveries/domain/retry-policy.js";
import { SendInventoryReport, type InventoryReportPorts } from "../src/modules/inventory-reports/application/send-inventory-report.js";

const log = { log() {}, warn() {}, error() {} };
const now = Date.parse("2026-10-21T00:00:00.000Z");

test("profile rejects foreign/missing avatars before writing and persists only validated business patch", async () => {
  let writes = 0, checks = 0, exists = false;
  const profiles: ProfileRepository = { async find() { return { displayName: "User", avatarKey: "", addresses: [] }; }, async update() { writes++; } };
  const avatars: ProfileAvatars = { async exists() { checks++; return exists; }, publicUrl(key) { return key ? `cdn/${key}` : ""; } };
  const update = new UpdateProfile(profiles, avatars, new ProfileQueries(profiles, avatars));
  await assert.rejects(update.execute("owner", { avatarKey: "public/avatars/foreign/file" }), { code: "INVALID_INPUT" });
  assert.equal(checks, 0);
  await assert.rejects(update.execute("owner", { avatarKey: "public/avatars/owner/file" }), { message: "Avatar image does not exist." });
  assert.equal(writes, 0); exists = true;
  await update.execute("owner", { avatarKey: "public/avatars/owner/file" });
  await update.execute("owner", { avatarKey: "" });
  assert.equal(writes, 2); assert.equal(checks, 2);
});

test("authorization cannot self-block and never writes for a missing directory user", async () => {
  let writes = 0;
  const store: AuthorizationStore = {
    async getUserPermissions() { return []; }, async getUserProfileSummary() { return { accountStatus: "ACTIVE", lastLoginAt: "", displayName: "", addresses: [] }; },
    async addUserPermission() { writes++; return []; }, async removeUserPermission() { writes++; return []; },
    async updateUserAccountStatus(account) { writes++; return account.status; }, async updateUserAddresses(change) { writes++; return change.toSnapshot().addresses ?? []; }
  };
  const flow = new AuthorizationUseCases({ async listUsers() { return [{ subject: "self", username: "u", email: "u@example.test", displayName: "User" }]; } }, store);
  await assert.rejects(flow.updateAccountStatus("self", "BLOCKED", "self"), { code: "INVALID_INPUT" });
  await assert.rejects(flow.addPermission("missing", "products:create", "self"), { code: "NOT_FOUND" });
  assert.equal(writes, 0);
  await flow.updateAccountStatus("self", "ACTIVE", "self"); assert.equal(writes, 1);
});

test("account access blocks token issuance before permissions and preserves admin precedence", async () => {
  let status = "BLOCKED", reads = 0;
  const access = new AccountAccess({ async status() { return status; }, async permissions() { reads++; return ["products:create"]; } });
  const input = { subject: "u", groups: ["customer", "admin"], email: "u@example.test", displayName: "User", provider: "native" };
  await assert.rejects(access.signIn("u"), /not allowed/);
  await assert.rejects(access.claims(input), /not allowed/); assert.equal(reads, 0);
  status = "ACTIVE"; const claims = await access.claims(input);
  assert.equal(claims.identity.role, "admin"); assert.deepEqual(claims.permissions, ["products:create"]);
});

test("sign-up domain policy rejects before linking and native/external flows preserve confirmation flags", async () => {
  const calls: string[] = [];
  const flow = new PrepareSignUp({ allowedDomains: ["example.test"], blockedDomains: [], blockedEmails: [] },
    { async unique() { calls.push("unique"); }, async link() { calls.push("link"); } }, { confirmNative: false, verifyNative: true });
  await assert.rejects(flow.execute("u@other.test", "external"), /not allowed/); assert.deepEqual(calls, []);
  assert.deepEqual(await flow.execute("u@example.test", "native"), { autoVerifyEmail: true });
  assert.deepEqual(await flow.execute("u@example.test", "external"), { autoConfirmUser: true, autoVerifyEmail: true });
  assert.deepEqual(calls, ["unique", "link"]);
});

test("confirmation keeps group -> profile -> welcome order and propagates a failed publish; reset never welcomes", async () => {
  const calls: string[] = [];
  const flow = new ConfirmAccount({ async reset() { calls.push("reset"); }, async assignCustomer() { calls.push("group"); },
    async persistProfile() { calls.push("profile"); return { subject: "u", email: "u@example.test", displayName: "User" }; },
    async welcome() { calls.push("welcome"); throw new Error("publish unknown"); } });
  await flow.execute("password_reset", "u"); assert.deepEqual(calls, ["reset"]); calls.length = 0;
  await assert.rejects(flow.execute("sign_up", "u"), /publish unknown/); assert.deepEqual(calls, ["group", "profile", "welcome"]);
});

test("login observation preserves best-effort behavior and injected audit identity/time", async () => {
  let warning = "";
  const flow = new ObserveSuccessfulLogin({ async record(input) { assert.equal(input.at, new Date(now).toISOString()); assert.equal(input.auditId, "audit-id"); throw new Error("storage failed"); } },
    subject => { warning = subject; }, () => "audit-id", () => now);
  await flow.execute({ subject: "u", email: "u@example.test", ipAddress: "127.0.0.1" }); assert.equal(warning, "u");
});

function saleFixture() {
  const calls: string[] = [];
  const campaign: SaleCampaign = { id: "sale", name: "Sale", campaignStatus: "active", discountPercent: 10, productIds: ["p"], startAt: "2026-10-22T00:00:00Z", endAt: "2026-10-23T00:00:00Z",
    startScheduleName: "start", endScheduleName: "end", version: 1, createdAt: "", updatedAt: "" };
  const store: CampaignStore = { async listSaleCampaigns() { return [campaign]; }, async listActiveSaleCampaigns() { return [campaign]; }, async getSaleCampaign() { return campaign; },
    async createSaleCampaign(entity) { calls.push("persist"); return entity.toSnapshot(); }, async cancelSaleCampaign() { calls.push("cancel"); }, async transitionSaleCampaign() {},
    async closeSaleCampaignBecauseEmpty() { calls.push("close"); return { ...campaign, productIds: [] }; }, async updateSaleCampaignProducts() { return campaign; } };
  const schedules: CampaignSchedules = { assertReady() {}, async create(_id, action) { calls.push(`create:${action}`); }, async delete(name) { calls.push(`delete:${name}`); } };
  return { store, schedules, calls, campaign, flow: new SalesUseCases(store, { async find() { return {}; } }, schedules, () => "sale", () => now) };
}

test("sale compensation waits for both schedule attempts before deleting; storage failures are not swallowed", async () => {
  const f = saleFixture();
  f.schedules.create = async (_id, action) => { if (action === "start") throw new Error("failed start"); await new Promise(resolve => setTimeout(resolve, 10)); f.calls.push("end-created"); };
  await assert.rejects(f.flow.create({ name: "Sale", productIds: ["p"], discountPercent: 10, startAt: f.campaign.startAt, endAt: f.campaign.endAt }), /failed start/);
  assert.ok(f.calls.includes("delete:sale-start-sale"));
  assert.ok(f.calls.includes("delete:sale-end-sale"));
  assert.ok(f.calls.findIndex(call => call.startsWith("delete:")) > f.calls.indexOf("end-created"));
  assert.equal(f.calls.at(-1), "cancel");
  f.store.transitionSaleCampaign = async () => { throw new Error("database down"); };
  await assert.rejects(f.flow.handleScheduleEvent({ campaignId: "sale", action: "end" }), /database down/);
});

test("sale retries only semantic conflicts and commits empty-campaign state before scheduler cleanup", async () => {
  const f = saleFixture(); let attempts = 0;
  f.store.closeSaleCampaignBecauseEmpty = async () => { if (++attempts === 1) throw new ApplicationError("CONFLICT", "raced"); f.calls.push("close"); return { ...f.campaign, productIds: [] }; };
  assert.equal((await f.flow.removeProduct("sale", "p")).closed, true); assert.equal(attempts, 2);
  assert.equal(f.calls[0], "close"); assert.ok(f.calls.slice(1).every(call => call.startsWith("delete:")));
});

test("cleanup preserves retention predicates, distributed claim and backlog completion", async () => {
  let claimed = false, pages = 0; const predicates: Array<(row: { status?: string; isRead?: boolean }) => boolean> = [];
  const flow = new CleanupData({ async tryStartDataCleanup() { return claimed; }, async listCleanupCandidates(plan) {
    predicates.push(plan.isEligible); pages++; return { candidates: [plan.entityType], hasRemainingBacklog: pages === 1 };
  }, async deleteCleanupCandidates(rows: string[]) { return rows.length; }, async markDataCleanupCompleted(input) { assert.equal(input.hasRemainingBacklog, true); } });
  assert.equal((await flow.execute(new Date(now))).ran, false); assert.equal(pages, 0); claimed = true;
  assert.equal((await flow.execute(new Date(now))).ran, true); assert.equal(pages, 6);
  assert.equal(predicates[0]({ status: "sent" }), false); assert.equal(predicates[0]({ isRead: true }), true);
  assert.equal(predicates[1]({ status: "processing" }), false);
});

test("weekly revenue applies an exclusive upper time bound and preserves current eligible statuses", async () => {
  const base = { id: "o", customerEmail: "u@example.test", status: "paid", createdAt: new Date(now - 1000).toISOString(), totalAmount: 2000,
    items: [{ productId: "p", productName: "Product", quantity: 2, lineTotal: 2000 }] };
  const result = await new BuildWeeklyRevenue({ async list() { return [base, { ...base, id: "pending", status: "pending" }, { ...base, status: "cancelled" }, { ...base, createdAt: new Date(now).toISOString() }]; } }).execute(new Date(now));
  assert.equal(result.orderCount, 2); assert.equal(result.totalRevenue, 4000); assert.equal(result.topProducts[0].quantity, 4);
});

test("customer directory filters disabled/unverified records and deduplicates normalized emails", async () => {
  const rows = [{ email: "A@EXAMPLE.TEST", displayName: "A", enabled: true, emailVerified: true },
    { email: "a@example.test", displayName: "Duplicate", enabled: true, emailVerified: true },
    { email: "b@example.test", displayName: "B", enabled: false, emailVerified: true }];
  const result = await new ListVerifiedCustomers({ async search() { return rows; } }).execute("  a  ", 50);
  assert.equal(result.length, 1); assert.equal(result[0].email, "a@example.test");
});

test("upload policy rejects private and foreign-user image scopes before issuing storage grants", async () => {
  const scopes: string[] = [];
  const storage: UploadStorage = { async put(scope) { scopes.push(scope); return { bucket: "b", key: "k", contentType: "image/png", uploadUrl: "signed", fileUrl: "public", expiresIn: 60 }; }, async list() { return { items: [] }; }, async open() { return { key: "k", downloadUrl: "signed", expiresIn: 60 }; } };
  const flow = new UploadAccess(storage), actor = { subject: "u", isAdmin: false };
  assert.throws(() => flow.image({ scope: "private/admin-reports" }, actor), { code: "INVALID_INPUT" });
  assert.throws(() => flow.image({ scope: "public/avatars/foreign" }, actor), { code: "INVALID_INPUT" });
  assert.deepEqual(scopes, []); await flow.image({ scope: "avatars" }, actor); assert.equal(scopes[0], "public/avatars/u");
  assert.equal("fileUrl" in await flow.report({ fileName: "report.pdf" }), false);
});

function emailFixture() {
  const events: Array<Record<string, unknown>> = [], ids: string[] = [];
  const ports: EmailAdministrationPorts = {
    async getEmailDelivery() { return null; }, async listEmailDeliveriesWithStatus() { return []; }, async listFailedEmailRoutePublishes() { return []; },
    async retryFailedEmailRoutePublish() { return false; }, async ensureEmailRoute(input) { ids.push(input.emailJobId); return true; },
    async markEmailRoutePublished() { return true; }, async markEmailRoutePublishRetry() { return true; }, nextEmailPublishRetryAt() { return "next"; },
    async publishEventBridgeEvent(event) { events.push(event.detail); return { eventId: "event", eventBusName: "bus" }; }
  };
  return { ports, events, ids, flow: new EmailAdministration(ports, { senderEmail: "sender@example.test", eventsEnabled: true }, () => "id", value => `hash:${value}`, log) };
}

test("email campaign splits 51 recipients, escapes HTML and reuses deterministic batch identities", async () => {
  const f = emailFixture(), input = { recipients: Array.from({ length: 51 }, (_, i) => `u${i}@example.test`), subject: "Sale", body: "<script>unsafe</script>", idempotencyKey: "campaign" };
  assert.equal((await f.flow.sendSaleCampaign(input)).batchCount, 2);
  await f.flow.sendSaleCampaign(input);
  assert.deepEqual(f.ids, ["hash:campaign:0", "hash:campaign:1", "hash:campaign:0", "hash:campaign:1"]);
  assert.equal((f.events[0].recipients as string[]).length, 50); assert.equal(String(f.events[0].html).includes("<script>"), false);
});

test("email retry excludes accepted and unknown recipients and never reveals retained message bodies", async () => {
  const f = emailFixture();
  f.ports.getEmailDelivery = async () => ({ meta: { id: "email", senderEmail: "s@example.test", subject: "Sale", recipientCount: 3, sendStatus: "unknown", createdAt: "", updatedAt: "", html: "private html", text: "private text" },
    recipients: [{ recipientEmail: "a@example.test", status: "accepted" }, { recipientEmail: "b@example.test", status: "unknown" }, { recipientEmail: "c@example.test", status: "failed" }] });
  await f.flow.retrySafeRecipients("email", { idempotencyKey: "retry" });
  assert.deepEqual(f.events[0].recipients, ["c@example.test"]);
  const detail = await f.flow.detail("email"); assert.equal("html" in detail.meta, false); assert.equal("text" in detail.meta, false);
});

test("order confirmation replay reuses the durable route; a lost publish response schedules the same identity", async () => {
  const f = emailFixture(); let created = false;
  f.ports.ensureEmailRoute = async input => { f.ids.push(input.emailJobId); if (created) return false; created = true; return true; };
  f.ports.publishEventBridgeEvent = async () => { throw new Error("accepted but response lost"); };
  const flow = new QueueOrderConfirmation(f.ports, true, value => `hash:${value}`);
  const input = { toEmail: "u@example.test", orderId: "order", totalAmount: 1, createdAt: "now", items: [] };
  assert.equal((await flow.execute(input)).status, "retry_scheduled"); assert.equal((await flow.execute(input)).status, "already_queued");
  assert.deepEqual(f.ids, ["hash:order-confirmation:order", "hash:order-confirmation:order"]);
});

function recoveryFixture() {
  const route: RecoverableEmailRoute = { emailJobId: "job", campaignId: "campaign", publishAttempts: 1, eventSource: "email", eventDetailType: "mail", eventDetail: {} };
  const calls: string[] = [];
  const ports: EmailRecoveryPorts = {
    async findDueEmailRoutePublishes() { return [route]; }, async claimEmailRoutePublish() { calls.push("claim"); return route; },
    async markEmailRoutePublishFailed() { return true; }, async markEmailRoutePublished() { calls.push("mark"); return true; },
    async markEmailRoutePublishRetry(input) { calls.push(`retry:${input.emailJobId}`); return true; }, async markEmailRouteAlertResult() {},
    async findStalePublishedEmailRoutes() { return []; }, async markEmailRouteRoutingSuspected() { return true; },
    async publishRoute() { calls.push("publish"); return { eventId: "event" }; }, async publishAdminAlert() { return { messageId: "alert" }; }, nextEmailPublishRetryAt() { return "next"; }
  };
  return { ports, route, calls, flow: new RecoverEmailPublishes(ports, { maxAttempts: 5, leaseSeconds: 120 }, log, () => now) };
}

test("email recovery claims before publish, leaves a competing claim alone and resumes marker failure with stable identity", async () => {
  const f = recoveryFixture(); f.ports.claimEmailRoutePublish = async () => null;
  assert.equal((await f.flow.execute()).published, 0); assert.deepEqual(f.calls, []);
  f.ports.claimEmailRoutePublish = async () => { f.calls.push("claim"); return f.route; };
  f.ports.markEmailRoutePublished = async () => { throw new Error("marker failed"); };
  assert.equal((await f.flow.execute()).rescheduled, 1); assert.deepEqual(f.calls, ["claim", "publish", "retry:job"]);
});

test("email worker preserves unknown delivery outcome and confirms route processing before provider send", async () => {
  const calls: string[] = [];
  const ports: EmailDeliveryPorts = { async markEmailRouteProcessing() { calls.push("route"); return true; },
    async sendWelcomeEmail() { return { status: "accepted", emailId: "id" }; }, async sendOrderConfirmationEmail() { return { emailId: "id" }; },
    async sendBulkSaleEmailBatch() { calls.push("send"); return { status: "unknown" }; } };
  const flow = new DeliverEmailJob(ports, log), job = { type: "email.sale_campaign.requested" as const, emailJobId: "job", campaignId: "c", batchIndex: 0, batchCount: 1, senderEmail: "s@example.test", recipients: ["u@example.test"], subject: "Sale", html: "html", text: "text" };
  assert.equal(await flow.execute(job, { receiveCount: 1 }), "unknown"); assert.deepEqual(calls, ["route", "send"]);
  calls.length = 0;
  await assert.rejects(flow.execute(job, { receiveCount: 1, testMode: "fail", testOnly: { skipSesOnSuccess: true } }), /Injected failure/);
  assert.deepEqual(calls, ["route"]);
});

test("DLQ selective replay releases unselected/failed messages and acknowledges only successful publishes", async () => {
  const released: string[] = [], acked: string[] = [];
  const rows = ["selected", "failed", "unselected"].map(messageId => ({ messageId, receiptHandle: messageId, body: "{}", attributes: {}, messageAttributes: {} }));
  const gateway: AdminGateway = {
    keys() { return ["emailJobs"]; }, queue() { return { dlqUrl: "dlq", targetQueueUrl: "target", replayType: "sqs" }; }, defaultBus() { return undefined; },
    async receiveDlqMessages() { return rows; }, async resetVisibility(_url, messages) { released.push(...messages.map(row => row.messageId)); },
    async replaySingleMessage(_key, message) { if (message.messageId === "failed") throw new Error("publish failed"); return "target"; },
    describeReplayDestination() { return "target"; }, async ackPublished(_key, entries) { acked.push(...entries.map(entry => entry.id)); },
    listArchives() { return {}; }, async listDlqMessages() { return {}; }, async startArchiveReplay() {}, async getArchiveReplayStatus() {}, async injectAuditLogWorkerFailure() {}
  };
  const flow = new AdminOperations(gateway, log);
  const result = await flow.replayDlqMessages({ queue: "emailJobs", maxMessages: 3, dryRun: false, messageIds: ["selected", "failed"] });
  assert.deepEqual(acked, ["selected"]); assert.deepEqual(released, ["unselected", "failed"]); assert.equal(result.summary.failed, 1);
});

test("inventory report claim deduplicates before SES and does not mark products when sending fails", async () => {
  const calls: string[] = []; let duplicate = true;
  const ports: InventoryReportPorts = { newId: () => "report-email",
    async listInventoryReportProducts() { return [{ id: "p", name: "Product", stock: 1, status: "low_stock", updatedAt: "now", inventoryAlertSent: false }]; },
    async markInventoryReportProductsAlerted() { calls.push("products"); return 1; }, async createPendingInventoryReport() { if (duplicate) throw new ApplicationError("CONFLICT", "claimed"); },
    async markInventoryReportAccepted() { return true; }, async markInventoryReportFailed() { calls.push("report failed"); },
    async createPendingEmailDelivery() { return { id: "email" }; }, async markEmailDeliveryAccepted() { return true; }, async markEmailDeliveryFailed() { calls.push("email failed"); },
    getInventoryDigestSubject() { return "Inventory"; }, async sendInventoryDigestEmail() { calls.push("send"); throw new Error("ses failed"); }, warn() {}
  };
  const flow = new SendInventoryReport(ports, { adminEmail: "admin@example.test" });
  const scheduled = new Date("2026-01-03T01:00:00Z");
  assert.equal((await flow.execute(scheduled)).sent, false); assert.deepEqual(calls, []);
  duplicate = false; assert.equal((await flow.execute(scheduled)).sent, false);
  assert.deepEqual(calls, ["send", "report failed", "email failed"]);
});

test("email backoff caps exponential delay and supports deterministic jitter/clock", () => {
  assert.equal(emailPublishRetryAt(50, { baseSeconds: 60, maxSeconds: 900 }, now, () => 0), new Date(now + 900_000).toISOString());
});


test("SES feedback attributes shared sends only to affected recipients and refuses ambiguous updates", async () => {
  const { RecordEmailFeedback } = await import("../src/modules/email-deliveries/application/record-email-feedback.js");
  const updates: string[] = []; let reports = 0;
  const flow = new RecordEmailFeedback({
    async markEmailAccepted() {}, async listEmailRecipients() { return [{ recipientId: "a", recipientEmail: "a@example.test" }, { recipientId: "b", recipientEmail: "b@example.test" }]; },
    async updateEmailRecipientStatus(input) { updates.push(input.recipientId); },
    async updateEmailDeliveryStatus() { throw new Error("Must not use legacy projection"); },
    async updateInventoryReportDeliveryStatus() { reports++; }
  });
  const feedback = { status: "bounced" as const, statusAt: new Date(now).toISOString(), sesMessageId: "ses" };
  await flow.execute({ ...feedback, recipientEmails: ["B@example.test"] }, { emailId: "mail", reportId: "report" });
  assert.deepEqual(updates, ["b"]); assert.equal(reports, 1);
  await assert.rejects(flow.execute(feedback, { emailId: "mail" }), /Cannot attribute/);
  assert.deepEqual(updates, ["b"]);
});

test("payment return reads validate amount without confirming or publishing", async () => {
  const { ReadPaymentReturn } = await import("../src/modules/vnpay/application/read-payment-return.js");
  const session = { txnRef: "payment", amount: 1000, status: "pending", orderInfo: "order" };
  let reads = 0;
  const flow = new ReadPaymentReturn({ async find() { reads++; return session as never; } });
  assert.equal(await flow.execute("payment", "999"), null);
  assert.equal(await flow.execute("payment", "100000"), session);
  assert.equal(reads, 2); assert.equal(session.status, "pending");
});
