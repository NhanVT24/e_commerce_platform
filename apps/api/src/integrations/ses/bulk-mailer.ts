import { GetAccountCommand, GetEmailIdentityCommand, SendBulkEmailCommand, SendEmailCommand } from "@aws-sdk/client-sesv2";
import crypto from "node:crypto";
import { emailConfig } from "../../config/email-config.js";
import {
  createPendingEmailDeliveryBatch,
  markBulkEmailSendOutcome,
  markEmailFailed,
  markEmailRecipientAccepted,
  markEmailRecipientNotSent,
  markEmailRecipientUnknown,
  markEmailUnknown,
  sesTrackingTags,
  type EmailType
} from "../../modules/email-deliveries/email-delivery.repository.js";
import { sesClient } from "./client.js";
import { replyToAddresses } from "./sender-config.js";

const maxRecipientsPerSend = 50;
const mailboxSimulatorDomain = "simulator.amazonses.com";
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let productionAccess: Promise<boolean> | undefined;

type RecipientType = "to" | "cc" | "bcc";
type SharedRecipient = { email: string; type: RecipientType };

export type SharedEmailInput = {
  emailId?: string;
  emailType: EmailType;
  senderEmail: string;
  subject: string;
  html: string;
  text?: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  relatedId?: string;
};

export type BulkSaleEmailInput = {
  senderEmail: string;
  subject: string;
  html: string;
  text?: string;
  recipients: string[];
  relatedId?: string;
};

export type BulkSaleEmailBatchInput = BulkSaleEmailInput & {
  // Stable across EventBridge/SQS redelivery. It is also the email delivery
  // aggregate id, so a duplicate event never results in another SES request.
  emailId: string;
};

export type BulkSaleEmailBatchResult = {
  emailId: string;
  status: "accepted" | "partial_sent" | "failed" | "unknown" | "already_processed";
  // Safe operational context only. Recipient addresses are redacted before a
  // worker writes this value to CloudWatch.
  failureReason?: string;
};

function normalizeEmail(value: string) { return value.trim().toLowerCase(); }
function safeErrorReason(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown SES bulk send failure";
  return message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]").slice(0, 500);
}
function chunks<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function normalizeRecipients(recipients: SharedRecipient[]) {
  const normalized = recipients.map((recipient) => ({ ...recipient, email: normalizeEmail(recipient.email) }));
  if (normalized.some((recipient) => !emailShape.test(recipient.email))) throw new Error("Recipient email address is invalid.");
  if (new Set(normalized.map((recipient) => recipient.email)).size !== normalized.length) throw new Error("A recipient may appear only once in an email.");
  return normalized;
}

async function isSandboxRecipientAllowed(email: string) {
  if (email.endsWith(`@${mailboxSimulatorDomain}`)) return true;
  productionAccess ??= sesClient.send(new GetAccountCommand({})).then((account) => account.ProductionAccessEnabled === true);
  if (await productionAccess) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  // Sandbox allows a verified address OR its verified domain. Checking both
  // prevents an optional CC/BCC from rejecting the shared SendEmail request.
  const identities = await Promise.allSettled([email, domain].map((identity) => sesClient.send(new GetEmailIdentityCommand({ EmailIdentity: identity }))));
  return identities.some((result) => result.status === "fulfilled" && result.value.VerifiedForSendingStatus === true);
}

function content(input: Pick<SharedEmailInput | BulkSaleEmailInput, "subject" | "html" | "text">) {
  return {
    Template: {
      // SES SendBulkEmail requires template data even if this inline template
      // contains no replacement variables. `{}` avoids a request-level reject.
      TemplateContent: { Subject: input.subject, Html: input.html, ...(input.text ? { Text: input.text } : {}) },
      TemplateData: "{}"
    }
  };
}

/**
 * Sends one visible email with a required To and optional CC/BCC. This is
 * deliberately not bulk: valid CC/BCC recipients retain the original group
 * headers. Optional recipients blocked by the SES sandbox are excluded first.
 */
