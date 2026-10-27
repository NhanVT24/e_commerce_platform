import { Order } from "../../domain/order.js";
import { normalizeCheckoutItems } from "../checkout-items.js";
import type { CheckoutItem } from "../../domain/checkout.js";
import type { CheckoutOrders, CheckoutPayments, CheckoutLog } from "../ports/checkout-ports.js";
import { OrderActionError } from "../order-action.error.js";

export class CreateCheckout {
  constructor(private readonly orders: CheckoutOrders, private readonly payments: CheckoutPayments,
    private readonly log: CheckoutLog, private readonly newId: () => string, private readonly now: () => number = Date.now) {}

  async execute(email: string, input: { requestId?: string; items: CheckoutItem[]; bankCode?: string; locale?: "vn" | "en" }) {
    const items = normalizeCheckoutItems(input.items);
    const orderId = input.requestId?.trim() || this.newId();
    let entity = await this.orders.findForReplay(orderId);
    if (entity) {
      entity.assertCheckoutReplay(email, items, entity.toSnapshot().items, new Date(this.now()).toISOString());
    } else {
      const prices = await this.orders.loadPrices(items);
      const order = Order.create({ id: orderId, customerEmail: email, items, products: prices,
        now: this.now(), holdSeconds: 300, bankCode: input.bankCode, locale: input.locale });
      entity = await this.orders.hold(order);
    }
    const snapshot = entity.toSnapshot();
    const created = { order: snapshot, items: snapshot.items };
    new Order(created.order).assertAwaitingPayment();
    const response = (paymentUrl: string) => ({ success: true, orderId, status: created.order.status,
      lockedUntil: created.order.lockedUntil, totalAmount: created.order.totalAmount, items: created.items, paymentUrl });
    if (created.order.paymentTxnRef && created.order.paymentUrl) return response(created.order.paymentUrl);
    if (created.order.paymentTxnRef) throw new OrderActionError("CONFLICT", "Checkout payment session requires reconciliation.");
    let payment: { paymentUrl: string; txnRef: string };
    try {
      payment = await this.payments.create({ email, items: created.items.map(({ productId, quantity }) => ({ productId, quantity })),
        orderId, orderDescription: `Payment for order ${orderId}`, bankCode: input.bankCode, locale: input.locale,
        skipStockValidation: true, expiresAt: created.order.lockedUntil, amount: created.order.totalAmount });
    } catch (error) {
      // A concurrent request may have committed a usable session. Do not release
      // its hold on an ambiguous failure; retry safely or let expiry handle it.
      this.log.error("checkout.provisioning_interrupted", { orderId, error: String(error) });
      throw error;
    }
    await this.orders.attachPayment(entity.withPayment(payment.txnRef, payment.paymentUrl));
    return response(payment.paymentUrl);
  }
}
