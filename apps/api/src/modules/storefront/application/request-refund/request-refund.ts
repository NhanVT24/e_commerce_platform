import { Order } from "../../domain/order.js";
import { isRefundEligible, refundResponse } from "../../domain/order-refund.js";
import type { RefundGateway, RefundOrderRepository, OrderOperationLogger, RefundOutcome } from "../ports/order-lifecycle-ports.js";
import { OrderActionError } from "../order-action.error.js";
import { assertOwnedOrder } from "../order-access.js";
import { RefundResolution } from "../refund-resolution.js";

export class RequestRefund {
  constructor(
    private readonly orders: RefundOrderRepository,
    private readonly gateway: RefundGateway,
    private readonly resolution: RefundResolution,
    private readonly log: OrderOperationLogger,
    private readonly newRequestId: () => string,
    private readonly now: () => number
  ) {}

  async execute(email: string, orderId: string) {
    const order = await this.orders.findById(orderId);
    assertOwnedOrder(order, email);
    if (order.refundRequestId) return refundResponse(order);
    if (!isRefundEligible(order, this.now())) {
      throw new OrderActionError("CONFLICT", "Refund is available for 5 minutes after confirmed payment.");
    }
    const payment = await this.gateway.findPayment(order.paymentTxnRef!);
    if (!order.matchesRefundPayment(payment)) {
      throw new OrderActionError("CONFLICT", "Payment details are not ready for refund.");
    }
    this.gateway.assertReady();
    const requestId = this.newRequestId();
    const claimTime = this.now();
    const claimed = order.claimRefund(requestId, claimTime);
    try {
      await this.orders.claim({ order: claimed, now: claimTime });
    } catch (error) {
      if (error instanceof OrderActionError && error.code === "CONFLICT") {
        throw new OrderActionError("CONFLICT", "Refund already requested or order changed.");
      }
      throw error;
    }
    let outcome: RefundOutcome;
    try {
      // One attempt only. A timeout may mean the provider already accepted it.
      outcome = await this.gateway.request({ orderId, requestId, paymentReference: order.paymentTxnRef!, amount: order.totalAmount });
    } catch (error) {
      this.log.error("refund.provider_result_unknown", { orderId, requestId, error });
      return this.pendingResponse(claimed, true);
    }
    try {
      return refundResponse((await this.resolution.apply(claimed, outcome)).order);
    } catch {
      // Provider succeeded but persistence may not have committed. Reconcile,
      // never send another refund or report a definitive provider rejection.
      return this.pendingResponse(claimed, false);
    }
  }

  private async pendingResponse(claimed: Order, notify: boolean) {
    const current = await this.orders.findById(claimed.id);
    const known = current ?? new Order({ ...claimed, refundStatus: "unknown" });
    if (notify && known.status === "refund_pending") await this.resolution.notify(known, "refund_pending");
    return refundResponse(known);
  }
}
