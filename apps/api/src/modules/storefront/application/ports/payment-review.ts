export type { PaymentReviewDetails as PaymentReview } from "../../domain/payment-review.js";
export interface PaymentReviewWriter { open(review: import("../../domain/payment-review.js").PaymentReview): Promise<void>; }
/** Catch only after the durable manual-review record has been written. */
export class PaymentReviewRequired extends Error {
  constructor(readonly txnRef: string) { super("Payment reconciliation required; durable manual review recorded"); this.name = "PaymentReviewRequired"; }
}
