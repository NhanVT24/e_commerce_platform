import type { CheckoutOrders } from "../ports/checkout-ports.js";
import { OrderActionError } from "../order-action.error.js";

export class GetCheckoutStatus {
  constructor(private readonly orders: CheckoutOrders, private readonly now: () => number = Date.now) {}
  async execute(email: string, orderId: string) {
    let order = await this.orders.findById(orderId);
    if (!order || order.customerEmail !== email) throw new OrderActionError("NOT_FOUND", "Order not found.");
    const now = new Date(this.now()).toISOString();
    if (order.isCheckoutExpiredAt(now)) {
      order = (await this.orders.transition({ order, expectedCustomerEmail: email, status: "expired", expiresBefore: now })).order;
    }
    return { orderId, status: order.status, lockedUntil: order.lockedUntil };
  }
}
