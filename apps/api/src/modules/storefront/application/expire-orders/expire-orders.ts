import type { CheckoutOrders, CheckoutLog } from "../ports/checkout-ports.js";

export class ExpireOrders {
  constructor(private readonly orders: CheckoutOrders, private readonly log: CheckoutLog,
    private readonly now: () => number = Date.now) {}
  async execute() {
    const checkedAt = new Date(this.now()).toISOString();
    let releasedCount = 0;
    let failed = 0;
    for await (const orderId of this.orders.expiredCandidates(checkedAt)) {
      try {
        // GSI results can be stale; the transaction rechecks state and deadline.
        const current = await this.orders.findById(orderId);
        if (!current) continue;
        const result = await this.orders.transition({ order: current, status: "expired", expiresBefore: checkedAt });
        if (result.changed) releasedCount++;
      } catch (error) { failed++; this.log.error("order.expiry_failed", { orderId, error: String(error) }); }
    }
    return { ok: failed === 0, releasedCount, failed, checkedAt };
  }
}
