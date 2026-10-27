import { Order, type OrderData, type OrderStatus } from "./order.js";
export type OrderLifecycleStatus = OrderStatus;
export type RefundStatus = Extract<OrderLifecycleStatus, "refund_pending" | "refund_sent" | "refund_rejected">;

export interface RefundPayment {
  reference: string;
  amount: number;
  status: "pending" | "success" | "failed" | "expired";
  orderId?: string;
}

export { REFUND_WINDOW_MS } from "./order.js";

export function isRefundEligible(order: OrderData, now: number): boolean {
  return new Order(order).isRefundEligibleAt(now);
}

export function isTerminalRefund(status: OrderLifecycleStatus): status is "refund_sent" | "refund_rejected" {
  return Order.isTerminalRefundStatus(status);
}

export function refundResponse(order: OrderData) {
  return new Order(order).refundResponse();
}
