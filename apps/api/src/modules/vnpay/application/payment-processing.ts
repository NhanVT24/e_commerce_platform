import { Payment } from "../domain/payment-session.js";
import type { PaymentSession, VerifiedPaymentCallback } from "../domain/payment.js";
import type { PaymentSessions, PaymentEvents, FailedPaymentOrders, PaymentLog } from "./ports/payment-ports.js";

export class PaymentProcessing {
  constructor(private readonly sessions: PaymentSessions, private readonly events: PaymentEvents,
    private readonly orders: FailedPaymentOrders, private readonly log: PaymentLog) {}

  async confirm(callback: VerifiedPaymentCallback) {
    let session = await this.sessions.find(callback.txnRef);
    if (!session) return { outcome: "not_found" as const };
    if (!new Payment(session).matchesAmount(callback.amountMinor)) {
      return { outcome: "invalid_amount" as const };
    }
    let alreadyConfirmed = !new Payment(session).isPending;
    if (!alreadyConfirmed) {
      const outcome = await this.sessions.confirm(new Payment(session).confirmedBy(callback));
      session = outcome.session;
      alreadyConfirmed = !outcome.changed;
    }
    if (!session || !new Payment(session).matchesOutcome(callback)) {
      throw new Error("Conflicting payment callback; reconciliation required");
    }
    // A duplicate must resume an interrupted hand-off before acknowledging.
    await this.dispatch(session);
    return { outcome: alreadyConfirmed ? "already_confirmed" as const : "confirmed" as const };
  }

  async resumeDispatch(session: PaymentSession) {
    if (!new Payment(session).isFinal) return;
    await this.dispatch(session);
  }

  private async dispatch(session: PaymentSession) {
    const payment = new Payment(session);
    if (!payment.needsDispatch) return;
    const event = payment.dispatchEvent();
    const release = payment.failureRelease();
    if (release) await this.orders.release(release);
    if (session.status === "success") await this.events.publishCompleted(event);
    else if (session.status === "failed") await this.events.publishFailed(event);
    else throw new Error("Cannot dispatch a non-final payment");
    // Publish first, mark second: replay is possible; downstream MUST be idempotent.
    await this.sessions.markDispatched(session.txnRef);
  }
}
