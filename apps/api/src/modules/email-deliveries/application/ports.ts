import type { EmailRoute, NewEmailRoute } from "../domain/email-route.js";
export interface DeliveryMeta {
    id: string;
    senderEmail: string;
    subject: string;
    recipientCount: number;
    relatedId?: string;
    html?: string;
    text?: string;
    sendStatus: string;
    createdAt: string;
    updatedAt: string;
}
export interface DeliveryRecipient {
    recipientEmail: string;
    status: string;
}
export interface MailEvent {
    channel: "platform";
    source: string;
    detailType: string;
    detail: Record<string, unknown>;
}
export interface FailedMailRoute {
    emailJobId: string;
    campaignId: string;
    batchIndex: number;
    batchCount: number;
    eventDetail?: Record<string, unknown>;
    eventBusName?: string;
    eventSource: string;
    eventDetailType: string;
    status: string;
    publishAttempts: number;
    manualRetryCount?: number;
    publishFailureReason?: string;
    updatedAt: string;
}
export interface EmailAdministrationPorts {
    getEmailDelivery(id: string): Promise<{
        meta: DeliveryMeta;
        recipients: DeliveryRecipient[];
    } | null>;
    listEmailDeliveriesWithStatus(limit: number): Promise<DeliveryMeta[]>;
    listFailedEmailRoutePublishes(limit: number): Promise<FailedMailRoute[]>;
    retryFailedEmailRoutePublish(id: string): Promise<boolean>;
    ensureEmailRoute(route: EmailRoute<NewEmailRoute>): Promise<boolean>;
    markEmailRoutePublished(input: {
        emailJobId: string;
        eventId: string;
    }): Promise<boolean>;
    markEmailRoutePublishRetry(input: {
        emailJobId: string;
        reason: string;
        attempt: number;
        nextPublishAt: string;
    }): Promise<boolean>;
    nextEmailPublishRetryAt(attempt: number): string;
    publishEventBridgeEvent(event: MailEvent): Promise<{
        eventId: string;
        eventBusName: string;
    }>;
}
