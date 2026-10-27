import type { CheckoutItem } from "../../domain/checkout.js";
import type { Order, CheckoutProductPrice } from "../../domain/order.js";

export interface OrderStockChange {
  productId: string; productName: string; sku?: string; previousStock: number; stock: number;
  previousStatus: string; status: string;
}
export interface OrderFinalizationRepository {
  findExisting(id: string): Promise<Order | null>;
  loadPrices(items: readonly CheckoutItem[]): Promise<CheckoutProductPrice[]>;
  /** requestId is the durable deduplication identity, including concurrent retries. */
  commit(order: Order): Promise<{ order: Order; stockChanges: OrderStockChange[] }>;
}
export interface OrderFinalizationEffects {
  succeeded(order: Order, stockChanges: OrderStockChange[], requestId: string): Promise<void>;
  failed(email: string, items: CheckoutItem[], requestId: string, failureReason: string): Promise<void>;
}
export { InsufficientOrderStock } from "../../domain/order.error.js";
