import assert from "node:assert/strict";
import { test } from "node:test";
import { TrackEmailRouteMatch } from "../src/modules/email-deliveries/application/track-email-route.js";
import { WatchEmailRouting } from "../src/modules/email-deliveries/application/email-routing-watchdog.js";
import { RecoverEmailPublishes } from "../src/modules/email-deliveries/application/email-publish-recovery.js";
import type { EmailRecoveryPorts, RecoverableEmailRoute } from "../src/modules/email-deliveries/application/recovery-ports.js";
import { DeliverEmailJob, type EmailDeliveryPorts } from "../src/modules/email-deliveries/application/deliver-email-job.js";
import type { EmailJob } from "../src/modules/email-deliveries/domain/email-jobs.js";

const now = Date.parse("2026-10-22T00:00:00Z");
const logger = { log() {}, warn() {}, error() {} };

function recoveryFixture() {
  const route: RecoverableEmailRoute = { emailJobId: "mail-1", campaignId: "campaign", publishAttempts: 1,
    eventSource: "supermarket.email", eventDetailType: "email.sale_campaign.requested", eventDetail: { emailJobId: "mail-1" } };
  const events: string[] = [], alerts: Array<Parameters<EmailRecoveryPorts["markEmailRouteAlertResult"]>[0]> = [];
  const claims: Array<Parameters<EmailRecoveryPorts["claimEmailRoutePublish"]>[0]> = [];
  const ports: EmailRecoveryPorts = {
    async findDueEmailRoutePublishes() { return [route]; },
    async claimEmailRoutePublish(input) { claims.push(input); events.push("claim"); return { ...route, publishAttempts: route.publishAttempts + 1 }; },
    async markEmailRoutePublishFailed() { events.push("failed"); return true; },
    async markEmailRoutePublished() { events.push("published"); return true; },
    async markEmailRoutePublishRetry() { events.push("retry"); return true; },
    async markEmailRouteAlertResult(input) { alerts.push(input); },
    async findStalePublishedEmailRoutes() { return [route]; },
    async markEmailRouteRoutingSuspected() { events.push("suspected"); return true; },
    async publishRoute() { events.push("publish"); return { eventId: "event-1" }; },
    async publishAdminAlert() { events.push("alert"); return { messageId: "alert-1" }; },
    nextEmailPublishRetryAt() { return "2026-10-22T00:01:00Z"; }
  };
  return { route, ports, events, alerts, claims,
    recovery: new RecoverEmailPublishes(ports, { maxAttempts: 3, leaseSeconds: 120 }, logger, () => now),
    watchdog: new WatchEmailRouting(ports, { ackTimeoutSeconds: 60 }, logger, () => now) };
}

test("email route acknowledgement delegates monotonic duplicate handling to the durable port", async () => {
  const seen = new Set<string>();
  const flow = new TrackEmailRouteMatch({ async markMatched(id) {
    if (seen.has(id)) return false; seen.add(id); return true;
  } });
  assert.deepEqual(await flow.execute("mail-1"), { tracked: true });
  assert.deepEqual(await flow.execute("mail-1"), { tracked: false });
});

test("email route acknowledgement storage failure propagates for queue retry", async () => {
  const failure = new Error("route store unavailable");
  await assert.rejects(new TrackEmailRouteMatch({ async markMatched() { throw failure; } }).execute("mail-1"), error => error === failure);
});

test("routing watchdog uses the injected SLA cutoff and persists suspicion before alerting", async () => {
  const f = recoveryFixture();
  f.ports.findStalePublishedEmailRoutes = async cutoff => {
    assert.equal(cutoff, "2026-10-21T23:59:00.000Z"); return [f.route];
  };
  assert.deepEqual(await f.watchdog.execute("run"), { evaluated: 1, suspected: 1, alertsSent: 1, alertsFailed: 0 });
  assert.deepEqual(f.events, ["suspected", "alert"]);
  assert.deepEqual(f.alerts, [{ emailJobId: "mail-1", sent: true, messageId: "alert-1" }]);
});

