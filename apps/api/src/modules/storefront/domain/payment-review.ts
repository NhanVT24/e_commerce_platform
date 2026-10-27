import { OrderActionError } from "./order.error.js";
export interface PaymentReviewDetails {
    txnRef: string;
    orderId: string;
    amount: number;
    reason: "PAID_AFTER_RELEASE" | "CORRELATION_MISMATCH" | "PROVIDER_UNCONFIRMED";
}

/** A review keeps its payment identity even when later evidence reopens it. */
export class PaymentReview {
    readonly #state: Readonly<PaymentReviewDetails>;

    constructor(snapshot: PaymentReviewDetails) {
        this.#state = Object.freeze({ ...snapshot });
    }

    toSnapshot(): PaymentReviewDetails { return { ...this.#state }; }
    static create(input: PaymentReviewDetails): PaymentReview {
        if (!input.txnRef.trim() || !input.orderId.trim() || !Number.isFinite(input.amount) || input.amount <= 0 ||
            !["PAID_AFTER_RELEASE", "CORRELATION_MISMATCH", "PROVIDER_UNCONFIRMED"].includes(input.reason)) {
            throw new OrderActionError("INVALID_INPUT", "Invalid payment review.");
        }
        return new PaymentReview(input);
    }

    assertSamePayment(incoming: PaymentReviewDetails): void {
        if (this.#state.txnRef !== incoming.txnRef || this.#state.orderId !== incoming.orderId ||
            this.#state.amount !== incoming.amount) {
            throw new Error("Manual-review identity conflict");
        }
    }

    shouldReopenFor(incoming: PaymentReviewDetails): boolean {
        this.assertSamePayment(incoming);
        // Confirmed payment evidence supersedes a previously closed uncertainty.
        return this.#state.reason === "PROVIDER_UNCONFIRMED" && incoming.reason !== "PROVIDER_UNCONFIRMED";
    }
}
