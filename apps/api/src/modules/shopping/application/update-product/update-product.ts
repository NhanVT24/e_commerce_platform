import { Product, type ProductChanges } from "../../domain/product.js";
import type { InventoryAlertPublisher } from "../ports/inventory-alert-publisher.js";
import type { ProductWriteRepository } from "../ports/product-write-repository.js";
import { ProductMutationError } from "../product-mutation.error.js";
import { assertCanManageProduct, type ProductActor } from "../product-access.js";

export interface UpdateProductCommand {
  readonly productId: string;
  readonly changes: ProductChanges;
  readonly expectedVersion: number;
  // This actor must be constructed from an authenticated principal by the caller.
  readonly actor: ProductActor;
}

export class UpdateProduct<TResult> {
  constructor(
    private readonly products: ProductWriteRepository<TResult>,
    private readonly alerts: InventoryAlertPublisher,
    private readonly delivery: "direct" | "outbox" = "outbox"
  ) {}

  async execute(command: UpdateProductCommand): Promise<TResult> {
    const { productId, changes, expectedVersion, actor } = command;
    if (!productId.trim() || !actor.subject.trim() ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new ProductMutationError("INVALID_INPUT", "Invalid product update");
    }
    if (changes.stock !== undefined) Product.assertEditableStock(changes.stock);

    const current = await this.products.findById(productId);
    assertCanManageProduct(current, actor);
    current.assertVersion(expectedVersion);
    const next = current.update(changes);
    const transition = next.stockAlertSince(current);
    const saved = await this.products.update({
      id: productId, changes, status: next.stockStatus, expectedVersion,
      expectedOwnerId: actor.isAdmin ? undefined : actor.subject,
      ...(this.delivery === "outbox" ? { inventoryAlert: transition ? { ...transition, source: "admin.update" as const } : undefined, changedBy: actor.subject } : {})
    });
    const alert = saved.product.stockAlertSince(current);
    if (alert && this.delivery === "direct") {
      // Preserve existing behavior: publish is awaited AFTER commit. A publish
      // failure propagates; this does not provide atomic delivery or safe retries.
      await this.alerts.publish({
        ...alert, source: "admin.update"
      });
    }
    return saved.representation;
  }
}
