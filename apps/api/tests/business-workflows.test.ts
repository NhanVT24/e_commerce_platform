import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationError } from "../src/common/application/application-error.js";
import { AccountAccess, ConfirmAccount, type AccountConfirmationPorts } from "../src/modules/customers/authorization/application/account-lifecycle.js";
import { PrepareSignUp } from "../src/modules/customers/authorization/application/prepare-sign-up.js";
import { ProfileQueries, UpdateProfile, type ProfileRepository } from "../src/modules/customers/authorization/application/profile.js";
import { SalesUseCases, type CampaignStore, type CampaignSchedules } from "../src/modules/sales/application/campaigns.js";
import type { SaleCampaign } from "../src/modules/sales/domain/campaign.js";
import { SendInventoryReport, type InventoryReportPorts } from "../src/modules/inventory-reports/application/send-inventory-report.js";
import { UploadAccess, type UploadStorage } from "../src/modules/uploads/application/upload-access.js";
import { AdminOperations, type AdminGateway, type QueueMessageSnapshot } from "../src/modules/admin-ops/application/admin-operations.js";

test("native sign-up rejects duplicate identity without linking an external account", async () => {
  const failure = new Error("email exists"); let links = 0;
  const flow = new PrepareSignUp({ allowedDomains: [], blockedDomains: [], blockedEmails: [] }, {
    async unique() { throw failure; }, async link() { links++; }
  }, { confirmNative: true, verifyNative: true });
  await assert.rejects(flow.execute("user@example.test", "native"), error => error === failure);
  assert.equal(links, 0);
});

function confirmationFixture() {
  const calls: string[] = [];
  const ports: AccountConfirmationPorts = {
    async reset(subject) { calls.push(`reset:${subject}`); }, async assignCustomer() { calls.push("group"); },
    async persistProfile() { calls.push("profile"); return { subject: "user", email: "user@example.test", displayName: "User" }; },
    async welcome(profile) { calls.push(`welcome:${profile.subject}`); }
  };
  return { calls, ports, flow: new ConfirmAccount(ports) };
}

test("sign-up confirmation assigns group and persists profile before welcome email", async () => {
  const f = confirmationFixture();
  await f.flow.execute("sign_up", "user");
  assert.deepEqual(f.calls, ["group", "profile", "welcome:user"]);
});

test("failed profile persistence cannot send a welcome email", async () => {
  const f = confirmationFixture(), failure = new Error("profile store down");
  f.ports.persistProfile = async () => { throw failure; };
  await assert.rejects(f.flow.execute("sign_up", "user"), error => error === failure);
  assert.deepEqual(f.calls, ["group"]);
});

test("password reset requires a subject and unrelated trigger never welcomes", async () => {
  const f = confirmationFixture();
  await assert.rejects(f.flow.execute("password_reset"), /without a user subject/);
  await f.flow.execute("other", "user");
  assert.deepEqual(f.calls, []);
});

for (const status of ["SUSPENDED", "DISABLED", "BLOCKED"]) {
  test(`token issuance rejects ${status} without loading permissions`, async () => {
    let reads = 0;
    const access = new AccountAccess({ async status() { return status; }, async permissions() { reads++; return []; } });
    await assert.rejects(access.claims({ subject: "user", groups: [], email: "user@example.test", displayName: "User", provider: "native" }), /not allowed/);
    assert.equal(reads, 0);
  });
}

test("profile update sends only changed fields and returns the saved profile projection", async () => {
  const writes: unknown[] = [];
  const profiles: ProfileRepository = {
    async find() { return { displayName: "New name", avatarKey: "public/avatars/user/a.png", addresses: [] }; },
    async update(change) { assert.equal(change.subject, "user"); writes.push(change.toSnapshot()); }
  };
  const avatars = { async exists() { assert.fail("Name-only update must not check avatar storage"); }, publicUrl(key: string) { return `cdn/${key}`; } };
  const result = await new UpdateProfile(profiles, avatars, new ProfileQueries(profiles, avatars)).execute("user", { displayName: "New name" });
  assert.deepEqual(writes, [{ displayName: "New name" }]);
  assert.equal(result.displayName, "New name");
  assert.equal(result.avatarUrl, "cdn/public/avatars/user/a.png");
});

