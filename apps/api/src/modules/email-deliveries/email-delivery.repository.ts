import crypto from "node:crypto";
import { ConditionalCheckFailedException, GetItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { feedbackUpdate, type FeedbackStatus } from "./email-feedback.js";
import { databaseConfig } from "../../config/database-config.js";
import { rawDb } from "../../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

export type EmailDeliveryStatus = "pending" | "accepted" | "delivered" | "bounced" | "complained" | "rejected" | "delivery_delayed" | "failed" | "not_sent" | "unknown";
export type EmailType = "inventory_daily_report" | "order_confirmation" | "payment_failure" | "order_failure" | "refund_status" | "sale_campaign" | "account_welcome";

export type EmailDeliveryMeta = {
  PK: string; SK: "META"; entityType: "EMAIL"; id: string; emailType: EmailType;
  senderEmail: string; subject: string; recipientCount: number; reportId?: string; relatedId?: string;
  // Kept server-side only so a safe retry can reuse the exact original body.
  // Controllers must never expose these fields in delivery-history responses.
  html?: string; text?: string;
  // This is the aggregate submit result, not the delivery outcome. Delivery is
  // tracked on each RECIPIENT item because a bulk send can succeed partially.
  sendStatus: "pending" | "accepted" | "partial_sent" | "failed" | "unknown";
  sesMessageId?: string; failureReason?: string;
  createdAt: string; updatedAt: string;
};

// Source of truth for one mailbox recipient. A parent META groups an operator action/campaign.
export type EmailDeliveryRecord = {
  PK: string; SK: `RECIPIENT#${string}`; entityType: "EMAIL_RECIPIENT";
  recipientId: string;
  recipientEmail: string; recipientType: "to" | "cc" | "bcc";
  status: EmailDeliveryStatus; statusAt?: string; failureReason?: string;
  // Bulk SES sends return one MessageId for each entry. Keeping it on the
  // recipient lets SNS feedback correlate without scanning an entire campaign.
  sesMessageId?: string;
  updatedAt: string;
};

// Returned to existing single-recipient callers. These convenience values are
// not persisted on the RECIPIENT item; they are derivable from the parent/key.
export type CreatedEmailDelivery = EmailDeliveryRecord & { id: string; emailId: string; emailType: EmailType };

function metaKey(emailId: string) { return { PK: `EMAIL#${emailId}`, SK: "META" } as const; }
function recipientKey(emailId: string, recipientId: string) { return { PK: `EMAIL#${emailId}`, SK: `RECIPIENT#${recipientId}` } as const; }
function item(value: Record<string, unknown>) { return marshall(value, { removeUndefinedValues: true }); }
function isConditionalFailure(error: unknown) {
  return error instanceof ConditionalCheckFailedException || (error as { name?: string } | undefined)?.name === "ConditionalCheckFailedException";
}

// SES copies these values into Delivery/Bounce/Complaint events. They are the
// correlation keys used by the event consumer; never put customer data in tags.
export function sesTrackingTags(input: { emailId: string; recipientId?: string; emailType: EmailType }) {
  const tags = [
    { Name: "emailId", Value: input.emailId },
    { Name: "emailType", Value: input.emailType }
  ];
  if (input.recipientId) tags.push({ Name: "recipientId", Value: input.recipientId });
  return tags;
}

export async function createPendingEmailDeliveryBatch(input: {
  emailType: EmailType; senderEmail: string; subject: string;
  recipients: Array<{ email: string; type?: "to" | "cc" | "bcc" }>;
  reportId?: string; relatedId?: string; emailId?: string; html?: string; text?: string;
}) {
  // SES accepts at most 50 recipients in a send. Larger campaigns are split
  // into independent bulk attempts by bulk-mailer.ts.
  if (input.recipients.length === 0 || input.recipients.length > 50) throw new Error("An email batch must contain from 1 to 50 recipients.");
  const normalized = input.recipients.map((recipient) => ({ email: recipient.email.trim().toLowerCase(), type: recipient.type ?? "to" }));
  if (normalized.some((recipient) => !recipient.email)) throw new Error("Recipient email is required.");
  if (new Set(normalized.map((recipient) => recipient.email)).size !== normalized.length) throw new Error("A recipient may appear only once in an email batch.");

  const now = new Date().toISOString();
  const emailId = input.emailId ?? crypto.randomUUID();
  const meta: EmailDeliveryMeta = {
    ...metaKey(emailId), entityType: "EMAIL", id: emailId, emailType: input.emailType,
    senderEmail: input.senderEmail, subject: input.subject, recipientCount: normalized.length, sendStatus: "pending",
    reportId: input.reportId, relatedId: input.relatedId, html: input.html, text: input.text, createdAt: now, updatedAt: now
  };
  const recipients: EmailDeliveryRecord[] = normalized.map((recipient) => {
    const recipientId = crypto.randomUUID();
    return {
      ...recipientKey(emailId, recipientId), entityType: "EMAIL_RECIPIENT", recipientId,
      recipientEmail: recipient.email, recipientType: recipient.type, status: "pending", updatedAt: now
    };
  });
  await rawDb.send(new TransactWriteItemsCommand({
    TransactItems: [meta, ...recipients].map((record) => ({ Put: {
      TableName, Item: item(record), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    } }))
  }));
  return { meta, recipients };
}

// Existing transactional email callers keep their API. Its emailId and recipientId are deliberately equal.
export async function createPendingEmailDelivery(input: {
  emailType: EmailType; recipientEmail: string; senderEmail: string; subject: string; reportId?: string; relatedId?: string; emailId?: string;
}) {
  const emailId = input.emailId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const meta: EmailDeliveryMeta = {
    ...metaKey(emailId), entityType: "EMAIL", id: emailId, emailType: input.emailType, senderEmail: input.senderEmail,
    subject: input.subject, recipientCount: 1, sendStatus: "pending", reportId: input.reportId, relatedId: input.relatedId, createdAt: now, updatedAt: now
  };
  const record: EmailDeliveryRecord = {
    ...recipientKey(emailId, emailId), entityType: "EMAIL_RECIPIENT", recipientId: emailId,
    recipientEmail: input.recipientEmail.trim().toLowerCase(), recipientType: "to", status: "pending", updatedAt: now
  };
  await rawDb.send(new TransactWriteItemsCommand({ TransactItems: [meta, record].map((value) => ({ Put: {
    TableName, Item: item(value), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
  } })) }));
  return { ...record, id: emailId, emailId, emailType: input.emailType } satisfies CreatedEmailDelivery;
}

export async function markEmailAccepted(emailId: string, sesMessageId: string) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: item(metaKey(emailId)),
      // SNS can arrive before the caller persists SendEmail's result. It may
      // repair pending/unknown attempts, but must never overwrite bulk's final
      // aggregate (accepted/partial_sent/failed).
      ConditionExpression: "attribute_exists(PK) AND sendStatus IN (:pending, :unknown)",
      UpdateExpression: "SET sendStatus = :accepted, sesMessageId = :sesMessageId, updatedAt = :updatedAt REMOVE failureReason",
      ExpressionAttributeValues: item({ ":pending": "pending", ":unknown": "unknown", ":accepted": "accepted", ":sesMessageId": sesMessageId, ":updatedAt": now })
    }));
    return true;
  } catch (error) { if (isConditionalFailure(error)) return false; throw error; }
}

