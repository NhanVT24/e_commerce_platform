import "reflect-metadata";
import { z } from "zod";
import { emailConfig } from "../../../config/email-config.js";
import { recordEmailFeedback } from "../../../modules/email-deliveries/infrastructure/email-feedback-store.js";
import type { FeedbackStatus } from "../../../modules/email-deliveries/email-feedback.js";

const affectedRecipient = z.object({ emailAddress: z.string(), diagnosticCode: z.string().optional() });
const details = z.object({
  timestamp: z.string().datetime({ offset: true }).optional(),
  recipients: z.array(z.string()).optional(),
  bouncedRecipients: z.array(affectedRecipient).optional(),
  complainedRecipients: z.array(affectedRecipient).optional(),
  delayedRecipients: z.array(affectedRecipient).optional(),
  bounceType: z.string().optional(),
  reason: z.string().optional(),
  errorMessage: z.string().optional()
});
const sesSchema = z.object({
  eventType: z.string(),
  mail: z.object({
    messageId: z.string().min(1),
    timestamp: z.string().datetime({ offset: true }),
    destination: z.array(z.string()).optional(),
    tags: z.record(z.string(), z.array(z.string())).optional()
  }),
  delivery: details.optional(), bounce: details.optional(), complaint: details.optional(),
  deliveryDelay: details.optional(), reject: details.optional(), failure: details.optional()
});
const events: Record<string, { status: FeedbackStatus; field?: "delivery" | "bounce" | "complaint" | "deliveryDelay" | "reject" | "failure" }> = {
  Send: { status: "accepted" },
  Delivery: { status: "delivered", field: "delivery" },
  Bounce: { status: "bounced", field: "bounce" },
  Complaint: { status: "complained", field: "complaint" },
  DeliveryDelay: { status: "delivery_delayed", field: "deliveryDelay" },
  Reject: { status: "rejected", field: "reject" },
  "Rendering Failure": { status: "rejected", field: "failure" }
};

type SnsEvent = { Records?: Array<{ Sns?: { Message?: string; MessageId?: string; TopicArn?: string } }> };

export async function processSesMessage(message: string) {
  const event = sesSchema.parse(JSON.parse(message));
  const mapping = events[event.eventType];
  const emailId = event.mail.tags?.emailId?.[0];
  const recipientId = event.mail.tags?.recipientId?.[0];
  const reportId = event.mail.tags?.reportId?.[0];
  if (!mapping || (!emailId && !reportId)) return { ignored: "unrelated_ses_event" };
  const detail = mapping.field ? event[mapping.field] : undefined;
  if (mapping.field && !detail) throw new Error("SES event is missing its detail object.");
  const recipientEmails = event.eventType === "Delivery" ? detail?.recipients
    : event.eventType === "Bounce" ? detail?.bouncedRecipients?.map((r) => r.emailAddress)
      : event.eventType === "Complaint" ? detail?.complainedRecipients?.map((r) => r.emailAddress)
        : event.eventType === "DeliveryDelay" ? detail?.delayedRecipients?.map((r) => r.emailAddress)
          : event.mail.destination;
  if (["Delivery", "Bounce", "DeliveryDelay"].includes(event.eventType) && !recipientEmails?.length) {
    throw new Error("SES event is missing affected recipients.");
  }
  const eventAt = detail?.timestamp ?? event.mail.timestamp;
  const input = {
    status: mapping.status,
    statusAt: eventAt,
    sesMessageId: event.mail.messageId,
    recipientEmails: recipientEmails?.length ? recipientEmails : undefined,
    failureReason: detail?.reason ?? detail?.errorMessage ?? detail?.bounceType
  };
  // This is intentionally metadata-only: SES payloads can expose BCC addresses
  // and headers, so raw events must not be copied into CloudWatch Logs.
  console.info("[ses-feedback] event_resolved", {
    sesMessageId: event.mail.messageId,
    eventType: event.eventType,
    emailId,
    recipientId,
    reportId,
    affectedRecipientCount: input.recipientEmails?.length ?? 0,
    correlation: recipientId ? "recipient_tag" : "affected_recipient_addresses"
  });
  return recordEmailFeedback.execute(input, { emailId, recipientId, reportId });
}

export const handler = async (event: SnsEvent) => {
  const results = await Promise.allSettled((event.Records ?? []).map(async ({ Sns: sns }) => {
    if (!sns?.Message) throw new Error("Missing SNS message.");
    // This log proves SNS has delivered a record to Lambda. It does not expose
    // message content; `event_resolved` logs the safe SES metadata afterward.
    console.info("[ses-feedback] sns_received", {
      snsMessageId: sns.MessageId,
      topicArn: sns.TopicArn,
      messageBytes: Buffer.byteLength(sns.Message, "utf8")
    });
    if (emailConfig.SES_EVENTS_TOPIC_ARN && sns.TopicArn !== emailConfig.SES_EVENTS_TOPIC_ARN) throw new Error("Unexpected SNS topic.");
    const result = await processSesMessage(sns.Message);
    console.info("[ses-feedback] processed", { snsMessageId: sns.MessageId, ...result });
  }));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    // Do not log raw events: they can contain BCC addresses and message headers.
    console.error("[ses-feedback] processing_failed", { count: failures.length });
    throw new Error(`Failed to process ${failures.length} SES event(s).`);
  }
  return { processed: results.length };
};
