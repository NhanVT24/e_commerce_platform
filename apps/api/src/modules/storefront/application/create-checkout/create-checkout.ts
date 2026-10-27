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
    let entity = await this.orders.findById(orderId);
    if (entity) {
      entity.assertCheckoutReplay(email, items, entity.items, new Date(this.now()).toISOString());
    } else {
      const prices = await this.orders.loadPrices(items);
      const order = Order.create({ id: orderId, customerEmail: email, items, products: prices,
        now: this.now(), holdSeconds: 300, bankCode: input.bankCode, locale: input.locale });
      entity = await this.orders.create(order);
    }
    entity.assertAwaitingPayment();
    const response = (paymentUrl: string) => ({ success: true, orderId, status: entity.status,
      lockedUntil: entity.lockedUntil, totalAmount: entity.totalAmount, items: entity.items, paymentUrl });
    if (entity.paymentTxnRef && entity.paymentUrl) return response(entity.paymentUrl);
    if (entity.paymentTxnRef) throw new OrderActionError("CONFLICT", "Checkout payment session requires reconciliation.");
    let payment: { paymentUrl: string; txnRef: string };
    try {
      payment = await this.payments.create({ email, items: entity.items.map(({ productId, quantity }) => ({ productId, quantity })),
        orderId, orderDescription: `Payment for order ${orderId}`, bankCode: input.bankCode, locale: input.locale,
        skipStockValidation: true, expiresAt: entity.lockedUntil, amount: entity.totalAmount });
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
