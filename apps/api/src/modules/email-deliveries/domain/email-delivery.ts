import { BusinessError } from "../../../common/domain/business-error.js";
export type EmailType = "inventory_daily_report" | "order_confirmation" | "payment_failure" | "order_failure" | "refund_status" | "sale_campaign" | "account_welcome";
export interface NewEmailDelivery {
    emailType: EmailType; senderEmail: string; subject: string;
    recipients: Array<{ email: string; type?: "to" | "cc" | "bcc"; recipientId?: string }>;
    reportId?: string; relatedId?: string; emailId?: string; html?: string; text?: string;
}
export interface PendingEmailMeta extends EmailDeliverySnapshot {
    emailType: EmailType; senderEmail: string; subject: string; recipientCount: number;
    reportId?: string; relatedId?: string; sendStatus: "pending"; createdAt: string; updatedAt: string;
}
export interface PendingEmailRecipient extends EmailRecipientSnapshot {
    recipientId: string; recipientType: "to" | "cc" | "bcc"; status: "pending"; updatedAt: string;
}
export interface EmailDeliverySnapshot {
    id: string;
    html?: string;
    text?: string;
}
export interface EmailRecipientSnapshot {
    recipientEmail: string;
    status: string;
}
export class EmailDelivery<T extends EmailDeliverySnapshot = EmailDeliverySnapshot, R extends EmailRecipientSnapshot = EmailRecipientSnapshot> {
    readonly #meta: Readonly<T>;
    readonly #recipients: readonly Readonly<R>[];
    constructor(meta: T, recipients: readonly R[] = []) {
        this.#meta = Object.freeze({ ...meta });
        this.#recipients = Object.freeze(recipients.map(recipient => Object.freeze({ ...recipient })));
    }
    toSnapshot(): { meta: T; recipients: R[] } {
        return { meta: { ...this.#meta }, recipients: this.#recipients.map(recipient => ({ ...recipient })) };
    }
    static create(input: NewEmailDelivery, newId: () => string, now: number): EmailDelivery<PendingEmailMeta, PendingEmailRecipient> {
        if (!input.recipients.length || input.recipients.length > 50) throw new Error("An email batch must contain from 1 to 50 recipients.");
        const normalized = input.recipients.map(recipient => ({ ...recipient, email: recipient.email.trim().toLowerCase() }));
        if (normalized.some(recipient => !recipient.email)) throw new Error("Recipient email is required.");
        if (new Set(normalized.map(recipient => recipient.email)).size !== normalized.length) throw new Error("A recipient may appear only once in an email batch.");
        const id = input.emailId ?? newId();
        if (!id.trim() || !Number.isFinite(new Date(now).getTime())) throw new BusinessError("INVALID_INPUT", "Invalid email delivery identity or time.");
        const timestamp = new Date(now).toISOString();
        const recipients: PendingEmailRecipient[] = normalized.map(recipient => ({ recipientId: recipient.recipientId ?? newId(),
            recipientEmail: recipient.email, recipientType: recipient.type ?? "to", status: "pending", updatedAt: timestamp }));
        if (recipients.some(recipient => !recipient.recipientId.trim()) || new Set(recipients.map(recipient => recipient.recipientId)).size !== recipients.length) {
            throw new BusinessError("INVALID_INPUT", "Invalid email recipient identity.");
        }
        return new EmailDelivery({ id, emailType: input.emailType, senderEmail: input.senderEmail, subject: input.subject,
            recipientCount: recipients.length, sendStatus: "pending", reportId: input.reportId, relatedId: input.relatedId,
            html: input.html, text: input.text, createdAt: timestamp, updatedAt: timestamp }, recipients);
    }
    static createSingle(input: Omit<NewEmailDelivery, "recipients"> & { recipientEmail: string }, newId: () => string, now: number) {
        const emailId = input.emailId ?? newId();
        return EmailDelivery.create({ ...input, emailId, recipients: [{ email: input.recipientEmail, recipientId: emailId }] }, newId, now);
    }
    publicSnapshot(): Omit<T, "html" | "text"> {
        const { html: _html, text: _text, ...safe } = this.#meta;
        return safe;
    }
    retryRecipients(): string[] {
        if (!this.#meta.html || !this.#meta.text) {
            throw new BusinessError("INVALID_INPUT", "This legacy delivery does not retain its content and cannot be retried safely.");
        }
        const recipients = this.#recipients.filter(recipient => EmailDelivery.isSafelyRetryable(recipient.status)).map(recipient => recipient.recipientEmail);
        if (!recipients.length)
            throw new BusinessError("INVALID_INPUT", "No recipient has a safely retryable delivery status.");
        return recipients;
    }
    static isSafelyRetryable(status: string) { return ["failed", "not_sent", "rejected"].includes(status); }
}
