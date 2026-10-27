import type { Product } from "../../domain/product.js";

export interface ProductDeleter {
  findById(id: string): Promise<Product | null>;
  /** Conditional version/owner deletion with dependent views and authoritative audit.
   * Keep deletion audit and product removal in one transaction. */
  delete(input: { product: Product; expectedOwnerId?: string }): Promise<void>;
}
