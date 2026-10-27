import type { Order } from "../domain/order.js";
import type { RefundStatus } from "../domain/order-refund.js";
import { isTerminalRefund } from "../domain/order-refund.js";
import { OrderActionError } from "./order-action.error.js";
import type { RefundGateway, RefundNotifier, RefundOrderRepository, RefundOutcome, OrderOperationLogger } from "./ports/order-lifecycle-ports.js";

/** Shared by customer polling, request completion and scheduled reconciliation. */
export class RefundResolution {
  constructor(
    private readonly orders: RefundOrderRepository,
    private readonly gateway: RefundGateway,
    private readonly notifier: RefundNotifier,
    private readonly log: OrderOperationLogger
  ) {}

  async notify(order: Order, status: RefundStatus): Promise<void> {
    try {
      await this.notifier.send({ email: order.customerEmail, orderId: order.id, totalAmount: order.totalAmount, status });
    } catch (error) {
      // Notification failure must never change a committed financial result.
      this.log.warn("refund.notification_failed", { orderId: order.id, requestId: order.refundRequestId, error });
    }
  }

  async apply(order: Order, outcome: RefundOutcome) {
    let saved: Awaited<ReturnType<RefundOrderRepository["saveOutcome"]>>;
    try {
      saved = await this.orders.saveOutcome(order.recordRefundOutcome(outcome));
    } catch (error) {
      this.log.error("refund.persistence_failed", { orderId: order.id, requestId: order.refundRequestId, error });
      throw error;
    }
    if (saved.changed) await this.notify(saved.order, outcome.status);
    return saved;
  }

  async resolve(order: Order) {
    if (isTerminalRefund(order.status)) return { order, changed: false };
    if (!order.refundRequestId || !order.paymentTxnRef) {
      throw new OrderActionError("CONFLICT", "No refund request for this order.");
    }
    const payment = await this.gateway.findPayment(order.paymentTxnRef);
    if (!order.matchesRefundPayment(payment)) {
      throw new OrderActionError("CONFLICT", "Payment session not found.");
    }
    let outcome: RefundOutcome | null;
    try {
      outcome = await this.gateway.query({ paymentReference: order.paymentTxnRef,
        amount: order.totalAmount, refundTransactionNo: order.refundTransactionNo });
    } catch (error) {
      this.log.warn("refund.query_failed", { orderId: order.id, requestId: order.refundRequestId, error });
      throw error;
    }
    return outcome && isTerminalRefund(outcome.status) ? this.apply(order, outcome) : { order, changed: false };
  }
}
