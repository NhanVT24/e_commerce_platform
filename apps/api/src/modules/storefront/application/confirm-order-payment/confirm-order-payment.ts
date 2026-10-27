import { PaymentReview } from "../../domain/payment-review.js";
import { Order } from "../../domain/order.js";
import type { CheckoutOrders, SettledPayments } from "../ports/checkout-ports.js";
import { PaymentReviewRequired, type PaymentReviewWriter } from "../ports/payment-review.js";

export class ConfirmOrderPayment {
  constructor(private readonly orders: CheckoutOrders, private readonly payments: SettledPayments,
    private readonly reviews: PaymentReviewWriter) {}
  async execute(input: { orderId: string; email: string; amount: number; txnRef: string }) {
    const payment = await this.payments.find(input.txnRef);
    if (!payment || payment.status !== "success" || payment.orderId !== input.orderId ||
      payment.email !== input.email || payment.amount !== input.amount) {
      throw new Error("Payment success is not durable; reconciliation required");
    }
    const order = await this.orders.findById(input.orderId);
    if (!order || !new Order(order).matchesPayment(input)) {
      await this.reviews.open(PaymentReview.create({ txnRef: input.txnRef, orderId: input.orderId, amount: input.amount, reason: "CORRELATION_MISMATCH" }));
      throw new PaymentReviewRequired(input.txnRef);
    }
    const recordIfReleased = async () => {
      const current = await this.orders.findById(input.orderId);
      if (current && new Order(current).isReleased) {
        await this.reviews.open(PaymentReview.create({ txnRef: input.txnRef, orderId: input.orderId, amount: input.amount, reason: "PAID_AFTER_RELEASE" }));
        throw new PaymentReviewRequired(input.txnRef);
      }
    };
    await recordIfReleased();
    try {
      return await this.orders.transition({ order: new Order(order), expectedCustomerEmail: input.email,
        expectedAmount: input.amount, expectedPaymentTxnRef: input.txnRef, status: "paid", paymentConfirmedAt: payment.paymentConfirmedAt });
    } catch (error) { await recordIfReleased(); throw error; }
  }
}
