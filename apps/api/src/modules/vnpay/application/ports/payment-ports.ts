import type { PaymentSession } from "../../domain/payment.js";
import type { Payment } from "../../domain/payment-session.js";

export interface PaymentSessions {
  find(txnRef: string): Promise<PaymentSession | null>;
  /** Compare pending -> terminal atomically; on a lost race return the durable winner. */
  confirm(payment: Payment): Promise<{ session: PaymentSession | null; changed: boolean }>;
  markDispatched(txnRef: string): Promise<void>;
}
export interface PaymentEvent {
  email: string; txnRef: string; amount: number; orderInfo: string; requestId?: string;
  responseCode: string; transactionNo: string; bankCode: string; payDate: string;
}
export interface PaymentEvents {
  publishCompleted(event: PaymentEvent): Promise<void>;
  publishFailed(event: PaymentEvent): Promise<void>;
}
export interface FailedPaymentOrders {
  release(input: { orderId: string; email?: string; amount: number; txnRef: string; cancelled: boolean }): Promise<void>;
}
export interface PaymentLog { error(event: string, details: Record<string, unknown>): void; }
