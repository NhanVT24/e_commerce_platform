import type { OrderCancellationRepository } from "../ports/order-lifecycle-ports.js";
import { assertOwnedOrder } from "../order-access.js";

export class CancelOrder {
  constructor(private readonly orders: OrderCancellationRepository) {}

  async execute(email: string, orderId: string) {
    const order = await this.orders.findById(orderId);
    assertOwnedOrder(order, email);
    const outcome = await this.orders.cancel(order);
    return { success: true, orderId, status: outcome.order.status, released: outcome.changed };
  }
}
