import { DynamoInventoryNotifications } from "./inventory-notifications.js";
import type { NotificationEffects, NotificationConfig } from "../application/ports.js";
import { env } from "../../../config/env.js";
import * as store from "../notifications.repository.js";
import { getAwaitingPaymentOrder } from "../../storefront/infrastructure/persistence/order-record.store.js";
import { publishEventBridgeEvent } from "../../../integrations/eventbridge/publisher.js";
import { publishAdminAlert } from "../../../integrations/sns/publisher.js";
import { sendPaymentFailureEmail } from "../../../integrations/ses/order-mailer.js";
import { queueOrderConfirmationEmail } from "../../email-deliveries/order-confirmation-email-route.js";
export const notificationConfig = (): NotificationConfig => ({ platformEventsEnabled: Boolean(env.EVENTBRIDGE_PLATFORM_BUS_NAME),
    paymentEventsEnabled: Boolean(env.EVENTBRIDGE_PAYMENT_BUS_NAME), commerceEventsEnabled: Boolean(env.EVENTBRIDGE_COMMERCE_BUS_NAME),
    adminAlertsEnabled: Boolean(env.SNS_ADMIN_ALERTS_TOPIC_ARN), adminEmail: env.ADMIN_REPORT_EMAIL });
export const notificationEffects: NotificationEffects = {
    inventory: new DynamoInventoryNotifications(),
    store: { createNotification: store.createNotification, deleteNotification: store.deleteNotification, deleteNotifications: store.deleteNotifications,
        listAllNotifications: store.listAllNotifications, listNotificationsByCustomer: store.listNotificationsByCustomer,
        markNotificationAsRead: store.markNotificationAsRead, markNotificationAsSent: store.markNotificationAsSent },
    findCheckout: async (id) => { const row = await getAwaitingPaymentOrder(id); return row ? { createdAt: row.createdAt, updatedAt: row.updatedAt } : null; },
    publish: ({ channel, ...input }) => publishEventBridgeEvent({ ...input, busName: channel === "platform" ? env.EVENTBRIDGE_PLATFORM_BUS_NAME : channel === "payment" ? env.EVENTBRIDGE_PAYMENT_BUS_NAME : env.EVENTBRIDGE_COMMERCE_BUS_NAME }),
    adminAlert: publishAdminAlert, orderConfirmation: queueOrderConfirmationEmail, paymentFailure: sendPaymentFailureEmail
};
