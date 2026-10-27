import type { RefundPayment, RefundStatus } from "../../domain/order-refund.js";
import type { Order } from "../../domain/order.js";

export interface OrderCancellationRepository {
  findById(id: string): Promise<Order | null>;
  /** Conditional owner/state transition and inventory release in one transaction. */
  cancel(order: Order): Promise<{ order: Order; changed: boolean }>;
}

export interface RefundOutcome {
  status: RefundStatus;
  gatewayStatus: string;
  transactionNo?: string;
}

export interface RefundOrderRepository {
  findById(id: string): Promise<Order | null>;
  listPending(limit: number): Promise<Order[]>;
  /** Claim one refund identity while checking paid timestamp/window and ownership atomically. */
  claim(input: { order: Order; now: number }): Promise<void>;
  /** Conditional requestId + pending transition. On refund_sent, inventory restoration
   * and the terminal transition must commit together. A competing winner is returned
   * as changed:false; infrastructure/inventory failures must propagate. */
  saveOutcome(order: Order): Promise<{ order: Order; changed: boolean }>;
}

export interface RefundGateway {
  findPayment(reference: string): Promise<RefundPayment | null>;
  assertReady(): void;
  request(input: { orderId: string; requestId: string; paymentReference: string; amount: number }): Promise<RefundOutcome>;
  query(input: { paymentReference: string; amount: number; refundTransactionNo?: string }): Promise<RefundOutcome | null>;
}

export interface RefundNotifier {
  send(input: { email: string; orderId: string; totalAmount: number; status: RefundStatus }): Promise<void>;
}

export interface OrderOperationLogger {
  warn(event: string, context: { orderId: string; requestId?: string; error?: unknown }): void;
  error(event: string, context: { orderId: string; requestId?: string; error?: unknown }): void;
}
