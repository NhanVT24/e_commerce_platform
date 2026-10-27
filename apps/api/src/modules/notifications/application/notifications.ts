import { Notification } from "../domain/notification.js";
import type { InventoryEffects } from "./ports/inventory-notifications.js";
import { ConfirmOrderPayment } from "../../storefront/application/confirm-order-payment/confirm-order-payment.js";
import { PaymentReviewRequired } from "../../storefront/application/ports/payment-review.js";
import { CompleteNotifiedOrder } from "./complete-notified-order.js";
import { ApplicationError } from "../../../common/application/application-error.js";
import { logQueueWarn, logQueueBusinessEvent, type ApplicationLogger } from "../../../common/application/queue-events.js";
import type { NotificationEffects, NotificationConfig, NotificationRecord, NotificationOrder } from "./ports.js";
export type NotificationEvent = {
    eventId?: string;
    productVersion?: number;
    type?: string;
    email?: string;
    txnRef?: string;
    amount?: number;
    orderInfo?: string;
    requestId?: string;
    orderId?: string;
    responseCode?: string;
    transactionNo?: string;
    bankCode?: string;
    payDate?: string;
    forceFail?: boolean;
    notificationId?: string;
    metadata?: Record<string, unknown>;
    failureReason?: string;
    alertLevel?: string;
    productId?: string;
    productName?: string;
    sku?: string;
    stock?: number;
    previousStock?: number;
    status?: string;
    previousStatus?: string;
    source?: string;
    changedBy?: string;
};
export class NotificationUseCases {
    constructor(protected readonly confirmOrderPayment: ConfirmOrderPayment, protected readonly completeNotifiedOrder: CompleteNotifiedOrder, private readonly effects: NotificationEffects, private readonly config: NotificationConfig, protected readonly logger: ApplicationLogger) { }
    private resolveQueueContext(queueName?: string, fallbackEventType?: string) {
        if (queueName) {
            return queueName;
        }
        return fallbackEventType?.startsWith("payment.") ? "paymentEvents" : "notifications";
    }
    private async publishAdminAlertSafely(input: {
        subject: string;
        message: string;
        attributes?: Record<string, string | number | boolean | undefined>;
        logContext: string;
    }) {
        if (!this.config.adminAlertsEnabled) {
            this.logger.warn(`[sns-admin-alert] skipped reason=missing_topic ${input.logContext}`);
            return { queued: false };
        }
        try {
            const published = await this.effects.adminAlert({
                subject: input.subject,
                message: input.message,
                attributes: input.attributes
            });
            this.logger.log(`[sns-admin-alert] published topic=${published.topicArn} messageId=${published.messageId} ${input.logContext}`);
            return { queued: true, messageId: published.messageId };
        }
        catch (error) {
            this.logger.warn(`[sns-admin-alert] failed error=${error instanceof Error ? error.message : "unknown"} ${input.logContext}`);
            return { queued: false };
        }
    }
    private async createPendingNotificationSafely(input: {
        email: string;
        title: string;
        message: string;
        channel: "email" | "system";
        metadata?: Record<string, unknown>;
    }) {
        try {
            return await this.createPendingNotification(input);
        }
        catch (error) {
            this.logger.warn(`[queue-notification] create_failed email=${input.email} channel=${input.channel} error=${error instanceof Error ? error.message : "unknown"}`);
            return null;
        }
    }
    private async publishAuditLogSafely(input: {
        eventType: string;
        email?: string;
        resourceId?: string;
        metadata?: Record<string, unknown>;
    }) {
        try {
            return await this.publishAuditLog(input);
        }
        catch (error) {
            this.logger.warn(`[eventbridge-platform] audit_failed eventType=${input.eventType} resourceId=${input.resourceId ?? ""} error=${error instanceof Error ? error.message : "unknown"}`);
            return { queued: false };
        }
    }
    /**
     * Payment events are at-least-once. Never call SES directly here: a
     * duplicate EventBridge event can have a new event id, while this route is
     * claimed by the deterministic order-confirmation:<orderId> email job id.
     */
    private async queueOrderConfirmationEmailSafely(input: {
        toEmail: string;
        orderId: string;
        totalAmount: number;
        createdAt: string;
        paymentConfirmedAt?: string;
        items: Array<{
            productName: string;
            quantity: number;
            unitPrice: number;
            originalUnitPrice?: number;
            lineTotal: number;
        }>;
    }) {
        try {
            const route = await this.effects.orderConfirmation(input);
            this.logger.log(`[email-route] order_confirmation_${route.status} orderId=${input.orderId} emailJobId=${route.emailJobId}`);
            return route;
        }
        catch (error) {
            this.logger.warn(`[email-route] order_confirmation_queue_failed orderId=${input.orderId} to=${input.toEmail} error=${error instanceof Error ? error.message : "unknown"}`);
            return null;
        }
    }
    async createPendingNotification(input: {
        email: string;
        title: string;
        message: string;
        channel: "email" | "system";
        metadata?: Record<string, unknown>;
    }) {
        Notification.assertSystemChannel(input.channel);
        const entity = Notification.create({ ...input, id: this.effects.newId() }, Date.now());
        const notification = await this.effects.store.createNotification(entity);
        this.logger.log(`[dynamo-notification] created id=${notification.id} channel=${notification.channel} email=${notification.customerEmail}`);
        await this.publishNotificationEvent(notification);
        return notification;
    }
    async publishAuditLog(input: {
        eventType: string;
        email?: string;
        resourceId?: string;
        metadata?: Record<string, unknown>;
    }) {
        if (!this.config.platformEventsEnabled) {
            this.logger.warn(`[eventbridge-platform] audit_disabled eventType=${input.eventType} resourceId=${input.resourceId ?? ""}`);
            return { queued: false };
        }
        const detail = {
            type: "audit.log.created",
            eventType: input.eventType,
            email: input.email ?? "",
            resourceId: input.resourceId ?? "",
            metadata: input.metadata ?? {},
            createdAt: new Date().toISOString()
        };
        const published = await this.effects.publish({
            channel: "platform",
            source: "supermarket.platform",
            detailType: "audit.log.created",
            detail
        });
        this.logger.log(`[eventbridge-platform] audit_published eventType=${input.eventType} resourceId=${input.resourceId ?? ""} bus=${published.eventBusName} eventId=${published.eventId}`);
        return { queued: true, eventId: published.eventId };
    }
    async publishPaymentCompletedEvent(input: {
        email: string;
        txnRef: string;
        amount: number;
        orderInfo: string;
        requestId?: string;
        orderId?: string;
        responseCode: string;
        transactionNo: string;
        bankCode: string;
        payDate: string;
        forceFail?: boolean;
    }) {
        if (!this.config.paymentEventsEnabled) {
            this.logger.warn(`[eventbridge-payment] success_disabled txnRef=${input.txnRef}`);
            return { queued: false };
        }
        const published = await this.effects.publish({
            channel: "payment",
            source: "supermarket.payment",
            detailType: "payments.vnpay.completed",
            detail: {
                type: "payment.completed",
                email: input.email,
                txnRef: input.txnRef,
                amount: input.amount,
                orderInfo: input.orderInfo,
                requestId: input.requestId ?? "",
                orderId: input.orderId ?? "",
                responseCode: input.responseCode,
                transactionNo: input.transactionNo,
                bankCode: input.bankCode,
                payDate: input.payDate,
                forceFail: Boolean(input.forceFail),
                createdAt: new Date().toISOString()
            }
        });
        this.logger.log(`[eventbridge-payment] success_published txnRef=${input.txnRef} bus=${published.eventBusName} eventId=${published.eventId}`);
        return { queued: true, eventId: published.eventId };
    }
    async publishPaymentFailedEvent(input: {
        email: string;
        txnRef: string;
        amount: number;
        orderInfo: string;
        requestId?: string;
        orderId?: string;
        responseCode: string;
        transactionNo: string;
        bankCode: string;
        payDate: string;
        failureReason: string;
        forceFail?: boolean;
    }) {
        if (!this.config.paymentEventsEnabled) {
            this.logger.warn(`[eventbridge-payment] failed_disabled txnRef=${input.txnRef}`);
            return { queued: false };
        }
        const published = await this.effects.publish({
            channel: "payment",
            source: "supermarket.payment",
            detailType: "payments.vnpay.failed",
            detail: {
                type: "payment.failed",
                email: input.email,
                txnRef: input.txnRef,
                amount: input.amount,
                orderInfo: input.orderInfo,
                requestId: input.requestId ?? "",
                orderId: input.orderId ?? "",
                responseCode: input.responseCode,
                transactionNo: input.transactionNo,
                bankCode: input.bankCode,
                payDate: input.payDate,
                failureReason: input.failureReason,
                forceFail: Boolean(input.forceFail),
                createdAt: new Date().toISOString()
            }
        });
        this.logger.log(`[eventbridge-payment] failed_published txnRef=${input.txnRef} responseCode=${input.responseCode} bus=${published.eventBusName} eventId=${published.eventId}`);
        return { queued: true, eventId: published.eventId };
    }
    async publishInventoryStockAlert(input: {
        productId: string;
        productName: string;
        sku?: string;
        stock: number;
        previousStock?: number;
        status: string;
        previousStatus?: string;
        source: "admin.update" | "admin.increment" | "storefront.order";
        changedBy?: string;
    }) {
        if (!this.config.platformEventsEnabled) {
            this.logger.warn(`[eventbridge-platform] inventory_alert_disabled productId=${input.productId} status=${input.status}`);
            return { queued: false };
        }
        const published = await this.effects.publish({
            channel: "platform",
            source: "supermarket.inventory",
            detailType: "inventory.stock.alert",
            detail: {
                type: "inventory.stock.alert",
                alertLevel: input.status,
                productId: input.productId,
                productName: input.productName,
                sku: input.sku ?? "",
                stock: input.stock,
                previousStock: input.previousStock ?? null,
                status: input.status,
                previousStatus: input.previousStatus ?? "",
                source: input.source,
                changedBy: input.changedBy ?? "",
                createdAt: new Date().toISOString()
            }
        });
        this.logger.log(`[eventbridge-platform] inventory_alert_published productId=${input.productId} status=${input.status} bus=${published.eventBusName} eventId=${published.eventId}`);
        return { queued: true, eventId: published.eventId };
    }
    async listForCustomer(email: string) {
        const items = await this.effects.store.listNotificationsByCustomer(email);
        return {
            items,
            pendingCount: items.filter((item) => new Notification(item).isUnread).length
        };
    }
    async listForPrincipal(input: {
        email: string;
        role: "admin" | "customer" | "viewer";
    }) {
        if (input.role !== "admin") {
            return this.listForCustomer(input.email);
        }
        const items = await this.effects.store.listAllNotifications();
        const adminItems = items.filter(item => new Notification(item).isVisibleToAdmin(input.email, this.config.adminEmail));
        return {
            items: adminItems,
            pendingCount: adminItems.filter((item) => new Notification(item).isUnread).length
        };
    }
    async markAsRead(email: string, id: string) {
        const notifications = await this.effects.store.listNotificationsByCustomer(email);
        const target = notifications.find((item) => item.id === id);
        if (!target) {
            throw new ApplicationError("NOT_FOUND", "Không tìm thấy thông báo");
        }
        await this.effects.store.markNotificationAsRead(id);
        return { success: true };
    }
    async markAsReadForPrincipal(input: {
        email: string;
        role: "admin" | "customer" | "viewer";
    }, id: string) {
        if (input.role !== "admin") {
            return this.markAsRead(input.email, id);
        }
        const notifications = await this.listForPrincipal(input);
        const target = notifications.items.find((item) => item.id === id);
        if (!target) {
            throw new ApplicationError("NOT_FOUND", "Không tìm thấy thông báo");
        }
        await this.effects.store.markNotificationAsRead(id);
        return { success: true };
    }
    async remove(email: string, id: string) {
        const notifications = await this.effects.store.listNotificationsByCustomer(email);
        const target = notifications.find((item) => item.id === id);
        if (!target) {
            throw new ApplicationError("NOT_FOUND", "Không tìm thấy thông báo");
        }
        await this.effects.store.deleteNotification(id);
        return { success: true };
    }
    async removeForPrincipal(input: {
        email: string;
        role: "admin" | "customer" | "viewer";
    }, id: string) {
        if (input.role !== "admin") {
            return this.remove(input.email, id);
        }
        const notifications = await this.listForPrincipal(input);
        const target = notifications.items.find((item) => item.id === id);
        if (!target) {
            throw new ApplicationError("NOT_FOUND", "Không tìm thấy thông báo");
        }
        await this.effects.store.deleteNotification(id);
        return { success: true };
    }
    async removeAll(email: string) {
        const notifications = await this.effects.store.listNotificationsByCustomer(email);
        await this.effects.store.deleteNotifications(notifications.map((item) => item.id));
        return { success: true, deletedCount: notifications.length };
    }
    async removeAllForPrincipal(input: {
        email: string;
        role: "admin" | "customer" | "viewer";
    }) {
        if (input.role !== "admin") {
            return this.removeAll(input.email);
        }
        const notifications = await this.listForPrincipal(input);
        await this.effects.store.deleteNotifications(notifications.items.map((item) => item.id));
        return { success: true, deletedCount: notifications.items.length };
    }
    private async publishNotificationEvent(notification: NotificationRecord) {
        if (!this.config.platformEventsEnabled) {
            this.logger.warn(`[eventbridge-platform] notification_disabled notificationId=${notification.id}`);
            return { queued: false };
        }
        const published = await this.effects.publish({
            channel: "platform",
            source: "supermarket.platform",
            detailType: "notifications.pending",
            detail: {
                type: "notification.pending",
                channel: notification.channel,
                email: notification.customerEmail,
                notificationId: notification.id,
                title: notification.title,
                message: notification.message,
                metadata: notification.metadata ?? {},
                createdAt: notification.createdAt
            }
        });
        this.logger.log(`[eventbridge-platform] notification_published notificationId=${notification.id} channel=${notification.channel} bus=${published.eventBusName} eventId=${published.eventId}`);
        return { queued: true, eventId: published.eventId };
    }
    async processEvent(payload: NotificationEvent, queueName?: string) {
        if (payload.type === "payment.completed") {
            return this.processPaymentCompletedEvent(payload);
        }
        if (payload.type === "payment.failed") {
            return this.processPaymentFailedEvent(payload);
        }
        if (payload.type === "inventory.stock.alert") {
            if (payload.eventId !== undefined) return this.processDurableInventoryAlert(payload);
            return this.processInventoryStockAlert(payload);
        }
        if (payload.type !== "notification.pending" || !payload.notificationId) {
            logQueueWarn(this.logger, {
                queue: this.resolveQueueContext(queueName),
                status: "ignored_payload"
            });
            return null;
        }
        await this.effects.store.markNotificationAsSent(payload.notificationId);
        const orderId = String(payload.metadata?.orderId ?? "").trim();
        if (!orderId) {
            logQueueBusinessEvent(this.logger, {
                queue: this.resolveQueueContext(queueName, "notification.pending"),
                eventType: "notification.pending",
                status: "processed",
                notificationId: payload.notificationId
            });
            return {
                type: "notification.pending",
                notificationId: payload.notificationId,
                orderId,
                orderCompleted: false
            };
        }
        const completion = await this.completeNotifiedOrder.execute(orderId);
        logQueueBusinessEvent(this.logger, {
            queue: this.resolveQueueContext(queueName, "notification.pending"),
            eventType: "notification.pending",
            status: "processed",
            notificationId: payload.notificationId,
            orderId
        });
        return {
            type: "notification.pending",
            notificationId: payload.notificationId,
            orderId,
            orderCompleted: completion.completed
        };
    }
    private async processPaymentCompletedEvent(payload: {
        email?: string;
        txnRef?: string;
        amount?: number;
        orderInfo?: string;
        requestId?: string;
        orderId?: string;
        responseCode?: string;
        transactionNo?: string;
        bankCode?: string;
        payDate?: string;
        forceFail?: boolean;
        failureReason?: string;
    }) {
        if (!payload.email || !payload.txnRef) {
            logQueueWarn(this.logger, {
                queue: "paymentEvents",
                eventType: "payment.completed",
                status: "ignored_payload",
                txnRef: payload.txnRef ?? ""
            });
            return null;
        }
        const email = payload.email.trim().toLowerCase();
        const requestId = payload.requestId?.trim() || "";
        const amount = Number(payload.amount ?? 0);
        if (payload.forceFail) {
            this.logger.error(`[queue-payment] success_force_fail txnRef=${payload.txnRef}`);
            throw new Error(`Forced failure for payment txnRef=${payload.txnRef}`);
        }
        let committed: {
            order: NotificationOrder | null;
            orderId: string;
            paymentConfirmedAt?: string;
        };
        try {
            const awaitingOrder = requestId ? await this.effects.findCheckout(requestId) : null;
            if (awaitingOrder) {
                const outcome = await this.confirmOrderPayment.execute({
                    orderId: requestId, email, amount, txnRef: payload.txnRef
                });
                committed = {
                    orderId: requestId,
                    paymentConfirmedAt: outcome.order.paymentConfirmedAt,
                    order: {
                        ...outcome.order,
                        id: requestId,
                        createdAt: awaitingOrder.createdAt, updatedAt: awaitingOrder.updatedAt,
                        status: "pending",
                        items: outcome.items.map((item) => ({
                            productId: item.productId, productName: item.productName,
                            price: item.unitPrice, originalUnitPrice: item.originalUnitPrice,
                            quantity: item.quantity, lineTotal: item.lineTotal
                        }))
                    }
                };
            }
            else {
                if (requestId)
                    await this.confirmOrderPayment.execute({ orderId: requestId, email, amount, txnRef: payload.txnRef });
                committed = { order: null, orderId: payload.orderId?.trim() || "" };
            }
        }
        catch (error) {
            if (error instanceof PaymentReviewRequired) {
                this.logger.error(JSON.stringify({ event: "payment.manual_review_required", txnRef: payload.txnRef, requestId }));
                await this.publishAdminAlertSafely({ subject: `Payment requires review ${payload.txnRef}`,
                    message: `A durable payment review is available for transaction ${payload.txnRef}, order ${requestId}. No automatic refund or inventory change was performed.`,
                    attributes: { alertType: "payment.manual_review_required", txnRef: payload.txnRef, orderId: requestId },
                    logContext: `payment.manual_review_required txnRef=${payload.txnRef}` });
                return { type: "payment.completed", txnRef: payload.txnRef, orderId: requestId, status: "manual_review" };
            }
            const syncErrorMessage = error instanceof Error ? error.message : "unknown";
            await this.publishAuditLogSafely({
                eventType: "payments.vnpay.completed.sync_failed",
                email,
                resourceId: payload.txnRef,
                metadata: {
                    requestId,
                    orderId: payload.orderId?.trim() || "",
                    amount,
                    orderInfo: payload.orderInfo ?? "",
                    responseCode: payload.responseCode ?? "",
                    transactionNo: payload.transactionNo ?? "",
                    bankCode: payload.bankCode ?? "",
                    payDate: payload.payDate ?? "",
                    status: "sync_failed",
                    syncErrorMessage
                }
            });
            await this.publishAdminAlertSafely({
                subject: `Payment sync failed ${payload.txnRef}`,
                message: [
                    "Payment completed successfully but order synchronization after payment failed.",
                    `TxnRef: ${payload.txnRef}`,
                    `Customer: ${email}`,
                    `RequestId: ${requestId || "N/A"}`,
                    `OrderId: ${payload.orderId?.trim() || "N/A"}`,
                    `ResponseCode: ${payload.responseCode ?? ""}`,
                    `Error: ${syncErrorMessage}`
                ].join("\n"),
                attributes: {
                    alertType: "payment.completed.sync_failed",
                    txnRef: payload.txnRef,
                    requestId,
                    orderId: payload.orderId?.trim() || "",
                    customerEmail: email
                },
                logContext: `alertType=payment.completed.sync_failed txnRef=${payload.txnRef} requestId=${requestId}`
            });
            logQueueWarn(this.logger, {
                queue: "paymentEvents",
                eventType: "payment.completed",
                status: "sync_failed",
                txnRef: payload.txnRef,
                message: syncErrorMessage
            });
            // Do not acknowledge a payment event whose order transaction failed.
            // The SQS/Pipe retry and DLQ path is the recovery mechanism; returning
            // normally here stranded a paid checkout in `allowed` forever.
            throw error;
        }
        const orderId = committed.order?.id ?? committed.orderId ?? (payload.orderId?.trim() || "");
        await this.createPendingNotificationSafely({
            email,
            channel: "system",
            title: "Payment Successful",
            message: `Transaction ${payload.txnRef} has been confirmed as successful.`,
            metadata: {
                orderId,
                requestId,
                txnRef: payload.txnRef,
                amount,
                orderInfo: payload.orderInfo ?? "",
                paymentStatus: "success"
            }
        });
        if (committed.order) {
            await this.queueOrderConfirmationEmailSafely({
                toEmail: email,
                orderId: committed.order.id,
                totalAmount: committed.order.totalAmount,
                createdAt: committed.order.createdAt,
                paymentConfirmedAt: committed.paymentConfirmedAt,
                items: committed.order.items.map((item) => ({
                    productName: item.productName,
                    quantity: item.quantity,
                    unitPrice: item.price,
                    originalUnitPrice: item.originalUnitPrice,
                    lineTotal: item.lineTotal
                }))
            });
        }
        await this.publishAuditLogSafely({
            eventType: "payments.vnpay.completed",
            email,
            resourceId: payload.txnRef,
            metadata: {
                orderId,
                requestId,
                amount,
                orderInfo: payload.orderInfo ?? "",
                responseCode: payload.responseCode ?? "",
                transactionNo: payload.transactionNo ?? "",
                bankCode: payload.bankCode ?? "",
                payDate: payload.payDate ?? "",
                status: "success"
            }
        });
        logQueueBusinessEvent(this.logger, {
            queue: "paymentEvents",
            eventType: "payment.completed",
            status: "processed",
            txnRef: payload.txnRef,
            orderId
        });
        return {
            type: "payment.completed",
            txnRef: payload.txnRef,
            orderId,
            requestId,
            queuedNotifications: 1,
            auditQueued: true
        };
    }
    private async processPaymentFailedEvent(payload: {
        email?: string;
        txnRef?: string;
        amount?: number;
        orderInfo?: string;
        requestId?: string;
        orderId?: string;
        responseCode?: string;
        transactionNo?: string;
        bankCode?: string;
        payDate?: string;
        failureReason?: string;
        forceFail?: boolean;
    }) {
        if (!payload.email || !payload.txnRef) {
            logQueueWarn(this.logger, {
                queue: "paymentEvents",
                eventType: "payment.failed",
                status: "ignored_payload",
                txnRef: payload.txnRef ?? ""
            });
            return null;
        }
        const email = payload.email.trim().toLowerCase();
        const orderId = payload.orderId?.trim() || "";
        const requestId = payload.requestId?.trim() || "";
        const amount = Number(payload.amount ?? 0);
        const failureReason = String(payload.failureReason ?? "payment_failed");
        if (payload.forceFail) {
            this.logger.error(`[queue-payment] failed_force_fail txnRef=${payload.txnRef}`);
            throw new Error(`Forced failure for failed-payment txnRef=${payload.txnRef}`);
        }
        try {
            await this.effects.paymentFailure({
                toEmail: email,
                txnRef: payload.txnRef,
                totalAmount: amount,
                orderInfo: payload.orderInfo ?? "",
                failureReason,
                responseCode: payload.responseCode,
                bankCode: payload.bankCode,
                payDate: payload.payDate
            });
            this.logger.log(`[mail-ses] payment_failed_sent txnRef=${payload.txnRef} to=${email}`);
        }
        catch (error) {
            this.logger.warn(`[mail-ses] payment_failed_failed txnRef=${payload.txnRef} to=${email} error=${error instanceof Error ? error.message : "unknown"}`);
        }
        await this.createPendingNotification({
            email,
            channel: "system",
            title: "Payment Failed",
            message: `Transaction ${payload.txnRef} failed. Reason: ${failureReason}.`,
            metadata: {
                orderId,
                requestId,
                txnRef: payload.txnRef,
                amount,
                orderInfo: payload.orderInfo ?? "",
                paymentStatus: "failed",
                responseCode: payload.responseCode ?? "",
                failureReason
            }
        });
        await this.publishAuditLog({
            eventType: "payments.vnpay.failed",
            email,
            resourceId: payload.txnRef,
            metadata: {
                orderId,
                requestId,
                amount,
                orderInfo: payload.orderInfo ?? "",
                responseCode: payload.responseCode ?? "",
                transactionNo: payload.transactionNo ?? "",
                bankCode: payload.bankCode ?? "",
                payDate: payload.payDate ?? "",
                status: "failed",
                failureReason
            }
        });
        await this.publishAdminAlertSafely({
            subject: `Payment Failed Alert ${payload.txnRef}`,
            message: [
                "Payment failed has been recorded.",
                `TxnRef: ${payload.txnRef}`,
                `Customer: ${email}`,
                `Amount: ${amount}`,
                `Reason: ${failureReason}`,
                `ResponseCode: ${payload.responseCode ?? ""}`,
                `OrderId: ${orderId || "N/A"}`
            ].join("\n"),
            attributes: {
                alertType: "payment.failed",
                txnRef: payload.txnRef,
                orderId,
                responseCode: payload.responseCode ?? "",
                customerEmail: email
            },
            logContext: `alertType=payment.failed txnRef=${payload.txnRef} orderId=${orderId}`
        });
        logQueueBusinessEvent(this.logger, {
            queue: "paymentEvents",
            eventType: "payment.failed",
            status: "processed",
            txnRef: payload.txnRef,
            orderId
        });
        return {
            type: "payment.failed",
            txnRef: payload.txnRef,
            orderId,
            requestId,
            queuedNotifications: 1,
            auditQueued: true,
            failureReason
        };
    }
    private async processDurableInventoryAlert(payload: NotificationEvent) {
        const { productId, productName, productVersion, eventId } = payload;
        if (!productId || !productName || !Number.isSafeInteger(productVersion) || productVersion < 1 ||
            eventId !== `inventory.stock.alert:${productId}:${productVersion}` ||
            (payload.status !== "low_stock" && payload.status !== "out_of_stock") ||
            !Number.isSafeInteger(payload.stock) || payload.stock < 0) throw new Error("Invalid durable inventory event");
        if (!this.config.adminEmail || !this.effects.inventory) throw new Error("Inventory notification storage/recipient is not configured");
        const level = payload.status;
        const title = level === "out_of_stock" ? "Product Out of Stock" : "Product Low on Stock";
        const message = `${productName}: ${level}. Current quantity: ${payload.stock}.`;
        const metadata = { audience: "admin", alertType: "inventory.stock.alert", eventId, productVersion,
            productId, productName, stock: payload.stock, previousStock: payload.previousStock,
            status: level, source: payload.source, changedBy: payload.changedBy };
        const notification = Notification.create({ id: this.effects.inventory.notificationId(eventId, this.config.adminEmail),
            email: this.config.adminEmail, title, message, metadata, channel: "system" }, Date.now());
        const claim = await this.effects.inventory.createOnce({ eventId, notification });
        if (!claim.created) return { type: "inventory.stock.alert", eventId, notificationId: claim.notificationId, duplicate: true };
        const effects: InventoryEffects = { notification: "SKIPPED", audit: "SKIPPED", sns: "SKIPPED" };
        const attempt = async (name: keyof InventoryEffects, enabled: boolean, run: () => Promise<unknown>) => {
            if (!enabled) return;
            try { await run(); effects[name] = "SUCCEEDED"; }
            catch { effects[name] = "UNKNOWN"; }
        };
        // No blind resend after an ambiguous external result. The durable database
        // notification exists independently; receipt records incomplete effects.
        await attempt("notification", this.config.platformEventsEnabled, () => this.effects.publish({ channel: "platform",
            source: "supermarket.platform", detailType: "notifications.pending", detail: {
                type: "notification.pending", channel: "system", title, message, notificationId: claim.notificationId, email: this.config.adminEmail, metadata } }));
        await attempt("audit", this.config.platformEventsEnabled, () => this.publishAuditLog({ eventType: "inventory.stock.alerted",
            email: this.config.adminEmail, resourceId: productId, metadata }));
        await attempt("sns", this.config.adminAlertsEnabled, () => this.effects.adminAlert({ subject: `${title}: ${productName}`,
            message, attributes: { alertType: "inventory.stock.alert", eventId, productId, stock: payload.stock } }));
        await this.effects.inventory.finish({ ...claim, eventId, email: this.config.adminEmail, effects });
        if (Object.values(effects).includes("UNKNOWN")) this.logger.warn(JSON.stringify({ event: "inventory.effects.unknown", eventId, effects }));
        return { type: "inventory.stock.alert", eventId, notificationId: claim.notificationId, effects };
    }
    private async processInventoryStockAlert(payload: {
        alertLevel?: string;
        productId?: string;
        productName?: string;
        sku?: string;
        stock?: number;
        previousStock?: number;
        status?: string;
        previousStatus?: string;
        source?: string;
        changedBy?: string;
    }) {
        if (!this.config.adminEmail || !payload.productId || !payload.productName) {
            this.logger.warn(`[queue-admin-alert] skipped productId=${payload.productId ?? ""} reason=missing_admin_email_or_product`);
            return null;
        }
        const stock = Number(payload.stock ?? 0);
        const level = String(payload.alertLevel ?? payload.status ?? "").trim();
        const source = String(payload.source ?? "").trim();
        const changedBy = String(payload.changedBy ?? "").trim();
        const title = level === "out_of_stock"
            ? "Product Out of Stock"
            : "Product Low on Stock";
        const message = level === "out_of_stock"
            ? `${payload.productName} is out of stock. Current quantity: ${stock}.`
            : `${payload.productName} is running low on stock. Current quantity: ${stock}.`;
        const notification = await this.createPendingNotification({
            email: this.config.adminEmail,
            channel: "system",
            title,
            message,
            metadata: {
                audience: "admin",
                alertType: "inventory.stock.alert",
                alertLevel: level,
                productId: payload.productId,
                productName: payload.productName,
                sku: payload.sku ?? "",
                stock,
                previousStock: Number(payload.previousStock ?? 0),
                status: payload.status ?? level,
                previousStatus: payload.previousStatus ?? "",
                source,
                changedBy
            }
        });
        await this.publishAuditLog({
            eventType: "inventory.stock.alerted",
            email: this.config.adminEmail,
            resourceId: payload.productId,
            metadata: {
                alertLevel: level,
                productName: payload.productName,
                sku: payload.sku ?? "",
                stock,
                previousStock: Number(payload.previousStock ?? 0),
                source,
                changedBy
            }
        });
        await this.publishAdminAlertSafely({
            subject: level === "out_of_stock" ? `Out of Stock: ${payload.productName}` : `Low Stock Alert: ${payload.productName}`,
            message: [
                "Inventory alert for administrators.",
                `Product: ${payload.productName}`,
                `ProductId: ${payload.productId}`,
                `SKU: ${payload.sku ?? "N/A"}`,
                `Alert Level: ${level}`,
                `Current Stock: ${stock}`,
                `Previous Stock: ${Number(payload.previousStock ?? 0)}`,
                `Source: ${source || "unknown"}`,
                `Changed By: ${changedBy || "unknown"}`
            ].join("\n"),
            attributes: {
                alertType: "inventory.stock.alert",
                alertLevel: level,
                productId: payload.productId,
                sku: payload.sku ?? "",
                stock
            },
            logContext: `alertType=inventory.stock.alert productId=${payload.productId} level=${level}`
        });
        return {
            type: "inventory.stock.alert",
            productId: payload.productId,
            alertLevel: level,
            notificationId: notification?.id ?? "",
            adminEmail: this.config.adminEmail
        };
    }
}
