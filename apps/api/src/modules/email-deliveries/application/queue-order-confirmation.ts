import type { ConfirmationMail } from "../domain/email-jobs.js";
import { EmailRoute } from "../domain/email-route.js";
import type { EmailAdministrationPorts } from "./ports.js";
export class QueueOrderConfirmation {
    constructor(private readonly ports: Pick<EmailAdministrationPorts, "ensureEmailRoute" | "markEmailRoutePublished" | "markEmailRoutePublishRetry" | "nextEmailPublishRetryAt" | "publishEventBridgeEvent">, private readonly enabled: boolean, private readonly hash: (value: string) => string) { }
    async execute(input: ConfirmationMail) {
        if (!this.enabled) {
            throw new Error("Missing EVENTBRIDGE_PLATFORM_BUS_NAME for order confirmation email.");
        }
        const emailJobId = this.hash(`order-confirmation:${input.orderId}`);
        const campaignId = `order-confirmation:${input.orderId}`;
        const detail = {
            type: "email.order_confirmation.requested",
            emailJobId,
            campaignId,
            batchIndex: 0,
            batchCount: 1,
            ...input
        };
        const event = {
            channel: "platform" as const,
            source: "supermarket.email",
            detailType: "email.order_confirmation.requested",
            detail
        };
        const created = await this.ports.ensureEmailRoute(EmailRoute.create({ emailJobId, campaignId, batchIndex: 0, batchCount: 1, event }, Date.now()));
        if (!created)
            return { emailJobId, status: "already_queued" as const };
        try {
            const published = await this.ports.publishEventBridgeEvent(event);
            await this.ports.markEmailRoutePublished({ emailJobId, eventId: published.eventId });
            return { emailJobId, status: "queued" as const, eventId: published.eventId };
        }
        catch (error) {
            const scheduled = await this.ports.markEmailRoutePublishRetry({
                emailJobId,
                attempt: 1,
                reason: error instanceof Error ? error.message : "Unknown EventBridge publish failure",
                nextPublishAt: this.ports.nextEmailPublishRetryAt(1)
            });
            return { emailJobId, status: scheduled ? "retry_scheduled" as const : "publish_unknown" as const };
        }
    }
}
