import type { InventoryStockAlert } from "./inventory-alert-publisher.js";
import type { ProductCounterField } from "../../domain/counter-policy.js";
import type { Product, ProductCounters, ProductStatus } from "../../domain/product.js";

export interface ProductCounterRepository<TResult> {
  findById(id: string): Promise<ProductCounters | null>;
  /** Atomic snapshot version/owner check, counter write and dependent views update.
   * Conditional failure is CONFLICT; no automatic retry of ambiguous writes. */
  increment(input: {
    id: string;
    field: ProductCounterField;
    incrementBy: number;
    nextValue: number;
    status: ProductStatus;
    expectedVersion: number;
    expectedOwnerId?: string;
    /** When present, commit this event in the SAME transaction as the mutation. */
    inventoryAlert?: InventoryStockAlert;
    changedBy?: string;
  }): Promise<{ product: Product; representation: TResult }>;
}
