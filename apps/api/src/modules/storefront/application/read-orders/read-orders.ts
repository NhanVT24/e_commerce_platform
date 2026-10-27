import type { OrderReader } from "../ports/order-reader.js";
import { OrderActionError } from "../order-action.error.js";

export class GetOrderDetails {
  constructor(private readonly orders: OrderReader, private readonly now: () => number = Date.now) {}
  async execute(email: string, rawId: string) {
    const id = rawId.trim();
    if (!id || id.length > 128) throw new OrderActionError("NOT_FOUND", "Order not found.");
    const legacy = await this.orders.findLegacy(id);
    const order = legacy ?? await this.orders.findCheckout(id);
    // The same response for missing and foreign orders prevents existence disclosure.
    if (!order) throw new OrderActionError("NOT_FOUND", "Order not found.");
    if (order.customerEmail !== email) throw new OrderActionError("NOT_FOUND", "Order not found.");
    const items = legacy ? legacy.items : await this.orders.listItems(id);
    return { ...order, items, serverNow: new Date(this.now()).toISOString() };
  }
}

export class ListMyOrders {
  constructor(private readonly orders: OrderReader) {}
  async execute(email: string) {
    // Defense against an adapter accidentally returning another customer's row.
    return (await this.orders.listByCustomer(email)).filter(order => order.customerEmail === email);
  }
}
