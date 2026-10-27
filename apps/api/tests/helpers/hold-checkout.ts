import { Order } from "../../src/modules/storefront/domain/order.js";
import type { CheckoutOrders } from "../../src/modules/storefront/application/ports/checkout-ports.js";
import type { CheckoutItem } from "../../src/modules/storefront/domain/checkout.js";

/** Adapter test setup uses the same entity contract as the application. */
export async function holdCheckout(orders: CheckoutOrders, input: {
  orderId: string; email: string; items: CheckoutItem[]; holdSeconds: number; bankCode?: string; locale?: "vn" | "en";
}) {
  let entity = await orders.findById(input.orderId);
  if (entity) entity.assertCheckoutReplay(input.email, input.items, entity.items, new Date().toISOString());
  else entity = await orders.create(Order.create({ id: input.orderId, customerEmail: input.email, items: input.items,
    products: await orders.loadPrices(input.items), now: Date.now(), holdSeconds: input.holdSeconds, bankCode: input.bankCode, locale: input.locale }));
  const snapshot = entity;
  return { order: snapshot, items: snapshot.items };
}
export async function transitionCheckout(orders: CheckoutOrders, input: Omit<Parameters<CheckoutOrders["transition"]>[0], "order"> & { orderId: string }) {
  const { orderId, ...context } = input;
  const current = await orders.findById(orderId);
  if (!current) throw new Error("Order not found");
  return orders.transition({ ...context, order: new Order(current) });
}
export async function attachCheckout(orders: CheckoutOrders, id: string, txnRef: string, email: string, paymentUrl: string) {
  const current = await orders.findById(id);
  if (!current) throw new Error("Order not found");
  const order = new Order(current);
  order.assertOwnedBy(email);
  return orders.attachPayment(order.withPayment(txnRef, paymentUrl));
}