function salesFixture() {
  const now = Date.parse("2026-10-22T00:00:00Z"), calls: string[] = [];
  const campaign: SaleCampaign = { id: "sale", name: "Sale", discountPercent: 10, productIds: ["p1", "p2"], campaignStatus: "scheduled",
    startAt: "2026-10-22T00:02:00Z", endAt: "2026-10-23T00:00:00Z", startScheduleName: "sale-start-sale", endScheduleName: "sale-end-sale", version: 1, createdAt: "now", updatedAt: "now" };
  const store: CampaignStore = {
    async listSaleCampaigns() { return [campaign]; }, async listActiveSaleCampaigns() { return []; }, async getSaleCampaign() { return campaign; },
    async createSaleCampaign(input) { calls.push("persist"); return input.toSnapshot(); },
    async cancelSaleCampaign() { calls.push("cancel"); }, async transitionSaleCampaign(entity, from) { calls.push(`${from}->${entity.toSnapshot().campaignStatus}`); },
    async closeSaleCampaignBecauseEmpty() { calls.push("close"); return { ...campaign, productIds: [] }; },
    async updateSaleCampaignProducts(input) { calls.push("update"); assert.equal(input.expectedVersion, 1); return { ...campaign, productIds: input.campaign.toSnapshot().productIds, version: 2 }; }
  };
  const products = { async find(id: string): Promise<{ id: string } | null> { return { id }; } };
  const schedules: CampaignSchedules = { assertReady() { calls.push("ready"); },
    async create(_id, action) { calls.push(`schedule:${action}`); }, async delete(name) { calls.push(`delete:${name}`); } };
  return { campaign, store, products, schedules, calls, flow: new SalesUseCases(store, products, schedules, () => "sale", () => now) };
}

test("sale creation persists a scheduled campaign and creates both schedules", async () => {
  const f = salesFixture();
  const result = await f.flow.create(f.campaign);
  assert.equal(result.campaignStatus, "scheduled");
  assert.equal(result.startScheduleName, "sale-start-sale");
  assert.equal(result.endScheduleName, "sale-end-sale");
  assert.deepEqual(f.calls, ["ready", "persist", "schedule:start", "schedule:end"]);
});

test("sale creation with missing product fails before persistence or Scheduler calls", async () => {
  const f = salesFixture(); f.products.find = async () => null;
  await assert.rejects(f.flow.create(f.campaign), { code: "INVALID_INPUT" });
  assert.deepEqual(f.calls, []);
});

test("sale removes one product with expected version and keeps schedules for remaining products", async () => {
  const f = salesFixture(), result = await f.flow.removeProduct("sale", "p1");
  assert.deepEqual(result.campaign?.productIds, ["p2"]);
  assert.equal(result.closed, false);
  assert.deepEqual(f.calls, ["update"]);
});

test("duplicate sale product removal does not write or delete schedules", async () => {
  const f = salesFixture();
  await f.flow.removeProduct("sale", "absent");
  assert.deepEqual(f.calls, []);
});

test("sale schedule transitions start/end and safely ignores duplicate conditional conflicts", async () => {
  const f = salesFixture();
  assert.deepEqual(await f.flow.handleScheduleEvent({ campaignId: "sale", action: "start" }), { active: true });
  assert.deepEqual(await f.flow.handleScheduleEvent({ campaignId: "sale", action: "end" }), { ended: true });
  assert.deepEqual(f.calls, ["scheduled->active", "scheduled->ended"]);
  f.store.transitionSaleCampaign = async () => { throw new ApplicationError("CONFLICT", "already transitioned"); };
  assert.deepEqual(await f.flow.handleScheduleEvent({ campaignId: "sale", action: "start" }), { active: true });
});