export async function markEmailRecipientAccepted(input: { emailId: string; recipientId: string; sesMessageId?: string }) {
  return updateEmailRecipientStatus({ ...input, status: "accepted" });
}

export async function markEmailDeliveryAccepted(id: string, sesMessageId: string) {
  await markEmailAccepted(id, sesMessageId);
  return markEmailRecipientAccepted({ emailId: id, recipientId: id });
}

export async function markEmailRecipientFailed(input: { emailId: string; recipientId: string; failureReason: string }) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
    TableName, Key: item(recipientKey(input.emailId, input.recipientId)), ConditionExpression: "attribute_exists(PK) AND #status = :pending",
    UpdateExpression: "SET #status = :failed, failureReason = :failureReason, statusAt = :statusAt, updatedAt = :updatedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: item({ ":pending": "pending", ":failed": "failed", ":failureReason": input.failureReason.slice(0, 500), ":statusAt": now, ":updatedAt": now })
    }));
  } catch (error) { if (!isConditionalFailure(error)) throw error; }
}

export async function markEmailRecipientNotSent(input: { emailId: string; recipientId: string; failureReason: string }) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName, Key: item(recipientKey(input.emailId, input.recipientId)), ConditionExpression: "attribute_exists(PK) AND #status = :pending",
      UpdateExpression: "SET #status = :notSent, failureReason = :failureReason, statusAt = :statusAt, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: item({ ":pending": "pending", ":notSent": "not_sent", ":failureReason": input.failureReason.slice(0, 500), ":statusAt": now, ":updatedAt": now })
    }));
  } catch (error) { if (!isConditionalFailure(error)) throw error; }
}

