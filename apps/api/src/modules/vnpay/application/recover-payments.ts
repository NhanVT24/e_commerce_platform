import { PaymentReview } from "../../storefront/domain/payment-review.js";
import { recoveryLanes } from "./ports/payment-recovery-ports.js";
import type { PaymentRecoveryQueue, PaymentRecoverySessions, PaymentStatusGateway, CheckoutProvisioning, RecoverablePayment } from "./ports/payment-recovery-ports.js";
import type { PaymentReviewWriter } from "../../storefront/application/ports/payment-review.js";
import type { PaymentProcessing } from "./payment-processing.js";
import type { PaymentLog } from "./ports/payment-ports.js";

export class RecoverPayments {
  constructor(private readonly queue: PaymentRecoveryQueue, private readonly sessions: PaymentRecoverySessions,
    private readonly gateway: PaymentStatusGateway, private readonly processing: Pick<PaymentProcessing, "confirm" | "resumeDispatch">,
    private readonly checkouts: CheckoutProvisioning, private readonly reviews: PaymentReviewWriter,
    private readonly log: PaymentLog, private readonly now: () => number = Date.now) {}

  async execute(perLane = 5, budgetMs = 40000) {
    if (!Number.isSafeInteger(perLane) || perLane < 1 || perLane > 10 || !Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 45000) {
      throw new Error("Invalid recovery budget");
    }
    const deadline = this.now() + budgetMs;
    let checked = 0, recovered = 0, failed = 0;
    for (const lane of recoveryLanes) {
      if (this.now() >= deadline) break;
      const page = await this.queue.page(lane, perLane);
      let complete = true;
      for (const id of page.ids) {
        if (this.now() >= deadline) { complete = false; break; }
        checked++;
        let queried: RecoverablePayment | undefined;
        try {
          if (lane === "checkout") { await this.checkouts.resume(id); recovered++; continue; }
          const session = await this.sessions.find(id);
          if (!session) continue;
          if (session.status === "success" || session.status === "failed") {
            if (!session.paymentEventEnqueuedAt) { await this.processing.resumeDispatch(session); recovered++; }
            continue;
          }
          if (session.status !== "pending" || this.now() - Date.parse(session.createdAt) < 60000 ||
            (session.recoveryNextAt && Date.parse(session.recoveryNextAt) > this.now())) continue;
          // Persist backoff BEFORE the query. Crash/concurrent runs cannot turn
          // an ambiguous network result into immediate repeated provider calls.
          const attempts = (session.recoveryAttempts ?? 0) + 1;
          const delay = Math.min(300000 * 2 ** Math.min(attempts - 1, 4), 3600000);
          await this.sessions.defer(id, attempts, new Date(this.now() + delay).toISOString());
          queried = { ...session, recoveryAttempts: attempts };
          const callback = await this.gateway.query(session);
          if (callback) {
            queried = undefined; // Subsequent hand-off errors are not unknown provider outcomes.
            const outcome = await this.processing.confirm(callback);
            if (outcome.outcome === "confirmed" || outcome.outcome === "already_confirmed") recovered++;
            else throw new Error("Provider result does not match durable session");
          } else if (attempts >= 12 && session.orderId) {
            await this.reviews.open(PaymentReview.create({ txnRef: id, orderId: session.orderId, amount: session.amount, reason: "PROVIDER_UNCONFIRMED" }));
            this.log.error("payment.provider_unconfirmed_review", { txnRef: id, orderId: session.orderId, attempts });
          }
        } catch (error) {
          failed++;
          if (queried?.orderId && (queried.recoveryAttempts ?? 0) >= 12) {
            try {
              await this.reviews.open(PaymentReview.create({ txnRef: id, orderId: queried.orderId, amount: queried.amount, reason: "PROVIDER_UNCONFIRMED" }));
              this.log.error("payment.provider_unconfirmed_review", { txnRef: id, orderId: queried.orderId, attempts: queried.recoveryAttempts });
            } catch (reviewError) { this.log.error("payment.review_store_failed", { txnRef: id, error: String(reviewError) }); }
          }
          this.log.error("payment.recovery_item_failed", { lane, id, error: String(error) });
        }
      }
      // A failed item is revisited on wrap; an interrupted page is not skipped.
      if (complete) await this.queue.checkpoint(lane, page.checkpoint);
    }
    return { checked, recovered, failed };
  }
}