test("sale schedule ignores missing campaign and unknown action without transitions", async () => {
  const f = salesFixture();
  assert.deepEqual(await f.flow.handleScheduleEvent({ campaignId: "sale", action: "invalid" }), { ignored: "unknown_action" });
  f.store.getSaleCampaign = async () => null;
  assert.deepEqual(await f.flow.handleScheduleEvent({ campaignId: "missing", action: "start" }), { ignored: "campaign_not_found" });
  assert.deepEqual(f.calls, []);
});

function inventoryFixture() {
  const events: string[] = [];
  const ports: InventoryReportPorts = { newId: () => "report-email",
    async listInventoryReportProducts() { events.push("list"); return [
      { id: "low", name: "Low", stock: 5, status: "low_stock", updatedAt: "now", inventoryAlertSent: false },
      { id: "out", name: "Out", stock: 0, status: "out_of_stock", updatedAt: "now", inventoryAlertSent: false }
    ]; },
    async createPendingInventoryReport(input) { events.push("claim"); assert.equal(input.toSnapshot().lowStockCount, 1); assert.equal(input.toSnapshot().outOfStockCount, 1); },
    async createPendingEmailDelivery() { events.push("email"); return { id: "mail" }; },
    async sendInventoryDigestEmail(input) { events.push("send"); assert.equal(input.lowStockProducts[0].id, "low"); assert.equal(input.outOfStockProducts[0].id, "out"); return "ses-message"; },
    async markInventoryReportAccepted() { events.push("report:accepted"); return true; }, async markEmailDeliveryAccepted() { events.push("email:accepted"); return true; },
    async markInventoryReportFailed() { events.push("report:failed"); }, async markEmailDeliveryFailed() { events.push("email:failed"); },
    async markInventoryReportProductsAlerted() { events.push("products:alerted"); return 2; },
    getInventoryDigestSubject(date) { return `Inventory ${date}`; }, warn() { events.push("warn"); }
  };
  return { ports, events, flow: new SendInventoryReport(ports, { adminEmail: "admin@example.test", senderEmail: "sender@example.test" }) };
}
const reportDate = new Date("2026-01-01T00:00:00Z");

test("inventory report claims identity, sends classified stock and records acceptance before alert flags", async () => {
  const f = inventoryFixture();
  assert.deepEqual(await f.flow.execute(reportDate), { sent: true, reportId: "daily-inventory-2026-01-01", sesMessageId: "ses-message", productCount: 2, alertedProductCount: 2 });
  assert.deepEqual(f.events, ["list", "claim", "email", "send", "report:accepted", "email:accepted", "products:alerted"]);
});

test("inventory report skips off-schedule dates before querying products", async () => {
  const f = inventoryFixture();
  assert.equal((await f.flow.execute(new Date("2026-01-02T00:00:00Z"))).reason, "not_scheduled_report_date");
  assert.deepEqual(f.events, []);
});

test("inventory report empty stock selection does not claim or send a report", async () => {
  const f = inventoryFixture(); f.ports.listInventoryReportProducts = async () => [];
  assert.equal((await f.flow.execute(reportDate)).reason, "no_low_or_out_of_stock_products");
  assert.deepEqual(f.events, []);
});

test("inventory report post-send flag failure preserves accepted delivery without resending", async () => {
  const f = inventoryFixture(); f.ports.markInventoryReportProductsAlerted = async () => { throw new Error("flag update down"); };
  const result = await f.flow.execute(reportDate);
  assert.equal(result.sent, true); assert.equal(result.alertedProductCount, 0);
  assert.equal(f.events.filter(event => event === "send").length, 1);
  assert.equal(f.events.at(-1), "warn");
});

