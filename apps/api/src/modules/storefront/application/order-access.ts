import type { Order } from "../domain/order.js";
import { OrderActionError } from "./order-action.error.js";

export function assertOwnedOrder(order: Order | null, email: string): asserts order is Order {
  // Preserve not-found for another customer's order; do not disclose its existence.
  if (!order) throw new OrderActionError("NOT_FOUND", "Order not found.");
  order.assertOwnedBy(email);
}
