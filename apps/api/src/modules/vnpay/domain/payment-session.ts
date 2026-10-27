import type { PaymentSession, VerifiedPaymentCallback } from "./payment.js";
export interface NewPaymentSession extends PaymentSession {
    status: "pending"; createdAt: string; updatedAt: string; expiresAt: string; transactionDate: string; paymentUrl?: string;
}
export class Payment<T extends PaymentSession = PaymentSession> {
    readonly #state: Readonly<T>;
    constructor(snapshot: T) { this.#state = Object.freeze({ ...snapshot }); }
    toSnapshot(): T { return { ...this.#state }; }
    static create(input: { txnRef: string; orderId?: string; email?: string; orderInfo: string; amount: number;
        expiresAt: string; transactionDate: string; paymentUrl?: string }, now: number): Payment<NewPaymentSession> {
        if (!input.txnRef.trim() || !input.orderInfo.trim() || !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
            !Number.isSafeInteger(input.amount * 100) || input.amount * 100 > 999999999999 ||
            !Number.isFinite(new Date(now).getTime()) || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= now) {
            throw new Error("Invalid payment session.");
        }
        const timestamp = new Date(now).toISOString();
        return new Payment({ ...input, email: input.email?.trim().toLowerCase() || undefined,
            status: "pending", createdAt: timestamp, updatedAt: timestamp });
    }
    get isPending() { return this.#state.status === "pending"; }
    get isFinal() { return this.#state.status === "success" || this.#state.status === "failed"; }
    get needsDispatch() { return !this.#state.paymentEventEnqueuedAt; }
    confirmedBy(callback: VerifiedPaymentCallback): Payment<T> {
        if (callback.txnRef !== this.#state.txnRef || !this.matchesAmount(callback.amountMinor)) {
            throw new Error("Payment callback identity or amount does not match");
        }
        if (!this.isPending) throw new Error("Payment is already finalized");
        return new Payment({ ...this.#state, status: callback.transactionStatus, responseCode: callback.responseCode,
            transactionNo: callback.transactionNo, gatewayTransactionStatus: callback.gatewayTransactionStatus,
            bankCode: callback.bankCode, payDate: callback.payDate });
    }
    matchesAmount(amountMinor: string) {
        return Number.isSafeInteger(this.#state.amount * 100) && this.#state.amount * 100 === Number(amountMinor);
    }
    matchesOutcome(callback: VerifiedPaymentCallback) {
        return this.#state.status === callback.transactionStatus && this.#state.responseCode === callback.responseCode &&
            this.#state.transactionNo === callback.transactionNo &&
            (!this.#state.gatewayTransactionStatus || this.#state.gatewayTransactionStatus === callback.gatewayTransactionStatus);
    }
    dispatchEvent() {
        const session = this.#state;
        if (!session.email)
            throw new Error("Payment has no customer email; reconciliation required");
        if (!this.isFinal)
            throw new Error("Cannot dispatch a non-final payment");
        const requestId = session.orderId ?? session.orderInfo.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
        return { email: session.email, txnRef: session.txnRef, amount: session.amount, orderInfo: session.orderInfo,
            requestId, responseCode: session.responseCode ?? "", transactionNo: session.transactionNo ?? "",
            bankCode: session.bankCode ?? "", payDate: session.payDate ?? "" };
    }
    failureRelease() {
        if (this.#state.status !== "failed")
            return null;
        const event = this.dispatchEvent();
        return event.requestId ? { orderId: event.requestId, email: event.email, amount: event.amount,
            txnRef: event.txnRef, cancelled: event.responseCode === "24" } : null;
    }
}
