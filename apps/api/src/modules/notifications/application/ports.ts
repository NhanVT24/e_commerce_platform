import type { InventoryNotifications } from "./ports/inventory-notifications.js";
export interface NotificationRecord {
    id: string;
    customerEmail: string;
    title: string;
    message: string;
    channel: "email" | "system";
    status: "pending" | "sent" | "read";
    isRead: boolean;
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}
export interface NotificationOrder {
    id: string;
    customerEmail: string;
    status: string;
    totalAmount: number;
    createdAt: string;
    updatedAt: string;
    items: Array<{
        productId: string;
        productName: string;
        price: number;
        originalUnitPrice?: number;
        quantity: number;
        lineTotal: number;
    }>;
}
export interface NotificationConfig {
    platformEventsEnabled: boolean;
    paymentEventsEnabled: boolean;
    commerceEventsEnabled: boolean;
    adminAlertsEnabled: boolean;
    adminEmail?: string;
}
export interface NotificationEffects {
    inventory?: InventoryNotifications;
    store: {
        createNotification(input: {
            email: string;
            title: string;
            message: string;
            channel: "email" | "system";
            status: "pending";
            metadata?: Record<string, unknown>;
        }): Promise<NotificationRecord>;
        deleteNotification(id: string): Promise<boolean>;
        deleteNotifications(ids: string[]): Promise<void>;
        listAllNotifications(): Promise<NotificationRecord[]>;
        listNotificationsByCustomer(email: string): Promise<NotificationRecord[]>;
        markNotificationAsRead(id: string): Promise<void>;
        markNotificationAsSent(id: string): Promise<void>;
    };
    findCheckout(id: string): Promise<{
        createdAt: string;
        updatedAt: string;
    } | null>;
    publish(input: {
        channel: "platform" | "payment" | "commerce";
        source: string;
        detailType: string;
        detail: Record<string, unknown>;
    }): Promise<{
        eventId: string;
        eventBusName: string;
    }>;
    adminAlert(input: {
        subject: string;
        message: string;
        attributes?: Record<string, string | number | boolean | undefined>;
    }): Promise<{
        messageId: string;
        topicArn: string;
    }>;
    orderConfirmation(input: {
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
    }): Promise<{
        status: string;
        emailJobId: string;
    }>;
    paymentFailure(input: {
        toEmail: string;
        txnRef: string;
        totalAmount: number;
        orderInfo: string;
        failureReason: string;
        responseCode?: string;
        bankCode?: string;
        payDate?: string;
    }): Promise<unknown>;
}