export async function sendSharedEmail(input: SharedEmailInput) {
  if (!emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME) throw new Error("Missing SES feedback configuration set.");
  const recipients = normalizeRecipients([
    { email: input.to, type: "to" },
    ...(input.cc ?? []).map((email) => ({ email, type: "cc" as const })),
    ...(input.bcc ?? []).map((email) => ({ email, type: "bcc" as const }))
  ]);
  if (recipients.length > maxRecipientsPerSend) throw new Error("A shared SES email may have at most 50 recipients.");
  let created: Awaited<ReturnType<typeof createPendingEmailDeliveryBatch>>;
  try {
    created = await createPendingEmailDeliveryBatch({
      emailType: input.emailType, senderEmail: input.senderEmail, subject: input.subject,
      recipients: recipients.map(({ email, type }) => ({ email, type })), relatedId: input.relatedId, emailId: input.emailId, html: input.html, text: input.text
    });
  } catch (error) {
    if (input.emailId && (error as { name?: string } | undefined)?.name === "TransactionCanceledException") {
      return { emailId: input.emailId, status: "already_processed" as const, skipped: [] };
    }
    throw error;
  }

  const { meta, recipients: records } = created;

  let allowed: Array<{ recipient: SharedRecipient; record: typeof records[number]; allowed: boolean }>;
  try {
    allowed = await Promise.all(recipients.map(async (recipient, index) => ({
      recipient, record: records[index], allowed: await isSandboxRecipientAllowed(recipient.email)
    })));
  } catch (error) {
    // Identity lookup itself is an AWS dependency. Preserve uncertainty rather
    // than leaving an orphaned pending attempt if that preflight is unavailable.
    await markEmailUnknown(meta.id, error instanceof Error ? error.message : "Unable to validate SES recipient eligibility");
    throw error;
  }
  const primary = allowed.find((value) => value.recipient.type === "to");
  if (!primary?.allowed) {
    // A shared email without its primary To loses its business meaning. Mark
    // every child as not_sent rather than pretending SES delivered anything.
    await Promise.all([
      markEmailFailed(meta.id, "Primary recipient is not allowed by the SES sandbox."),
      ...allowed.map(({ record }) => markEmailRecipientNotSent({ emailId: meta.id, recipientId: record.recipientId, failureReason: "Primary recipient is not allowed by the SES sandbox." }))
    ]);
    return { emailId: meta.id, status: "failed" as const, skipped: recipients.map((recipient) => recipient.email) };
  }
  const skipped = allowed.filter((value) => !value.allowed);
  await Promise.all(skipped.map(({ record }) => markEmailRecipientNotSent({
    emailId: meta.id, recipientId: record.recipientId, failureReason: "Recipient is not allowed by the SES sandbox."
  })));
  const deliverable = allowed.filter((value) => value.allowed);

  try {
    const result = await sesClient.send(new SendEmailCommand({
      FromEmailAddress: input.senderEmail,
      ReplyToAddresses: replyToAddresses(),
      Destination: {
        ToAddresses: deliverable.filter((value) => value.recipient.type === "to").map((value) => value.recipient.email),
        ...(deliverable.some((value) => value.recipient.type === "cc") ? { CcAddresses: deliverable.filter((value) => value.recipient.type === "cc").map((value) => value.recipient.email) } : {}),
        ...(deliverable.some((value) => value.recipient.type === "bcc") ? { BccAddresses: deliverable.filter((value) => value.recipient.type === "bcc").map((value) => value.recipient.email) } : {})
      },
      ConfigurationSetName: emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME,
      EmailTags: sesTrackingTags({ emailId: meta.id, emailType: input.emailType }),
      Content: { Simple: { Subject: { Data: input.subject, Charset: "UTF-8" }, Body: { Html: { Data: input.html, Charset: "UTF-8" }, ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}) } } }
    }));
    if (!result.MessageId) throw new Error("SES accepted the shared email without a MessageId.");
    await Promise.all([
      markBulkEmailSendOutcome({ emailId: meta.id, acceptedCount: deliverable.length, recipientCount: recipients.length, failureReason: skipped.length ? "One or more optional recipients were excluded before sending." : undefined }),
      ...deliverable.map(({ record }) => markEmailRecipientAccepted({ emailId: meta.id, recipientId: record.recipientId, sesMessageId: result.MessageId }))
    ]);
    return { emailId: meta.id, sesMessageId: result.MessageId, status: skipped.length ? "partial_sent" as const : "accepted" as const, skipped: skipped.map(({ recipient }) => recipient.email) };
  } catch (error) {
    // A timeout/error may still have been accepted by SES; do not overwrite all
    // recipients as failed or automatically retry this shared mail.
    const failureReason = error instanceof Error ? error.message : "Unknown SES send failure";
    await Promise.all([
      markEmailUnknown(meta.id, failureReason),
      ...deliverable.map(({ record }) => markEmailRecipientUnknown({ emailId: meta.id, recipientId: record.recipientId, failureReason }))
    ]);
    throw error;
  }
}

/**
 * Sale messages are independent deliveries. SES returns a result per entry,
 * therefore one bad address does not erase successful recipients in the batch.
 */
