import type { InventoryStockAlert } from "./inventory-alert-publisher.js";
import type { Product, ProductChanges } from "../../domain/product.js";

/**
 * TResult is an opaque compatibility representation owned by the outer adapter.
 * Application code must never inspect it (the existing API returns legacy metadata).
 */
export interface ProductWriteRepository<TResult> {
  findById(id: string): Promise<Product | null>;

  /**
   * Atomically check existence, expectedVersion and (when supplied) ownership;
   * update the product AND its dependent views, increment version and reset alert
   * metadata when stock changes. Conditional failure is ProductUpdateError(CONFLICT).
   * Infrastructure failures must propagate, never be classified as conflicts.
   */
  update(input: {
    product: Product;
    fields: readonly (keyof ProductChanges)[];
    expectedVersion: number;
    expectedOwnerId?: string;
    /** When present, commit this event in the SAME transaction as the mutation. */
    inventoryAlert?: InventoryStockAlert;
    changedBy?: string;
  }): Promise<{ product: Product; representation: TResult }>;
}