test("routing watchdog cannot alert for a route whose concurrent state transition lost", async () => {
  const f = recoveryFixture(); f.ports.markEmailRouteRoutingSuspected = async () => false;
  assert.deepEqual(await f.watchdog.execute(), { evaluated: 1, suspected: 0, alertsSent: 0, alertsFailed: 0 });
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.alerts, []);
});

test("routing watchdog records SNS failure and continues to the next stale route", async () => {
  const f = recoveryFixture();
  f.ports.findStalePublishedEmailRoutes = async () => [f.route, { ...f.route, emailJobId: "mail-2" }];
  let attempts = 0;
  f.ports.publishAdminAlert = async () => { if (++attempts === 1) throw new Error("SNS down"); return { messageId: "alert-2" }; };
  assert.deepEqual(await f.watchdog.execute(), { evaluated: 2, suspected: 2, alertsSent: 1, alertsFailed: 1 });
  assert.deepEqual(f.alerts, [{ emailJobId: "mail-1", sent: false }, { emailJobId: "mail-2", sent: true, messageId: "alert-2" }]);
});

test("routing watchdog tolerates alert-status outage but never republishes customer email", async () => {
  const f = recoveryFixture();
  f.ports.publishAdminAlert = async () => { throw new Error("SNS down"); };
  f.ports.markEmailRouteAlertResult = async () => { throw new Error("marker down"); };
  assert.equal((await f.watchdog.execute()).alertsFailed, 1);
  assert.equal(f.events.includes("publish"), false);
});

test("routing watchdog scan failure does not report successful completion", async () => {
  const f = recoveryFixture(), failure = new Error("query down");
  f.ports.findStalePublishedEmailRoutes = async () => { throw failure; };
  await assert.rejects(f.watchdog.execute(), error => error === failure);
  assert.deepEqual(f.events, []);
});

test("email publish recovery claims a bounded lease then records provider acceptance", async () => {
  const f = recoveryFixture();
  assert.deepEqual(await f.recovery.execute(), { evaluated: 1, claimed: 1, published: 1, rescheduled: 0, failed: 0 });
  assert.deepEqual(f.events, ["claim", "publish", "published"]);
  assert.deepEqual(f.claims, [{ emailJobId: "mail-1", expectedAttempt: 1, maxAttempts: 3,
    now: "2026-10-22T00:00:00.000Z", leaseUntil: "2026-10-22T00:02:00.000Z" }]);
});

test("exhausted email route is failed and alerted without claiming or republishing", async () => {
  const f = recoveryFixture(); f.route.publishAttempts = 3;
  assert.equal((await f.recovery.execute()).failed, 1);
  assert.deepEqual(f.events, ["failed", "alert"]);
  assert.deepEqual(f.claims, []);
});

test("exhausted route with a lost conditional failure transition does not send duplicate alert", async () => {
  const f = recoveryFixture(); f.route.publishAttempts = 3;
  f.ports.markEmailRoutePublishFailed = async () => false;
  assert.equal((await f.recovery.execute()).failed, 0);
  assert.deepEqual(f.events, []);
});

test("missing persisted email payload is failed instead of sending an incomplete event", async () => {
  const f = recoveryFixture(); f.route.eventSource = "";
  assert.equal((await f.recovery.execute()).failed, 1);
  assert.deepEqual(f.events, ["claim", "failed", "alert"]);
});

test("last publish attempt failure becomes terminal without scheduling another retry", async () => {
  const f = recoveryFixture(); f.route.publishAttempts = 2;
  f.ports.publishRoute = async () => { f.events.push("publish"); throw new Error("EventBridge rejected"); };
  const result = await f.recovery.execute();
  assert.equal(result.failed, 1); assert.equal(result.rescheduled, 0);
  assert.deepEqual(f.events, ["claim", "publish", "failed", "alert"]);
});