export async function sendBulkSaleEmail(input: BulkSaleEmailInput) {
  if (!emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME) throw new Error("Missing SES feedback configuration set.");
  const recipientEmails = input.recipients.map(normalizeEmail);
  if (!recipientEmails.length || recipientEmails.some((email) => !emailShape.test(email))) throw new Error("At least one valid recipient email is required.");
  if (new Set(recipientEmails).size !== recipientEmails.length) throw new Error("A bulk recipient may appear only once.");
  const attempts: Array<{ emailId: string; status: "accepted" | "partial_sent" | "failed" | "unknown" }> = [];

  for (const recipientChunk of chunks(recipientEmails, maxRecipientsPerSend)) {
    const result = await sendBulkSaleEmailBatch({ ...input, recipients: recipientChunk, emailId: crypto.randomUUID() });
    // This synchronous compatibility path creates a fresh random id, so an
    // idempotency collision cannot occur. Keep its public return contract.
    if (result.status !== "already_processed") {
      attempts.push({
        emailId: result.emailId,
        status: result.status as "accepted" | "partial_sent" | "failed" | "unknown"
      });
    }
  }
  return attempts;
}

/**
 * Sends exactly one EventBridge email batch (at most 50 recipients). `emailId`
 * must be stable for redelivery; creating the delivery record is the idempotency
 * claim before calling SES.
 */
export async function sendBulkSaleEmailBatch(input: BulkSaleEmailBatchInput): Promise<BulkSaleEmailBatchResult> {
  if (!emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME) throw new Error("Missing SES feedback configuration set.");
  const recipientEmails = input.recipients.map(normalizeEmail);
  if (!recipientEmails.length || recipientEmails.length > maxRecipientsPerSend || recipientEmails.some((email) => !emailShape.test(email))) {
    throw new Error("An email job must contain from 1 to 50 valid recipient addresses.");
  }
  if (new Set(recipientEmails).size !== recipientEmails.length) throw new Error("A bulk recipient may appear only once.");

  let created: Awaited<ReturnType<typeof createPendingEmailDeliveryBatch>>;
  try {
    created = await createPendingEmailDeliveryBatch({
      emailType: "sale_campaign", senderEmail: input.senderEmail, subject: input.subject,
      recipients: recipientEmails.map((email) => ({ email })), relatedId: input.relatedId, emailId: input.emailId, html: input.html, text: input.text
    });
  } catch (error) {
    // The conditional write is the idempotency barrier for EventBridge/SQS
    // at-least-once delivery. Do not issue another SES request on a duplicate.
    if ((error as { name?: string } | undefined)?.name === "TransactionCanceledException") {
      return { emailId: input.emailId, status: "already_processed" };
    }
    throw error;
  }

  const { meta, recipients } = created;
  try {
      const result = await sesClient.send(new SendBulkEmailCommand({
        FromEmailAddress: input.senderEmail,
        ReplyToAddresses: replyToAddresses(),
        ConfigurationSetName: emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME,
        DefaultContent: content(input),
        BulkEmailEntries: recipients.map((recipient) => ({
          Destination: { ToAddresses: [recipient.recipientEmail] },
          // ReplacementTags are copied to this entry's SNS event. They remove
          // the need for a DynamoDB scan to find a bulk recipient by MessageId.
          ReplacementTags: sesTrackingTags({ emailId: meta.id, recipientId: recipient.recipientId, emailType: "sale_campaign" })
        }))
      }));
      const results = result.BulkEmailEntryResults;
      if (!results || results.length !== recipients.length) throw new Error("SES bulk response did not include one result per recipient.");
      const acceptedCount = results.filter((entry) => entry.Status === "SUCCESS" && entry.MessageId).length;
      await Promise.all(results.map((entry, index) => entry.Status === "SUCCESS" && entry.MessageId
        ? markEmailRecipientAccepted({ emailId: meta.id, recipientId: recipients[index].recipientId, sesMessageId: entry.MessageId })
        : markEmailRecipientNotSent({ emailId: meta.id, recipientId: recipients[index].recipientId, failureReason: entry.Error ?? entry.Status ?? "SES did not accept this recipient." })
      ));
      const status = await markBulkEmailSendOutcome({
        emailId: meta.id, acceptedCount, recipientCount: recipients.length,
        failureReason: acceptedCount === recipients.length ? undefined : "One or more bulk recipients were not accepted by SES."
      });
      return { emailId: meta.id, status };
  } catch (error) {
      const failureReason = safeErrorReason(error);
      // A rejected API call can be ambiguous (notably network timeouts): SES
      // might have accepted it despite the caller seeing an error. `unknown`
      // is deliberately distinct from `failed`, but it must never look pending.
      await Promise.all([
        markEmailUnknown(meta.id, failureReason),
        ...recipients.map((recipient) => markEmailRecipientUnknown({ emailId: meta.id, recipientId: recipient.recipientId, failureReason }))
      ]);
    return { emailId: meta.id, status: "unknown", failureReason };
  }
}
