import type { CheckoutItem } from "../../domain/checkout.js";
import type { Order, OrderItem, CheckoutProductPrice } from "../../domain/order.js";

export interface CheckoutOrders {
  loadPrices(items: readonly CheckoutItem[]): Promise<CheckoutProductPrice[]>;
  /** Creation is atomic. A repeated ID must never deduct stock a second time. */
  create(order: Order): Promise<Order>;
  findById(id: string): Promise<Order | null>;
  attachPayment(order: Order): Promise<void>;
  /** Conditional state change and inventory changes commit together. */
  transition(input: { order: Order; expectedCustomerEmail?: string; expectedPaymentTxnRef?: string;
    expectedAmount?: number; status: "paid" | "cancelled" | "expired" | "payment_failed";
    paymentConfirmedAt?: string; expiresBefore?: string }): Promise<{ order: Order; items: readonly OrderItem[]; changed: boolean }>;
  expiredCandidates(now: string): AsyncIterable<string>;
}
export interface CheckoutPayments {
  create(input: { email: string; items: CheckoutItem[]; orderId: string; orderDescription: string;
    bankCode?: string; locale?: "vn" | "en"; skipStockValidation: boolean; expiresAt: string; amount: number }):
    Promise<{ paymentUrl: string; txnRef: string }>;
}
export interface CheckoutLog { error(event: string, details: Record<string, unknown>): void; }
export interface SettledPayments {
  find(txnRef: string): Promise<{ status: string; amount: number; email?: string; orderId?: string; paymentConfirmedAt?: string } | null>;
}
