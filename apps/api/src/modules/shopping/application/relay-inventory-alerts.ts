import type { InventoryAlertOutbox, DurableInventoryAlertPublisher } from "./ports/inventory-alert-outbox.js";
import { InventoryAlertDelivery } from "../domain/inventory-alert-delivery.js";

/** Publishes at least once. A lost publish/marker response reuses the SAME event ID. */
export class RelayInventoryAlerts {
  constructor(private readonly store: InventoryAlertOutbox, private readonly publisher: DurableInventoryAlertPublisher,
    private readonly newOwner: () => string, private readonly now: () => number = Date.now,
    private readonly config = { limit: 100, leaseMs: 120_000, maxAttempts: 8, budgetMs: 20_000 }) {}

  async execute() {
    const started = this.now();
    const candidates = await this.store.due(new Date(started).toISOString(), this.config.limit);
    let claimed = 0, published = 0, retry = 0, failed = 0, lostLease = 0;
    for (const candidate of candidates) {
      if (this.now() - started >= this.config.budgetMs) break;
      const now = this.now();
      const claim = await this.store.claim(candidate, this.newOwner(), new Date(now).toISOString(), new Date(now + this.config.leaseMs).toISOString());
      if (!claim) continue;
      claimed++;
      try {
        // An expired last-attempt lease must not result in an unbounded ninth send.
        if (new InventoryAlertDelivery(candidate).exhausted(this.config.maxAttempts)) {
          const changed = await this.store.retry(claim, new Date(this.now()).toISOString(), new Date(this.now()).toISOString(), true);
          if (changed) failed++; else lostLease++;
          continue;
        }
        await this.publisher.publish(claim.event);
        if (await this.store.published(claim, new Date(this.now()).toISOString())) published++;
        else lostLease++;
      } catch {
        const delivery = new InventoryAlertDelivery(claim);
        const exhausted = delivery.exhausted(this.config.maxAttempts);
        const now = this.now();
        if (await this.store.retry(claim, new Date(now).toISOString(), delivery.nextRetryAt(now), exhausted)) {
          if (exhausted) failed++; else retry++;
        } else lostLease++;
      }
    }
    return { evaluated: candidates.length, claimed, published, retry, failed, lostLease };
  }
}
