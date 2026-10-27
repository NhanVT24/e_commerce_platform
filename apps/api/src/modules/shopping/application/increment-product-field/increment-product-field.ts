import type { ProductCounterField } from "../../domain/product.js";
import type { InventoryAlertPublisher } from "../ports/inventory-alert-publisher.js";
import type { ProductCounterRepository } from "../ports/product-counter-repository.js";
import { assertCanManageProduct, assertProductActor, type ProductActor } from "../product-access.js";
import { ProductMutationError } from "../product-mutation.error.js";

export interface IncrementProductFieldCommand {
  productId: string;
  field: ProductCounterField;
  incrementBy: number;
  actor: ProductActor;
}

export class IncrementProductField<TResult> {
  constructor(private readonly products: ProductCounterRepository<TResult>, private readonly alerts: InventoryAlertPublisher, private readonly delivery: "direct" | "outbox" = "outbox") {}

  async execute(command: IncrementProductFieldCommand): Promise<TResult> {
    const { productId, field, incrementBy, actor } = command;
    assertProductActor(actor);
    if (!productId.trim() || (field !== "stock" && field !== "soldCount") ||
      !Number.isSafeInteger(incrementBy) || incrementBy < -99999 || incrementBy > 99999) {
      throw new ProductMutationError("INVALID_INPUT", "Invalid product increment");
    }
    const current = await this.products.findById(productId);
    assertCanManageProduct(current, actor);
    const next = current.adjustCounter(field, incrementBy);
    const transition = next.stockAlertSince(current);
    const saved = await this.products.increment({
      product: next, field, incrementBy, expectedVersion: current.version,
      expectedOwnerId: actor.isAdmin ? undefined : actor.subject,
      ...(this.delivery === "outbox" ? { inventoryAlert: transition ? { ...transition, source: "admin.increment" as const } : undefined, changedBy: actor.subject } : {})
    });
    const alert = saved.product.stockAlertSince(current);
    if (alert && this.delivery === "direct") {
      await this.alerts.publish({
        ...alert, source: "admin.increment"
      });
    }
    return saved.representation;
  }
}