export async function markEmailRecipientUnknown(input: { emailId: string; recipientId: string; failureReason: string }) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName, Key: item(recipientKey(input.emailId, input.recipientId)), ConditionExpression: "attribute_exists(PK) AND #status = :pending",
      UpdateExpression: "SET #status = :unknown, failureReason = :failureReason, statusAt = :statusAt, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: item({ ":pending": "pending", ":unknown": "unknown", ":failureReason": input.failureReason.slice(0, 500), ":statusAt": now, ":updatedAt": now })
    }));
  } catch (error) { if (!isConditionalFailure(error)) throw error; }
}

export async function markEmailDeliveryFailed(id: string, failureReason: string) {
  await markEmailFailed(id, failureReason);
  return markEmailRecipientFailed({ emailId: id, recipientId: id, failureReason });
}

export async function markEmailFailed(emailId: string, failureReason: string) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: item(metaKey(emailId)),
      ConditionExpression: "attribute_exists(PK) AND sendStatus = :pending",
      UpdateExpression: "SET sendStatus = :failed, failureReason = :failureReason, updatedAt = :updatedAt",
      ExpressionAttributeValues: item({ ":pending": "pending", ":failed": "failed", ":failureReason": failureReason.slice(0, 500), ":updatedAt": now })
    }));
  } catch (error) { if (!isConditionalFailure(error)) throw error; }
}

export async function markEmailUnknown(emailId: string, failureReason: string) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName, Key: item(metaKey(emailId)), ConditionExpression: "attribute_exists(PK) AND sendStatus = :pending",
      UpdateExpression: "SET sendStatus = :unknown, failureReason = :failureReason, updatedAt = :updatedAt",
      ExpressionAttributeValues: item({ ":pending": "pending", ":unknown": "unknown", ":failureReason": failureReason.slice(0, 500), ":updatedAt": now })
    }));
  } catch (error) { if (!isConditionalFailure(error)) throw error; }
}

export async function markBulkEmailSendOutcome(input: { emailId: string; acceptedCount: number; recipientCount: number; failureReason?: string }) {
  if (input.recipientCount < 1 || input.acceptedCount < 0 || input.acceptedCount > input.recipientCount) {
    throw new Error("Invalid bulk email send outcome.");
  }
  const sendStatus = input.acceptedCount === input.recipientCount ? "accepted"
    : input.acceptedCount > 0 ? "partial_sent" : "failed";
  const now = new Date().toISOString();
  const values: Record<string, unknown> = { ":status": sendStatus, ":updatedAt": now };
  let expression = "SET sendStatus = :status, updatedAt = :updatedAt";
  if (input.failureReason) {
    values[":failureReason"] = input.failureReason.slice(0, 500);
    expression += ", failureReason = :failureReason";
  } else {
    expression += " REMOVE failureReason";
  }
  await rawDb.send(new UpdateItemCommand({
    TableName, Key: item(metaKey(input.emailId)), ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: expression, ExpressionAttributeValues: item(values)
  }));
  return sendStatus;
}

