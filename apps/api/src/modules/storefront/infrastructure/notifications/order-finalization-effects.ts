import { Logger } from "@nestjs/common";
import { eventbridgeConfig } from "../../../../config/eventbridge-config.js";
import { publishEventBridgeEvent } from "../../../../integrations/eventbridge/publisher.js";
import { sendOrderFailureEmail } from "../../../../integrations/ses/order-mailer.js";
import { ordersSenderEmail } from "../../../../integrations/ses/sender-config.js";
import { logQueueBusinessEvent } from "../../../../common/logging/queue-logger.js";
import { queueOrderConfirmationEmail } from "../../../email-deliveries/order-confirmation-email-route.js";
import type { NotificationsService } from "../../../notifications/notifications.service.js";
import { getShoppingItem } from "../../../shopping/shopping.repository.js";
import type { CheckoutItem } from "../../domain/checkout.js";
import type { OrderFinalizationEffects, QueuedOrder, OrderStockChange } from "../../application/ports/order-finalization-ports.js";

export class NotificationOrderFinalizationEffects implements OrderFinalizationEffects {
  private readonly logger = new Logger("OrderFinalization");
  constructor(private readonly notificationsService: NotificationsService) {}
  async succeeded(order: QueuedOrder, stockChanges: OrderStockChange[], requestId: string) {
    const email = order.customerEmail;
    this.logger.log(`[dynamo-order] created orderId=${order.id} requestId=${requestId ?? ""} customer=${email} status=${order.status} totalAmount=${order.totalAmount} itemCount=${order.items.length}`);
    await this.publishInventoryAlertsFromOrder(stockChanges, email);

    await this.notificationsService.createPendingNotification({
      email,
      channel: "system",
      title: "order is queued for processing",
      message: `order ${order.id} has been added to the processing queue.`,
      metadata: {
        requestId: requestId ?? "",
        orderId: order.id,
        totalAmount: order.totalAmount,
        itemCount: order.items.length
      }
    });

    const emailRoute = await queueOrderConfirmationEmail({
      toEmail: email,
      orderId: order.id,
      totalAmount: order.totalAmount,
      createdAt: order.createdAt,
      items: order.items.map((item) => ({
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.price,
        originalUnitPrice: item.originalUnitPrice,
        lineTotal: item.lineTotal
      }))
    });
    this.logger.log(`[email-route] order_confirmation_${emailRoute.status} orderId=${order.id} emailJobId=${emailRoute.emailJobId}`);

    await this.notificationsService.publishAuditLog({
      eventType: "storefront.order.created",
      email,
      resourceId: order.id,
      metadata: {
        totalAmount: order.totalAmount,
        itemCount: order.items.length,
        status: order.status,
        requestId: requestId ?? ""
      }
    });

    await this.publishCommerceLifecycleEvent({
      detailType: "storefront.order.succeeded",
      detail: {
        type: "storefront.order.succeeded",
        requestId: requestId ?? "",
        orderId: order.id,
        customer: email,
        totalAmount: order.totalAmount,
        itemCount: order.items.length,
        status: order.status,
        createdAt: order.createdAt
      }
    });
    logQueueBusinessEvent(this.logger, {
      queue: "storefrontOrders",
      eventType: "storefront.order.requested",
      status: "processed",
      requestId: requestId ?? "",
      orderId: order.id
    });
  }
  async failed(email: string, normalizedItems: CheckoutItem[], requestId: string, failureReason: string) {
    this.logger.warn(
      `[dynamo-stock] insufficient_after_queue requestId=${requestId ?? ""} customer=${email} reason=insufficient_stock error=insufficient_stock`
    );

    if (ordersSenderEmail()) {
      try {
        await sendOrderFailureEmail({
          toEmail: email,
          requestId,
          failureReason,
          items: await Promise.all(normalizedItems.map(async (item) => {
            const product = await getShoppingItem(item.productId);
            return {
              productId: item.productId,
              productName: product?.name ? String(product.name) : undefined,
              quantity: item.quantity
            };
          }))
        });
        this.logger.log(`[mail-ses] order_failure_sent requestId=${requestId ?? ""} customer=${email}`);
      } catch (mailError) {
        this.logger.warn(
          `[mail-ses] order_failure_failed requestId=${requestId ?? ""} customer=${email} error=${mailError instanceof Error ? mailError.message : "unknown"}`
        );
      }
    }

    await this.notificationsService.createPendingNotification({
      email,
      channel: "system",
      title: "Payment Failed",
      message: failureReason,
      metadata: {
        requestId: requestId ?? "",
        itemCount: normalizedItems.length,
        failureCode: "insufficient_stock",
        failureReason
      }
    });

    await this.notificationsService.publishAuditLog({
      eventType: "storefront.order.failed",
      email,
      resourceId: requestId ?? "",
      metadata: {
        status: "failed",
        itemCount: normalizedItems.length,
        requestId: requestId ?? "",
        failureCode: "insufficient_stock",
        failureReason
      }
    });

    await this.publishCommerceLifecycleEvent({
      detailType: "storefront.order.failed",
      detail: {
        type: "storefront.order.failed",
        requestId: requestId ?? "",
        customer: email,
        itemCount: normalizedItems.length,
        failureReason,
        failureCode: "insufficient_stock",
        createdAt: new Date().toISOString()
      }
    });

  }
  private async publishCommerceLifecycleEvent(input: {
    detailType: "storefront.order.succeeded" | "storefront.order.failed";
    detail: Record<string, unknown>;
  }) {
    if (!eventbridgeConfig.EVENTBRIDGE_COMMERCE_BUS_NAME) {
      this.logger.warn(`[eventbridge-commerce] lifecycle_disabled detailType=${input.detailType}`);
      return;
    }

    const published = await publishEventBridgeEvent({
      busName: eventbridgeConfig.EVENTBRIDGE_COMMERCE_BUS_NAME,
      source: "supermarket.commerce",
      detailType: input.detailType,
      detail: input.detail
    });

    this.logger.log(`[eventbridge-commerce] lifecycle_published detailType=${input.detailType} bus=${published.eventBusName} eventId=${published.eventId}`);
  }

  private async publishInventoryAlertsFromOrder(changes: OrderStockChange[], email: string) {
    for (const change of changes) {
      if ((change.status !== "low_stock" && change.status !== "out_of_stock") || change.previousStatus === change.status) {
        continue;
      }

      await this.notificationsService.publishInventoryStockAlert({
        productId: change.productId,
        productName: change.productName,
        sku: change.sku,
        stock: change.stock,
        previousStock: change.previousStock,
        status: change.status,
        previousStatus: change.previousStatus,
        source: "storefront.order",
        changedBy: email
      });
    }
  }
}