function deliveryFixture() {
  const calls: string[] = [];
  const ports: EmailDeliveryPorts = {
    async markEmailRouteProcessing() { calls.push("processing"); return true; },
    async sendWelcomeEmail(input) { calls.push(`welcome:${input.emailJobId}`); return { emailId: input.emailJobId, status: "accepted" }; },
    async sendOrderConfirmationEmail(input) { calls.push(`confirmation:${input.orderId}`); return { emailId: "confirmation" }; },
    async sendBulkSaleEmailBatch(input) { calls.push(`bulk:${input.emailId}`); return { status: "accepted" }; }
  };
  const job: Extract<EmailJob, { type: "email.sale_campaign.requested" }> = {
    type: "email.sale_campaign.requested", emailJobId: "mail-1", campaignId: "campaign", batchIndex: 0, batchCount: 1,
    senderEmail: "sender@example.test", recipients: ["customer@example.test"], subject: "Sale", html: "<p>Sale</p>", text: "Sale"
  };
  return { calls, ports, job, flow: new DeliverEmailJob(ports, logger) };
}

test("welcome email job uses durable email identity and does not enter bulk delivery", async () => {
  const f = deliveryFixture();
  assert.equal(await f.flow.execute({ type: "email.account_welcome.requested", emailJobId: "welcome-1", userSub: "user", toEmail: "customer@example.test" }, { receiveCount: 1 }), "completed");
  assert.deepEqual(f.calls, ["welcome:welcome-1"]);
});

test("order confirmation job marks routing processing before calling the email provider", async () => {
  const f = deliveryFixture();
  await f.flow.execute({ type: "email.order_confirmation.requested", emailJobId: "mail-1", campaignId: "confirmation", batchIndex: 0, batchCount: 1,
    toEmail: "customer@example.test", orderId: "order-1", totalAmount: 2000, createdAt: "now", items: [] }, { receiveCount: 1 });
  assert.deepEqual(f.calls, ["processing", "confirmation:order-1"]);
});

test("email processing marker failure prevents provider send and leaves job retryable", async () => {
  const f = deliveryFixture(), failure = new Error("marker unavailable");
  f.ports.markEmailRouteProcessing = async () => { throw failure; };
  await assert.rejects(f.flow.execute(f.job, { receiveCount: 1 }), error => error === failure);
  assert.deepEqual(f.calls, []);
});

test("an already advanced route still reaches the idempotent sender on redelivery", async () => {
  const f = deliveryFixture(); f.ports.markEmailRouteProcessing = async () => false;
  await f.flow.execute(f.job, { receiveCount: 2 });
  assert.deepEqual(f.calls, ["bulk:mail-1"]);
});

for (const status of ["accepted", "partial_sent", "already_processed", "failed", "unknown"] as const) {
  test(`bulk email outcome ${status} retains the worker acknowledgement contract`, async () => {
    const f = deliveryFixture(); let sends = 0;
    f.ports.sendBulkSaleEmailBatch = async input => {
      sends++; assert.equal(input.emailId, "mail-1"); assert.equal(input.relatedId, "campaign");
      assert.deepEqual(input.recipients, ["customer@example.test"]); return { status };
    };
    assert.equal(await f.flow.execute(f.job, { receiveCount: 1 }), status === "unknown" ? "unknown" : "completed");
    assert.equal(sends, 1);
  });
}

test("email provider throw propagates without blind retry inside the same invocation", async () => {
  const f = deliveryFixture(), failure = new Error("provider timeout"); let sends = 0;
  f.ports.sendBulkSaleEmailBatch = async () => { sends++; throw failure; };
  await assert.rejects(f.flow.execute(f.job, { receiveCount: 1 }), error => error === failure);
  assert.equal(sends, 1);
});

test("DLQ failure hook requires explicit testOnly opt-in", async () => {
  const f = deliveryFixture();
  assert.equal(await f.flow.execute(f.job, { receiveCount: 1, testMode: "fail" }), "completed");
  assert.deepEqual(f.calls, ["processing", "bulk:mail-1"]);
});

test("explicit DLQ failure/recovery hook never calls SES", async () => {
  const f = deliveryFixture();
  await assert.rejects(f.flow.execute(f.job, { receiveCount: 3, testMode: "fail", testOnly: {} }), /Injected failure/);
  assert.equal(await f.flow.execute(f.job, { receiveCount: 4, testMode: "recover", testOnly: { skipSesOnSuccess: true } }), "completed");
  assert.deepEqual(f.calls, ["processing", "processing"]);
});
