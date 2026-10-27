import type { CheckoutItem } from "../../domain/checkout.js";
import type { OrderLifecycleStatus } from "../../domain/order-refund.js";
import type { Order, NewCheckoutOrder, CheckoutProductPrice } from "../../domain/order.js";

export interface HeldOrder {
  id: string;
  customerEmail: string;
  status: OrderLifecycleStatus;
  totalAmount: number;
  lockedUntil: string;
  paymentTxnRef?: string;
  paymentUrl?: string;
  paymentConfirmedAt?: string;
}
export interface CheckoutLine extends CheckoutItem {
  productName: string;
  unitPrice: number;
  originalUnitPrice?: number;
  lineTotal: number;
}
export interface CheckoutOrders {
  findForReplay(id: string): Promise<Order<HeldOrder & { items: CheckoutLine[] }> | null>;
  loadPrices(items: readonly CheckoutItem[]): Promise<CheckoutProductPrice[]>;
  /** Creation is atomic. A repeated ID must never deduct stock a second time. */
  hold(order: Order<NewCheckoutOrder>): Promise<Order<HeldOrder & { items: CheckoutLine[] }>>;
  findById(id: string): Promise<HeldOrder | null>;
  attachPayment(order: Order<HeldOrder>): Promise<void>;
  /** Conditional state change and inventory changes commit together. */
  transition(input: { order: Order<HeldOrder>; expectedCustomerEmail?: string; expectedPaymentTxnRef?: string;
    expectedAmount?: number; status: "paid" | "cancelled" | "expired" | "payment_failed";
    paymentConfirmedAt?: string; expiresBefore?: string }): Promise<{ order: HeldOrder; items: CheckoutLine[]; changed: boolean }>;
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
