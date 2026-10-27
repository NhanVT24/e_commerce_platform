import { DynamoInventoryNotifications } from "./inventory-notifications.js";
import { randomUUID } from "node:crypto";
import type { NotificationEffects, NotificationConfig } from "../application/ports.js";
import { emailConfig } from "../../../config/email-config.js";
import { eventbridgeConfig } from "../../../config/eventbridge-config.js";
import { operationsConfig } from "../../../config/operations-config.js";
import * as store from "../notifications.repository.js";
import { getAwaitingPaymentOrder } from "../../storefront/infrastructure/persistence/order-record.store.js";
import { publishEventBridgeEvent } from "../../../integrations/eventbridge/publisher.js";
import { publishAdminAlert } from "../../../integrations/sns/publisher.js";
import { sendPaymentFailureEmail } from "../../../integrations/ses/order-mailer.js";
import { queueOrderConfirmationEmail } from "../../email-deliveries/order-confirmation-email-route.js";
export const notificationConfig = (): NotificationConfig => ({ platformEventsEnabled: Boolean(eventbridgeConfig.EVENTBRIDGE_PLATFORM_BUS_NAME),
    paymentEventsEnabled: Boolean(eventbridgeConfig.EVENTBRIDGE_PAYMENT_BUS_NAME), commerceEventsEnabled: Boolean(eventbridgeConfig.EVENTBRIDGE_COMMERCE_BUS_NAME),
    adminAlertsEnabled: Boolean(operationsConfig.SNS_ADMIN_ALERTS_TOPIC_ARN), adminEmail: emailConfig.ADMIN_REPORT_EMAIL });
export const notificationEffects: NotificationEffects = {
    newId: randomUUID,
    inventory: new DynamoInventoryNotifications(),
    store: { createNotification: store.createNotification, deleteNotification: store.deleteNotification, deleteNotifications: store.deleteNotifications,
        listAllNotifications: store.listAllNotifications, listNotificationsByCustomer: store.listNotificationsByCustomer,
        markNotificationAsRead: store.markNotificationAsRead, markNotificationAsSent: store.markNotificationAsSent },
    findCheckout: async (id) => { const row = await getAwaitingPaymentOrder(id); return row ? { createdAt: row.createdAt, updatedAt: row.updatedAt } : null; },
    publish: ({ channel, ...input }) => publishEventBridgeEvent({ ...input, busName: channel === "platform" ? eventbridgeConfig.EVENTBRIDGE_PLATFORM_BUS_NAME : channel === "payment" ? eventbridgeConfig.EVENTBRIDGE_PAYMENT_BUS_NAME : eventbridgeConfig.EVENTBRIDGE_COMMERCE_BUS_NAME }),
    adminAlert: publishAdminAlert, orderConfirmation: queueOrderConfirmationEmail, paymentFailure: sendPaymentFailureEmail
};