export async function updateEmailRecipientStatus(input: {
  emailId: string; recipientId: string;
  status: FeedbackStatus;
  statusAt?: string;
  legacy?: boolean;
  recipientEmails?: string[];
  failureReason?: string;
  sesMessageId?: string;
}) {
  const key = input.legacy ? { PK: `EMAIL#${input.emailId}`, SK: "DETAIL" } : recipientKey(input.emailId, input.recipientId);
  const existing = await rawDb.send(new GetItemCommand({ TableName, Key: item(key), ConsistentRead: true }));
  if (!existing.Item) throw new Error(`Email feedback target not found: ${input.emailId}/${input.recipientId}`);
  const target = unmarshall(existing.Item);
  if (input.recipientEmails && !input.recipientEmails.some((address) => address.toLowerCase() === String(target.recipientEmail).toLowerCase())) {
    return false;
  }
  const now = new Date().toISOString();
  const { values, ...update } = feedbackUpdate(input.status, input.statusAt ?? now, now, input.sesMessageId ?? "unused", {
    timestampField: "statusAt",
    storeMessageId: Boolean(input.sesMessageId),
    preserveTimestamp: false
  });
  if (input.failureReason) {
    values[":reason"] = input.failureReason.slice(0, 500);
    update.UpdateExpression += ", failureReason = :reason";
  }
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName, Key: item(key), ...update, ExpressionAttributeValues: item(values)
    }));
    return true;
  } catch (error) { if (isConditionalFailure(error)) return false; throw error; }
}

// Legacy single-recipient tags have only emailId, so it doubles as recipientId.
export async function updateEmailDeliveryStatus(input: Omit<Parameters<typeof updateEmailRecipientStatus>[0], "emailId" | "recipientId"> & { id: string }) {
  // Pre-migration events have no recipientId tag. Prefer the new child, then the
  // old DETAIL item so in-flight feedback survives deploying the new schema.
  const result = await rawDb.send(new GetItemCommand({ TableName, Key: item(recipientKey(input.id, input.id)), ConsistentRead: true }));
  return updateEmailRecipientStatus({ ...input, emailId: input.id, recipientId: input.id, legacy: !result.Item });
}

export async function listEmailRecipients(emailId: string) {
  const recipients: EmailDeliveryRecord[] = [];
  let cursor: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue> | undefined;
  do {
    const result = await rawDb.send(new QueryCommand({ TableName, ConsistentRead: true,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: item({ ":pk": `EMAIL#${emailId}`, ":prefix": "RECIPIENT#" }), ExclusiveStartKey: cursor
    }));
    recipients.push(...(result.Items ?? []).map((value) => unmarshall(value) as EmailDeliveryRecord));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return recipients;
}

export async function listEmailDeliveries(limit = 30) {
  const result = await rawDb.send(new QueryCommand({
    TableName,
    IndexName: "EntityUpdatedAtIndex",
    KeyConditionExpression: "entityType = :entityType",
    ExpressionAttributeValues: item({ ":entityType": "EMAIL" }),
    ScanIndexForward: false,
    Limit: Math.min(Math.max(limit, 1), 100)
  }));
  return (result.Items ?? []).map((value) => unmarshall(value) as EmailDeliveryMeta);
}

/** The list badge shows the recipient outcome for one-recipient emails.
 * Bound concurrent reads because the admin history page can request 50 rows. */
export async function listEmailDeliveriesWithStatus(limit = 30) {
  const items = await listEmailDeliveries(limit);
  const result: Array<EmailDeliveryMeta & { deliveryStatus?: EmailDeliveryStatus }> = [];
  for (let offset = 0; offset < items.length; offset += 10) {
    const page = await Promise.all(items.slice(offset, offset + 10).map(async (meta) => {
      if (meta.recipientCount !== 1) return meta;
      const response = await rawDb.send(new QueryCommand({
        TableName,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: item({ ":pk": meta.PK, ":prefix": "RECIPIENT#" }),
        ProjectionExpression: "#status",
        ExpressionAttributeNames: { "#status": "status" },
        Limit: 1
      }));
      const deliveryStatus = response.Items?.[0]?.status?.S as EmailDeliveryStatus | undefined;
      return deliveryStatus ? { ...meta, deliveryStatus } : meta;
    }));
    result.push(...page);
  }
  return result;
}

export async function getEmailDelivery(emailId: string) {
  const result = await rawDb.send(new GetItemCommand({ TableName, Key: item(metaKey(emailId)), ConsistentRead: true }));
  if (!result.Item) return null;
  return {
    meta: unmarshall(result.Item) as EmailDeliveryMeta,
    recipients: await listEmailRecipients(emailId)
  };
}
