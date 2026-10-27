import type { CheckoutOrders } from "../../src/modules/storefront/application/ports/checkout-ports.js";
import { Order, type OrderData, type OrderItem } from "../../src/modules/storefront/domain/order.js";

/** In-memory port double, not a DynamoDB transaction/concurrency emulator. */
export function checkoutFixture() {
  const order: OrderData = {
    id: "order-1", customerEmail: "customer@example.test", status: "awaiting_payment",
    totalAmount: 2000, lockedUntil: "2026-10-22T00:05:00.000Z", paymentTxnRef: "payment-1"
  };
  const items: OrderItem[] = [{ productId: "product-1", productName: "Keyboard", quantity: 2, unitPrice: 1000, lineTotal: 2000 }];
  const events: string[] = [];
  let exists = true;
  const orders: CheckoutOrders = {
    async loadPrices() { return items.map(item => ({ ...item, stock: 100, version: 1 })); },
    async create() { exists = true; events.push("hold"); return new Order({ ...order, items }); },
    async findById() { return exists ? new Order({ ...order, items }) : null; },
    async attachPayment() { events.push("attach"); },
    async transition(input) {
      events.push(`transition:${input.status}`);
      return { order: new Order({ ...order, status: input.status, paymentConfirmedAt: input.paymentConfirmedAt, items }), items, changed: true };
    },
    async *expiredCandidates() { /* no expired orders */ }
  };
  return { orders, order, items, events, newOrderRequest() { exists = false; } };
}