test("private report upload/list omit public file URLs and opening validates the private prefix", async () => {
  const opened: string[] = [];
  const storage: UploadStorage = {
    async put(prefix) { assert.equal(prefix, "private/admin-reports"); return { bucket: "b", key: `${prefix}/report.pdf`, contentType: "application/pdf", uploadUrl: "signed-upload", fileUrl: "must-not-leak", expiresIn: 60 }; },
    async list(prefix) { return { items: [{ key: `${prefix}/report.pdf`, fileName: "report.pdf", size: 1, updatedAt: "now", fileUrl: "must-not-leak" }] }; },
    async open(key) { opened.push(key); return { key, downloadUrl: "signed-download", expiresIn: 60 }; }
  };
  const flow = new UploadAccess(storage);
  assert.equal("fileUrl" in await flow.report({ fileName: "report.pdf" }), false);
  assert.equal("fileUrl" in (await flow.reports()).items[0], false);
  assert.throws(() => flow.open("public/products/image.png"), { code: "INVALID_INPUT" });
  assert.deepEqual(opened, []);
  assert.equal((await flow.open("private/admin-reports/report.pdf")).downloadUrl, "signed-download");
});

function adminFixture() {
  const events: string[] = [];
  const message: QueueMessageSnapshot = { messageId: "m1", receiptHandle: "receipt", body: "{}", attributes: {}, messageAttributes: {} };
  const gateway: AdminGateway = {
    keys() { return ["emailJobs"]; }, queue() { return { dlqUrl: "dlq", targetQueueUrl: "target", replayType: "sqs" }; }, defaultBus() { return "bus"; },
    async receiveDlqMessages() { events.push("receive"); return [message]; }, async resetVisibility() { events.push("release"); },
    async replaySingleMessage() { events.push("publish"); return "target"; }, describeReplayDestination() { return "target"; },
    async ackPublished() { events.push("ack"); }, listArchives() { return []; }, async listDlqMessages() { return []; },
    async startArchiveReplay() { events.push("archive"); return {}; }, async getArchiveReplayStatus() { return {}; }, async injectAuditLogWorkerFailure() { return {}; }
  };
  return { gateway, events, flow: new AdminOperations(gateway, { log() {}, warn() {}, error() {} }) };
}

test("DLQ dry run previews destination without replaying or acknowledging messages", async () => {
  const f = adminFixture();
  const result = await f.flow.replayDlqMessages({ queue: "emailJobs", maxMessages: 1, dryRun: true });
  assert.equal(result.queues[0].items[0].status, "preview");
  assert.deepEqual(f.events, ["receive"]);
});

test("DLQ missing destination does not receive or consume messages", async () => {
  const f = adminFixture(); f.gateway.queue = () => ({ dlqUrl: "dlq", replayType: "sqs" });
  const result = await f.flow.replayDlqMessages({ queue: "emailJobs", maxMessages: 1, dryRun: false });
  assert.equal(result.queues[0].configured, false);
  assert.deepEqual(f.events, []);
});

test("DLQ acknowledge failure remains visible to caller after publication", async () => {
  const f = adminFixture(), failure = new Error("delete response lost");
  f.gateway.ackPublished = async () => { f.events.push("ack"); throw failure; };
  await assert.rejects(f.flow.replayDlqMessages({ queue: "emailJobs", maxMessages: 1, dryRun: false }), error => error === failure);
  assert.deepEqual(f.events, ["receive", "publish", "ack"]);
});

test("archive replay rejects invalid/reversed/equal time ranges before provider call", () => {
  const f = adminFixture();
  for (const [start, end] of [["invalid", "2026-10-22"], ["2026-10-23", "2026-10-22"], ["2026-10-22", "2026-10-22"]]) {
    assert.throws(() => f.flow.startArchiveReplay({ archive: "commerce", eventStartTime: start, eventEndTime: end }), { code: "INVALID_INPUT" });
  }
  assert.deepEqual(f.events, []);
});
