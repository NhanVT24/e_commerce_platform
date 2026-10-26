import type { ProductDeleter } from "../ports/product-deleter.js";
import { assertCanManageProduct, assertProductActor, type ProductActor } from "../product-access.js";
import { ProductMutationError } from "../product-mutation.error.js";

export class DeleteProduct {
  constructor(private readonly products: ProductDeleter) {}

  async execute(command: { productId: string; actor: ProductActor }): Promise<void> {
    const { productId, actor } = command;
    assertProductActor(actor);
    if (!productId.trim()) throw new ProductMutationError("INVALID_INPUT", "Invalid product ID");
    const current = await this.products.findById(productId);
    assertCanManageProduct(current, actor);
    current.assertValidState();
    await this.products.delete({ id: productId, expectedVersion: current.version,
      expectedOwnerId: actor.isAdmin ? undefined : actor.subject });
  }
}
