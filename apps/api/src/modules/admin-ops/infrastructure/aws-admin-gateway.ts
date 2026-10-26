import { DescribeReplayCommand, PutEventsCommand, StartReplayCommand } from "@aws-sdk/client-eventbridge";
import { ChangeMessageVisibilityBatchCommand, DeleteMessageCommand, DeleteMessageBatchCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Logger } from "@nestjs/common";
import crypto from "node:crypto";
import { eventbridgeConfig } from "../../../config/eventbridge-config.js";
import { operationsConfig } from "../../../config/operations-config.js";
import { eventBridgeClient } from "../../../integrations/eventbridge/client.js";
import { sqsClient } from "../../../integrations/sqs/client.js";
const queueConfig = {
    notifications: {
        dlqUrl: operationsConfig.SQS_NOTIFICATIONS_DLQ_URL,
        replayType: "sqs",
        targetQueueUrl: operationsConfig.SQS_NOTIFICATIONS_QUEUE_URL
    },
    storefrontOrders: {
        dlqUrl: operationsConfig.SQS_STOREFRONT_ORDERS_DLQ_URL,
        replayType: "sqs",
        targetQueueUrl: operationsConfig.SQS_STOREFRONT_ORDERS_QUEUE_URL
    },
    paymentEvents: {
        dlqUrl: operationsConfig.SQS_PAYMENT_EVENTS_DLQ_URL,
        replayType: "sqs",
        targetQueueUrl: operationsConfig.SQS_PAYMENT_EVENTS_QUEUE_URL
    },
    emailJobs: {
        dlqUrl: operationsConfig.SQS_EMAIL_JOBS_DLQ_URL,
        replayType: "sqs",
        targetQueueUrl: operationsConfig.SQS_EMAIL_JOBS_QUEUE_URL
    },
    imageUploads: {
        dlqUrl: operationsConfig.SQS_IMAGE_UPLOADS_DLQ_URL,
        replayType: "sqs",
        targetQueueUrl: operationsConfig.SQS_IMAGE_UPLOADS_QUEUE_URL
    },
    eventbridgeTargets: {
        dlqUrl: operationsConfig.SQS_EVENTBRIDGE_TARGET_DLQ_URL,
        replayType: "eventbridge"
    },
    emailEventbridgeDelivery: {
        dlqUrl: operationsConfig.SQS_EMAIL_EVENTBRIDGE_DELIVERY_DLQ_URL,
        replayType: "eventbridge"
    },
    auditLogWorker: {
        dlqUrl: operationsConfig.SQS_AUDIT_LOG_WORKER_DLQ_URL,
        replayType: "sqs",
        targetQueueUrl: operationsConfig.SQS_AUDIT_LOG_QUEUE_URL
    }
} as const;
const archiveConfig = {
    commerce: {
        archiveName: "supermarket-commerce-archive",
        archiveArn: eventbridgeConfig.EVENTBRIDGE_COMMERCE_ARCHIVE_ARN,
        eventBusName: eventbridgeConfig.EVENTBRIDGE_COMMERCE_BUS_NAME
    },
    payment: {
        archiveName: "supermarket-payment-archive",
        archiveArn: eventbridgeConfig.EVENTBRIDGE_PAYMENT_ARCHIVE_ARN,
        eventBusName: eventbridgeConfig.EVENTBRIDGE_PAYMENT_BUS_NAME
    },
    platform: {
        archiveName: "supermarket-platform-archive",
        archiveArn: eventbridgeConfig.EVENTBRIDGE_PLATFORM_ARCHIVE_ARN,
        eventBusName: eventbridgeConfig.EVENTBRIDGE_PLATFORM_BUS_NAME
    }
} as const;
type DlqKey = keyof typeof queueConfig;
type ArchiveKey = keyof typeof archiveConfig;
type QueueMessageSnapshot = {
    messageId: string;
    receiptHandle: string;
    body: string;
    attributes: Record<string, string>;
    messageAttributes: Record<string, string>;
};
function getDlqKeys(): DlqKey[] {
    return Object.keys(queueConfig) as DlqKey[];
}
function getArchiveKeys(): ArchiveKey[] {
    return Object.keys(archiveConfig) as ArchiveKey[];
}
function parseRuleArnForBusName(ruleArn?: string): string | undefined {
    if (!ruleArn)
        return undefined;
    const ruleMarker = ":rule/";
    const markerIndex = ruleArn.indexOf(ruleMarker);
    if (markerIndex < 0)
        return undefined;
    const rulePath = ruleArn.slice(markerIndex + ruleMarker.length);
    const segments = rulePath.split("/").filter(Boolean);
    if (segments.length >= 2) {
        return segments[0];
    }
    return eventbridgeConfig.EVENTBRIDGE_DEFAULT_BUS_NAME?.trim() || undefined;
}
function tryParseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function eventBusArnFromArchiveArn(archiveArn: string, eventBusName: string): string {
    const arnSegments = archiveArn.split(":");
    if (arnSegments.length < 6 || arnSegments[2] !== "events" || !eventBusName.trim()) {
        throw new Error("Không thể xác định EventBridge bus ARN từ cấu hình archive.");
    }
    return `${arnSegments.slice(0, 5).join(":")}:event-bus/${eventBusName.trim()}`;
}
export class AwsAdminGateway {
    keys() { return getDlqKeys(); }
    queue(key: DlqKey) { return queueConfig[key]; }
    defaultBus() { return eventbridgeConfig.EVENTBRIDGE_DEFAULT_BUS_NAME?.trim(); }
    async ackPublished(queueKey: DlqKey, entries: Array<{
        id: string;
        token: string;
    }>) {
        const config = queueConfig[queueKey];
        const successfulDeletes = entries.map(entry => ({ Id: entry.id, ReceiptHandle: entry.token }));
        if (successfulDeletes.length > 0) {
            const deleteResponse = await sqsClient.send(new DeleteMessageBatchCommand({
                QueueUrl: config.dlqUrl,
                Entries: successfulDeletes
            }));
            const failedDeleteIds = new Set((deleteResponse.Failed ?? []).map((entry) => entry.Id).filter(Boolean));
            for (const entry of successfulDeletes.filter((candidate) => failedDeleteIds.has(candidate.Id))) {
                // DeleteMessageBatch can partially fail. Retry only the failed delete;
                // never publish the event again merely because cleanup failed.
                try {
                    await sqsClient.send(new DeleteMessageCommand({
                        QueueUrl: config.dlqUrl,
                        ReceiptHandle: entry.ReceiptHandle
                    }));
                }
                catch (error) {
                    this.logger.error(JSON.stringify({
                        flow: "dlq_replay",
                        stage: "replayed_message_delete_failed",
                        queue: queueKey,
                        messageId: entry.Id,
                        message: error instanceof Error ? error.message : "unknown"
                    }));
                }
            }
            this.logger.log(JSON.stringify({
                flow: "dlq_replay",
                stage: "replayed_messages_deleted",
                queue: queueKey,
                requested: successfulDeletes.length,
                batchDeleteFailed: failedDeleteIds.size
            }));
        }
    }
    private readonly logger = new Logger(AwsAdminGateway.name);
    listArchives() {
        return {
            archives: getArchiveKeys().map((key) => ({
                archiveKey: key,
                archiveName: archiveConfig[key].archiveName,
                archiveArn: archiveConfig[key].archiveArn ?? ""
            }))
        };
    }
    async startArchiveReplay(input: {
        archive: ArchiveKey;
        replayName?: string;
        eventStartTime: string;
        eventEndTime: string;
        ruleArns?: string[];
        description?: string;
    }) {
        const config = archiveConfig[input.archive];
        if (!config.archiveArn) {
            throw new Error(`Archive ${config.archiveName} chưa được cấu hình ARN.`);
        }
        if (!config.eventBusName) {
            throw new Error(`Archive ${config.archiveName} chưa được cấu hình EventBus name.`);
        }
        const replayName = input.replayName?.trim() || `${config.archiveName}-${Date.now()}`;
        const eventStartTime = new Date(input.eventStartTime);
        const eventEndTime = new Date(input.eventEndTime);
        if (Number.isNaN(eventStartTime.getTime()) || Number.isNaN(eventEndTime.getTime())) {
            throw new Error("Thời gian replay không hợp lệ.");
        }
        if (eventStartTime >= eventEndTime) {
            throw new Error("Thời gian bắt đầu phải nhỏ hơn thời gian kết thúc.");
        }
        this.logger.log(JSON.stringify({
            flow: "eventbridge_archive_replay",
            stage: "requested",
            archive: input.archive,
            archiveName: config.archiveName,
            eventBusName: config.eventBusName,
            replayName,
            eventStartTime: eventStartTime.toISOString(),
            eventEndTime: eventEndTime.toISOString(),
            filterRuleCount: input.ruleArns?.length ?? 0
        }));
        const response = await eventBridgeClient.send(new StartReplayCommand({
            ReplayName: replayName,
            Description: input.description?.trim() || `Replay từ archive ${config.archiveName}`,
            EventSourceArn: config.archiveArn,
            EventStartTime: eventStartTime,
            EventEndTime: eventEndTime,
            // Destination.Arn must be the source event bus ARN. Rule ARNs are only
            // valid in FilterArns; passing a rule ARN as Arn makes StartReplay fail.
            Destination: {
                Arn: eventBusArnFromArchiveArn(config.archiveArn, config.eventBusName),
                ...(input.ruleArns?.length ? { FilterArns: input.ruleArns } : {})
            }
        }));
        this.logger.log(JSON.stringify({
            flow: "eventbridge_archive_replay",
            stage: "started",
            archive: input.archive,
            replayName,
            replayArn: response.ReplayArn ?? "",
            state: response.State ?? "UNKNOWN",
            replayStartTime: response.ReplayStartTime?.toISOString() ?? null
        }));
        return {
            archiveKey: input.archive,
            archiveName: config.archiveName,
            replayName,
            replayArn: response.ReplayArn ?? "",
            state: "STARTING",
            eventStartTime: eventStartTime.toISOString(),
            eventEndTime: eventEndTime.toISOString()
        };
    }
    async getArchiveReplayStatus(replayName: string) {
        const response = await eventBridgeClient.send(new DescribeReplayCommand({
            ReplayName: replayName
        }));
        this.logger.log(JSON.stringify({
            flow: "eventbridge_archive_replay",
            stage: "status_checked",
            replayName,
            state: response.State ?? "UNKNOWN",
            stateReason: response.StateReason ?? "",
            eventLastReplayedTime: response.EventLastReplayedTime?.toISOString() ?? null
        }));
        return {
            replayName: response.ReplayName ?? replayName,
            replayArn: response.ReplayArn ?? "",
            state: response.State ?? "UNKNOWN",
            stateReason: response.StateReason ?? "",
            eventStartTime: response.EventStartTime?.toISOString() ?? null,
            eventEndTime: response.EventEndTime?.toISOString() ?? null,
            replayStartTime: response.ReplayStartTime?.toISOString() ?? null,
            replayEndTime: response.ReplayEndTime?.toISOString() ?? null,
            eventLastReplayedTime: response.EventLastReplayedTime?.toISOString() ?? null
        };
    }
    async listDlqMessages(queueKey?: DlqKey, maxMessages = 5) {
        if (queueKey) {
            return this.inspectQueue(queueKey, maxMessages);
        }
        const queues = await Promise.all(getDlqKeys().map((key) => this.inspectQueue(key, maxMessages)));
        return { queues };
    }
    async injectAuditLogWorkerFailure(input: {
        testId?: string;
        requestedBy: string;
    }) {
        const queueUrl = operationsConfig.SQS_AUDIT_LOG_QUEUE_URL?.trim();
        if (!queueUrl) {
            throw new Error("SQS_AUDIT_LOG_QUEUE_URL is not configured.");
        }
        const testId = input.testId?.trim() || crypto.randomUUID();
        const payload = {
            testId,
            kind: "AUDIT_LOG_WORKER_FAILURE_TEST",
            reason: "Intentional invalid audit log message. The worker parser must reject this body.",
            requestedBy: input.requestedBy,
            createdAt: new Date().toISOString()
        };
        const deduplicationId = crypto.createHash("sha256")
            .update(`audit-log-worker-failure-test:${testId}`)
            .digest("hex");
        const response = await sqsClient.send(new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(payload),
            MessageGroupId: `audit-log-worker-failure-test-${testId}`,
            MessageDeduplicationId: deduplicationId
        }));
        this.logger.warn(JSON.stringify({
            flow: "audit_log_worker_failure_test",
            stage: "injected",
            testId,
            requestedBy: input.requestedBy,
            messageId: response.MessageId ?? ""
        }));
        return {
            testId,
            messageId: response.MessageId ?? "",
            queueKey: "auditLogWorker",
            targetQueueUrl: queueUrl,
            expected: "The worker will reject this invalid message, SQS will retry it, then move it to the auditLogWorker DLQ after maxReceiveCount.",
            inspectDlq: "/api/admin/ops/dlq?queue=auditLogWorker&maxMessages=10",
            note: "Redriving this same invalid message without changing the body will fail again. This test is for retry/DLQ observation, not successful recovery."
        };
    }
    private async inspectQueue(queueKey: DlqKey, maxMessages: number) {
        const config = queueConfig[queueKey];
        if (!config.dlqUrl) {
            return {
                queueKey,
                configured: false,
                replayType: config.replayType,
                messageCount: 0,
                notVisibleCount: 0,
                messages: []
            };
        }
        const [attributesResponse, messages] = await Promise.all([
            sqsClient.send(new GetQueueAttributesCommand({
                QueueUrl: config.dlqUrl,
                AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"]
            })),
            this.receiveDlqMessages(queueKey, maxMessages, true)
        ]);
        return {
            queueKey,
            configured: true,
            replayType: config.replayType,
            queueUrl: config.dlqUrl,
            messageCount: Number(attributesResponse.Attributes?.ApproximateNumberOfMessages ?? 0),
            notVisibleCount: Number(attributesResponse.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
            messages: messages.map((message) => ({
                messageId: message.messageId,
                body: message.body,
                attributes: message.attributes,
                messageAttributes: message.messageAttributes
            }))
        };
    }
    async replaySingleMessage(queueKey: DlqKey, message: QueueMessageSnapshot) {
        const config = queueConfig[queueKey];
        if (config.replayType === "sqs") {
            if (!config.targetQueueUrl) {
                throw new Error(`Queue ${queueKey} chưa được cấu hình queue đích để replay.`);
            }
            await sqsClient.send(new SendMessageCommand({
                QueueUrl: config.targetQueueUrl,
                MessageBody: message.body,
                MessageAttributes: Object.fromEntries(Object.entries(message.messageAttributes).map(([key, value]) => [key, {
                        DataType: "String",
                        StringValue: value
                    }]))
            }));
            return config.targetQueueUrl;
        }
        const payload = tryParseJson(message.body);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("Message EventBridge DLQ không phải JSON hợp lệ.");
        }
        const eventPayload = payload as Record<string, unknown>;
        if (eventPayload.source === "aws.events" && eventPayload["detail-type"] === "Encrypted Events") {
            throw new Error("EventBridge encrypted event chưa được hỗ trợ replay tự động.");
        }
        const detail = eventPayload.detail;
        const eventBusName = parseRuleArnForBusName(message.messageAttributes.RULE_ARN)
            || eventbridgeConfig.EVENTBRIDGE_DEFAULT_BUS_NAME?.trim();
        if (!eventBusName) {
            throw new Error("Không xác định được EventBridge bus để replay.");
        }
        const response = await eventBridgeClient.send(new PutEventsCommand({
            Entries: [
                {
                    EventBusName: eventBusName,
                    Source: String(eventPayload.source ?? ""),
                    DetailType: String(eventPayload["detail-type"] ?? ""),
                    Detail: JSON.stringify(detail ?? {}),
                    Time: eventPayload.time ? new Date(String(eventPayload.time)) : new Date()
                }
            ]
        }));
        if (Number(response.FailedEntryCount ?? 0) > 0) {
            throw new Error(response.Entries?.[0]?.ErrorMessage || "EventBridge replay thất bại.");
        }
        this.logger.log(JSON.stringify({
            flow: "dlq_replay",
            stage: "eventbridge_put_accepted",
            queue: queueKey,
            source: String(eventPayload.source ?? ""),
            detailType: String(eventPayload["detail-type"] ?? ""),
            eventBusName,
            eventId: response.Entries?.[0]?.EventId ?? ""
        }));
        return eventBusName;
    }
    describeReplayDestination(queueKey: DlqKey, message: QueueMessageSnapshot) {
        const config = queueConfig[queueKey];
        if (config.replayType === "sqs") {
            return config.targetQueueUrl;
        }
        return parseRuleArnForBusName(message.messageAttributes.RULE_ARN)
            || eventbridgeConfig.EVENTBRIDGE_DEFAULT_BUS_NAME?.trim()
            || "unknown-event-bus";
    }
    async receiveDlqMessages(queueKey: DlqKey, maxMessages: number, releaseAfterRead: boolean) {
        const config = queueConfig[queueKey];
        if (!config.dlqUrl) {
            return [];
        }
        const receiveResponse = await sqsClient.send(new ReceiveMessageCommand({
            QueueUrl: config.dlqUrl,
            MaxNumberOfMessages: Math.max(1, Math.min(10, maxMessages)),
            VisibilityTimeout: 30,
            WaitTimeSeconds: 0,
            AttributeNames: ["All"],
            MessageAttributeNames: ["All"]
        }));
        const messages = (receiveResponse.Messages ?? [])
            .filter((message) => message.MessageId && message.ReceiptHandle)
            .map((message) => ({
            messageId: message.MessageId!,
            receiptHandle: message.ReceiptHandle!,
            body: message.Body ?? "",
            attributes: message.Attributes ?? {},
            messageAttributes: Object.fromEntries(Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [key, value.StringValue ?? ""]))
        }));
        if (releaseAfterRead) {
            await this.resetVisibility(config.dlqUrl, messages);
        }
        return messages;
    }
    async resetVisibility(queueUrl: string, messages: QueueMessageSnapshot[]) {
        if (messages.length === 0) {
            return;
        }
        await sqsClient.send(new ChangeMessageVisibilityBatchCommand({
            QueueUrl: queueUrl,
            Entries: messages.map((message) => ({
                Id: message.messageId,
                ReceiptHandle: message.receiptHandle,
                VisibilityTimeout: 0
            }))
        }));
    }
}
