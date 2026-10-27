import type { CheckoutItem } from "../../domain/checkout.js";
import { Order } from "../../domain/order.js";
import { normalizeCheckoutItems } from "../checkout-items.js";
import { OrderActionError } from "../order-action.error.js";
import { InsufficientOrderStock } from "../ports/order-finalization-ports.js";
import type { OrderFinalizationRepository, OrderFinalizationEffects } from "../ports/order-finalization-ports.js";

export class FinalizeOrder {
  constructor(private readonly orders: OrderFinalizationRepository, private readonly effects: OrderFinalizationEffects) {}
  async execute(email: string, items: CheckoutItem[], requestId?: string) {
    if (!email?.trim() || !requestId?.trim()) throw new OrderActionError("INVALID_INPUT", "Order finalization requires customer and requestId.");
    const normalized = normalizeCheckoutItems(items);
    let committed: Awaited<ReturnType<OrderFinalizationRepository["commit"]>>;
    try {
      let entity = await this.orders.findExisting(requestId);
      if (entity) {
        const orderData = entity;
        if (!entity.isOwnedBy(email) || orderData.items.length !== normalized.length ||
            !normalized.every(item => orderData.items.some(line => line.productId === item.productId && line.quantity === item.quantity))) {
          throw new OrderActionError("CONFLICT", "Order request identity does not match.");
        }
      } else {
        entity = Order.createLegacy({ id: requestId, customerEmail: email, items: normalized,
          products: await this.orders.loadPrices(normalized), now: Date.now(), holdSeconds: 300 });
      }
      committed = await this.orders.commit(entity);
    }
    catch (error) {
      if (!(error instanceof InsufficientOrderStock)) throw error;
      const failureReason = "Payment is failed due to insufficient stock for one or more items in your order. Please review your cart and try again.";
      await this.effects.failed(email, normalized, requestId, failureReason);
      return { type: "storefront.order.failed" as const, outcome: "failed" as const, requestId, orderId: "" as const,
        customer: email, status: "failed" as const, totalAmount: 0 as const, itemCount: normalized.length, failureReason };
    }
    const { order, stockChanges } = committed;
    await this.effects.succeeded(order, stockChanges, requestId);
    return { type: "storefront.order.succeeded" as const, outcome: "success" as const, requestId,
      orderId: order.id, customer: email, status: "pending" as const, totalAmount: order.totalAmount, itemCount: order.items.length };
  }
}
