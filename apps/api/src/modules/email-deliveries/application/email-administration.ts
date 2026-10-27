import { EmailCampaign } from "../domain/email-campaign.js";
import { EmailDelivery } from "../domain/email-delivery.js";
import { EmailRoute } from "../domain/email-route.js";
import { ApplicationError } from "../../../common/application/application-error.js";
import type { ApplicationLogger } from "../../../common/application/queue-events.js";
import type { DeliveryMeta, EmailAdministrationPorts } from "./ports.js";
export interface SaleMailInput {
    recipients: string[];
    subject: string;
    body: string;
    idempotencyKey?: string;
}
export interface RetryMailInput {
    idempotencyKey?: string;
}
function publicMeta(meta: DeliveryMeta) {
    const { html: _html, text: _text, ...safe } = meta as typeof meta & {
        html?: string;
        text?: string;
    };
    return safe;
}
export class EmailAdministration {
    constructor(private readonly ports: EmailAdministrationPorts, private readonly config: {
        senderEmail?: string;
        eventsEnabled: boolean;
    }, private readonly newId: () => string, private readonly hash: (value: string) => string, private readonly logger: ApplicationLogger) { }
    private async publishTrackedSaleEvent(input: {
        campaignId: string;
        emailJobId: string;
        batchIndex: number;
        batchCount: number;
        senderEmail: string;
        recipients: string[];
        subject: string;
        html: string;
        text: string;
    }) {
        const trackedEvent = {
            channel: "platform" as const,
            source: "supermarket.email",
            detailType: "email.sale_campaign.requested",
            detail: {
                type: "email.sale_campaign.requested",
                campaignId: input.campaignId,
                emailJobId: input.emailJobId,
                batchIndex: input.batchIndex,
                batchCount: input.batchCount,
                senderEmail: input.senderEmail,
                recipients: input.recipients,
                subject: input.subject,
                html: input.html,
                text: input.text
            }
        };
        await this.ports.ensureEmailRoute(EmailRoute.create({
            emailJobId: input.emailJobId,
            campaignId: input.campaignId,
            batchIndex: input.batchIndex,
            batchCount: input.batchCount,
            event: trackedEvent
        }, Date.now()));
        try {
            const event = await this.ports.publishEventBridgeEvent(trackedEvent);
            await this.ports.markEmailRoutePublished({
                emailJobId: input.emailJobId,
                eventId: event.eventId
            });
            return event;
        }
        catch (error) {
            // SDK/network errors can be ambiguous: EventBridge may have accepted the
            // event even when the caller did not receive a response. Never call this
            // a definite failure or blindly generate a new emailJobId.
            try {
                const recoveryScheduled = await this.ports.markEmailRoutePublishRetry({
                    emailJobId: input.emailJobId,
                    reason: error instanceof Error ? error.message : "Unknown EventBridge publish failure",
                    attempt: 1,
                    nextPublishAt: this.ports.nextEmailPublishRetryAt(1)
                });
                return {
                    eventBusName: "platform",
                    eventId: "",
                    recoveryScheduled,
                    publishOutcome: recoveryScheduled ? "RETRY_SCHEDULED" as const : "ACCEPTED_OR_ALREADY_ADVANCED" as const
                };
            }
            catch (trackingError) {
                this.logger.error(JSON.stringify({
                    flow: "email_routing",
                    stage: "publish_unknown_tracking_failed",
                    emailJobId: input.emailJobId,
                    message: trackingError instanceof Error ? trackingError.message : "unknown"
                }));
                throw error;
            }
        }
    }
    async list(limit = "30") {
        const parsedLimit = Number(limit);
        const items = await this.ports.listEmailDeliveriesWithStatus(Number.isFinite(parsedLimit) ? parsedLimit : 30);
        return { items: items.map((item) => publicMeta(item)) };
    }
    async publishFailures(limit = "50") {
        const parsedLimit = Number(limit);
        const routes = await this.ports.listFailedEmailRoutePublishes(Number.isFinite(parsedLimit) ? parsedLimit : 50);
        return {
            items: routes.map((route) => ({
                emailJobId: route.emailJobId,
                campaignId: route.campaignId,
                batchIndex: route.batchIndex,
                batchCount: route.batchCount,
                subject: typeof route.eventDetail?.subject === "string" ? route.eventDetail.subject : undefined,
                recipientCount: Array.isArray(route.eventDetail?.recipients) ? route.eventDetail.recipients.length : undefined,
                eventBusName: route.eventBusName,
                eventSource: route.eventSource,
                eventDetailType: route.eventDetailType,
                publishAttempts: route.publishAttempts,
                manualRetryCount: route.manualRetryCount ?? 0,
                failureReason: route.publishFailureReason,
                failedAt: route.updatedAt
            }))
        };
    }
    async retryPublishFailure(emailJobId: string) {
        const normalizedId = emailJobId.trim();
        if (!normalizedId || normalizedId.length > 128)
            throw new ApplicationError("INVALID_INPUT", "Invalid email job ID.");
        const scheduled = await this.ports.retryFailedEmailRoutePublish(normalizedId);
        if (!scheduled) {
            throw new ApplicationError("CONFLICT", "This publish is missing, already being retried, or has already advanced.");
        }
        this.logger.warn(JSON.stringify({
            flow: "email_routing",
            stage: "admin_publish_retry_scheduled",
            emailJobId: normalizedId
        }));
        return { status: "retry_scheduled", emailJobId: normalizedId };
    }
    async detail(emailId: string) {
        const delivery = await this.ports.getEmailDelivery(emailId.trim());
        if (!delivery)
            throw new ApplicationError("NOT_FOUND", "Email delivery not found.");
        return { meta: publicMeta(delivery.meta), recipients: delivery.recipients };
    }
    async retrySafeRecipients(emailId: string, input: RetryMailInput) {
        if (!this.config.eventsEnabled)
            throw new ApplicationError("INVALID_INPUT", "EventBridge platform bus is not configured.");
        const source = await this.ports.getEmailDelivery(emailId.trim());
        if (!source)
            throw new ApplicationError("NOT_FOUND", "Email delivery not found.");
        const recipients = new EmailDelivery(source.meta, source.recipients).retryRecipients();
        const retryKey = input.idempotencyKey ?? this.newId();
        const retryEmailJobId = this.hash(`${source.meta.id}:retry:${retryKey}`);
        const event = await this.publishTrackedSaleEvent({
            campaignId: source.meta.relatedId ?? source.meta.id,
            emailJobId: retryEmailJobId,
            batchIndex: 0,
            batchCount: 1,
            senderEmail: source.meta.senderEmail,
            recipients,
            subject: source.meta.subject,
            html: source.meta.html,
            text: source.meta.text
        });
        this.logger.log(JSON.stringify({ flow: "email_campaign", stage: event.eventId ? "retry_eventbridge_published" : "retry_eventbridge_recovery_scheduled", sourceEmailId: source.meta.id, emailJobId: retryEmailJobId, eventId: event.eventId, recipientCount: recipients.length }));
        return { status: event.eventId ? "queued" : "retry_scheduled", emailJobId: retryEmailJobId, recipientCount: recipients.length };
    }
    async sendSaleCampaign(input: SaleMailInput) {
        if (!this.config.senderEmail)
            throw new ApplicationError("INVALID_INPUT", "SES sender email is not configured.");
        if (!this.config.eventsEnabled)
            throw new ApplicationError("INVALID_INPUT", "EventBridge platform bus is not configured.");
        const campaignId = input.idempotencyKey ?? this.newId();
        const campaign = new EmailCampaign(campaignId, input.subject, input.body, input.recipients);
        const recipientBatches = campaign.batches();
        const published = await Promise.all(recipientBatches.map(async (recipients, batchIndex) => {
            const emailJobId = this.hash(`${campaignId}:${batchIndex}`);
            const event = await this.publishTrackedSaleEvent({
                campaignId,
                emailJobId,
                batchIndex,
                batchCount: recipientBatches.length,
                senderEmail: this.config.senderEmail!,
                recipients,
                subject: input.subject,
                // The composer is plain text. Escaping prevents admin draft text
                // from becoming arbitrary HTML in the recipient inbox.
                html: campaign.html,
                text: input.body
            });
            this.logger.log(JSON.stringify({
                flow: "email_campaign",
                stage: event.eventId ? "eventbridge_published" : "eventbridge_recovery_scheduled",
                campaignId,
                emailJobId,
                eventId: event.eventId,
                eventBusName: event.eventBusName,
                batchIndex,
                recipientCount: recipients.length
            }));
            return { emailJobId, eventId: event.eventId, recoveryScheduled: "recoveryScheduled" in event ? event.recoveryScheduled : false, recipientCount: recipients.length };
        }));
        return {
            campaignId,
            status: "queued",
            recipientCount: input.recipients.length,
            batchCount: published.length,
            batches: published
        };
    }
}
