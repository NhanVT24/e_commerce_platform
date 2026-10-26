import { OrderItems } from "../domain/order-items.js";
import type { CheckoutItem } from "../domain/checkout.js";
// Compatibility entry point; the value object owns normalization and invariants.
export function normalizeCheckoutItems(items: readonly CheckoutItem[]): CheckoutItem[] {
  return OrderItems.create(items).toSnapshot();
}
