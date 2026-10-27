export interface NotifiedOrders {
  findById(id: string): Promise<Order | null>;
  hasSentSystemNotification(orderId: string, customerEmail: string): Promise<boolean>;
  /** Conditional pending -> done and its status audit must commit atomically. */
  completePending(order: Order): Promise<boolean>;
}

/** Legacy fulfillment rule; this does not settle a checkout payment. */
export class CompleteNotifiedOrder {
  constructor(private readonly orders: NotifiedOrders) {}
  async execute(id: string) {
    const order = await this.orders.findById(id);
    if (!order) return { changed: false, completed: false };
    const entity = order;
    if (!entity.isAwaitingLegacyCompletion) return { changed: false, completed: entity.isLegacyCompleted };
    if (!entity.canCompleteLegacyNotification(await this.orders.hasSentSystemNotification(id, order.customerEmail))) return { changed: false, completed: false };
    return { changed: await this.orders.completePending(entity.completeLegacyAfterNotification(true)), completed: true };
  }
}
import { Order } from "../../storefront/domain/order.js";
