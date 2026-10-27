import { OrderActionError, InsufficientOrderStock } from "./order.error.js";
import type { CheckoutItem } from "./checkout.js";
import { OrderItems } from "./order-items.js";
export const REFUND_WINDOW_MS = 5 * 60 * 1000;
export interface OrderRefundOutcome {
    status: "refund_pending" | "refund_sent" | "refund_rejected";
    gatewayStatus: string;
    transactionNo?: string;
}
export interface CheckoutTransition {
    status: "paid" | "cancelled" | "expired" | "payment_failed";
    expectedCustomerEmail?: string; expectedPaymentTxnRef?: string; expectedAmount?: number;
    expiresBefore?: string; paymentConfirmedAt?: string;
}
export interface CheckoutProductPrice {
    productId: string;
    productName: string;
    unitPrice: number;
    originalUnitPrice?: number;
    stock?: number;
    version?: number;
}
export interface OrderLineSnapshot extends CheckoutProductPrice {
    quantity: number;
    lineTotal: number;
}
export interface NewCheckoutOrder extends OrderSnapshot {
    status: "awaiting_payment";
    totalAmount: number;
    itemCount: number;
    lockedUntil: string;
    createdAt: string;
    updatedAt: string;
    items: readonly OrderLineSnapshot[];
    checkoutBankCode?: string;
    checkoutLocale?: "vn" | "en";
}
export interface LegacyOrderSnapshot extends OrderSnapshot {
    status: "pending" | "done";
    totalAmount: number;
    createdAt: string;
    updatedAt: string;
    items: Array<CheckoutItem & { productName: string; price: number; lineTotal: number; version?: number }>;
}
export interface OrderSnapshot {
    id: string;
    customerEmail: string;
    status: string;
    totalAmount?: number;
    paymentTxnRef?: string;
    paymentUrl?: string;
    lockedUntil?: string;
    paymentConfirmedAt?: string;
    refundRequestId?: string;
    refundStatus?: string;
    refundTransactionNo?: string;
    items?: readonly CheckoutItem[];
}
export class Order<T extends OrderSnapshot = OrderSnapshot> {
    readonly #state: Readonly<T>;
    /** Rehydrate existing data without reapplying creation rules. */
    constructor(snapshot: T) {
        this.#state = Object.freeze({ ...snapshot, ...(snapshot.items === undefined ? {} : {
            items: Object.freeze(snapshot.items.map(item => Object.freeze({ ...item })))
        }) });
    }
    toSnapshot(): T {
        return { ...this.#state, ...(this.#state.items === undefined ? {} : {
            items: this.#state.items.map(item => ({ ...item }))
        }) };
    }
    /** Prices must be supplied by trusted backend reads, never the client cart. */
    static create(input: {
        id: string;
        customerEmail: string;
        items: readonly CheckoutItem[];
        products: readonly CheckoutProductPrice[];
        now: number;
        holdSeconds: number;
        bankCode?: string;
        locale?: "vn" | "en";
    }): Order<NewCheckoutOrder> {
        if (!input.id.trim() || !input.customerEmail.trim()) {
            throw new OrderActionError("INVALID_INPUT", "Order identity and customer are required.");
        }
        const createdAt = new Date(input.now);
        const lockedUntil = new Date(input.now + input.holdSeconds * 1000);
        if (!Number.isFinite(input.now) || !Number.isFinite(createdAt.getTime()) ||
            !Number.isSafeInteger(input.holdSeconds) || input.holdSeconds < 1 || !Number.isFinite(lockedUntil.getTime())) {
            throw new OrderActionError("INVALID_INPUT", "Invalid checkout hold time.");
        }
        const prices = new Map<string, CheckoutProductPrice>();
        for (const product of input.products) {
            if (prices.has(product.productId)) {
                throw new OrderActionError("INVALID_INPUT", "Duplicate checkout product price.");
            }
            prices.set(product.productId, product);
        }
        let totalAmount = 0;
        const items = OrderItems.create(input.items).toSnapshot().map(item => {
            const product = prices.get(item.productId);
            if (!product) throw new OrderActionError("INVALID_INPUT", `Missing price for product ${item.productId}.`);
            if (product.stock !== undefined && (!Number.isSafeInteger(product.stock) || product.stock < item.quantity)) {
                throw new InsufficientOrderStock(`Insufficient stock for ${product.productName}`);
            }
            if (!Number.isFinite(product.unitPrice) || product.unitPrice <= 0 ||
                (product.originalUnitPrice !== undefined && (!Number.isFinite(product.originalUnitPrice) || product.originalUnitPrice <= 0))) {
                throw new OrderActionError("INVALID_INPUT", "Invalid checkout product price.");
            }
            const lineTotal = product.unitPrice * item.quantity;
            totalAmount += lineTotal;
            if (!Number.isFinite(totalAmount) || totalAmount > Number.MAX_SAFE_INTEGER) {
                throw new OrderActionError("INVALID_INPUT", "Order total exceeds the supported amount.");
            }
            return { productId: item.productId, productName: product.productName, unitPrice: product.unitPrice,
                originalUnitPrice: product.originalUnitPrice, ...(product.version === undefined ? {} : { version: product.version }),
                quantity: item.quantity, lineTotal };
        });
        const timestamp = createdAt.toISOString();
        return new Order<NewCheckoutOrder>({ id: input.id, customerEmail: input.customerEmail,
            status: "awaiting_payment", totalAmount, itemCount: items.length, items,
            lockedUntil: lockedUntil.toISOString(), createdAt: timestamp, updatedAt: timestamp,
            checkoutBankCode: input.bankCode, checkoutLocale: input.locale });
    }
    static createLegacy(input: Parameters<typeof Order.create>[0]): Order<LegacyOrderSnapshot> {
        const snapshot = Order.create(input).toSnapshot();
        return new Order({ id: snapshot.id, customerEmail: snapshot.customerEmail, status: "pending",
            totalAmount: snapshot.totalAmount, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt,
            items: snapshot.items.map(line => ({ productId: line.productId, productName: line.productName,
                quantity: line.quantity, price: line.unitPrice, lineTotal: line.lineTotal, version: line.version })) });
    }
    isOwnedBy(email: string) { return this.#state.customerEmail === email; }
    assertOwnedBy(email: string): void {
        if (!this.isOwnedBy(email))
            throw new OrderActionError("NOT_FOUND", "Order not found.");
    }
    assertAwaitingPayment(): void {
        if (this.#state.status !== "awaiting_payment") {
            throw new OrderActionError("CONFLICT", "Checkout already has a payment session or has ended.");
        }
    }
    withPayment(txnRef: string, paymentUrl: string): Order<T & { paymentTxnRef: string; paymentUrl: string }> {
        this.assertAwaitingPayment();
        if (!txnRef.trim() || !paymentUrl.trim() || (this.#state.paymentTxnRef && this.#state.paymentTxnRef !== txnRef)) {
            throw new OrderActionError("CONFLICT", "Checkout payment identity changed.");
        }
        return new Order({ ...this.#state, paymentTxnRef: txnRef, paymentUrl });
    }
    checkoutTransition(input: CheckoutTransition, now: string, paymentSucceeded: boolean) {
        if (input.expectedCustomerEmail && !this.isOwnedBy(input.expectedCustomerEmail)) throw new Error("Order customer does not match");
        if ((input.expectedPaymentTxnRef && this.#state.paymentTxnRef !== input.expectedPaymentTxnRef) ||
            (input.expectedAmount !== undefined && this.#state.totalAmount !== input.expectedAmount)) {
            throw new Error("Payment correlation changed; reconciliation required");
        }
        if (input.expiresBefore && this.#state.lockedUntil && this.#state.lockedUntil > input.expiresBefore) {
            return { changed: false, loadItems: false, order: this };
        }
        if (this.#state.status !== "awaiting_payment") {
            if (input.status === "paid" && !["paid", "refund_pending", "refund_sent", "refund_rejected"].includes(this.#state.status)) {
                throw new Error("Payment received after inventory was released; reconciliation required");
            }
            return { changed: false, loadItems: true, order: this };
        }
        if (input.status !== "paid" && paymentSucceeded) {
            if (input.status === "expired") return { changed: false, loadItems: false, order: this };
            throw new OrderActionError("CONFLICT", "Payment confirmed; order synchronization is pending.");
        }
        return { changed: true, loadItems: true, order: new Order({ ...this.#state, status: input.status, updatedAt: now,
            ...(input.status === "paid" ? { paymentConfirmedAt: input.paymentConfirmedAt || now } : {}) }) };
    }
    static checkoutInventoryDelta(quantity: number, status: CheckoutTransition["status"]) {
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new OrderActionError("INVALID_INPUT", "Invalid held order quantity.");
        return { stock: status === "paid" ? 0 : quantity, sold: status === "paid" ? quantity : 0 };
    }
    isCheckoutExpiredAt(now: string): boolean {
        return this.#state.status === "awaiting_payment" && Boolean(this.#state.lockedUntil && this.#state.lockedUntil <= now);
    }
    assertCheckoutReplay(email: string, requested: readonly CheckoutItem[], saved: readonly CheckoutItem[], now: string): void {
        const sameItems = saved.length === requested.length && requested.every(item =>
            saved.some(line => line.productId === item.productId && line.quantity === item.quantity));
        if (!this.isOwnedBy(email) || !sameItems || this.#state.status !== "awaiting_payment" ||
            Boolean(this.#state.paymentUrl) !== Boolean(this.#state.paymentTxnRef) ||
            !this.#state.lockedUntil || this.isCheckoutExpiredAt(now)) {
            throw new OrderActionError("CONFLICT", "Checkout ID already exists, is being prepared, or has expired.");
        }
    }
    get isReleased() { return ["expired", "cancelled", "payment_failed"].includes(this.#state.status); }
    get isAwaitingLegacyCompletion() { return this.#state.status === "pending"; }
    get isLegacyCompleted() { return this.#state.status === "done"; }
    static isTerminalRefundStatus(status: string) { return status === "refund_sent" || status === "refund_rejected"; }
    get isTerminalRefund() { return Order.isTerminalRefundStatus(this.#state.status); }
    matchesPayment(input: {
        email: string;
        amount: number;
        txnRef: string;
    }) {
        return this.isOwnedBy(input.email) && this.#state.totalAmount === input.amount && this.#state.paymentTxnRef === input.txnRef;
    }
    isRefundEligibleAt(now: number) {
        const paidAt = this.#state.paymentConfirmedAt ? Date.parse(this.#state.paymentConfirmedAt) : NaN;
        return this.#state.status === "paid" && Boolean(this.#state.paymentTxnRef) && Number.isFinite(paidAt) && now < paidAt + REFUND_WINDOW_MS;
    }
    matchesRefundPayment(payment: {
        status: string;
        amount: number;
        orderId?: string;
    } | null) {
        return Boolean(payment && payment.status === "success" && payment.amount === this.#state.totalAmount &&
            (!payment.orderId || payment.orderId === this.#state.id));
    }
    claimRefund(requestId: string, now: number): Order<T & {
        status: "refund_pending";
        refundStatus: string;
        refundRequestId: string;
    }> {
        if (!requestId.trim())
            throw new OrderActionError("INVALID_INPUT", "Refund request identity is required.");
        if (this.#state.refundRequestId || !this.isRefundEligibleAt(now)) {
            throw new OrderActionError("CONFLICT", "Refund is available for 5 minutes after confirmed payment.");
        }
        return new Order({ ...this.#state, status: "refund_pending", refundStatus: "pending", refundRequestId: requestId });
    }
    refundResponse() {
        return { orderId: this.#state.id, status: this.#state.status, refundStatus: this.#state.refundStatus };
    }
    recordRefundOutcome(outcome: OrderRefundOutcome): Order<T & { status: OrderRefundOutcome["status"]; refundStatus: string }> {
        if (this.#state.status !== "refund_pending" || !this.#state.refundRequestId ||
            !["refund_pending", "refund_sent", "refund_rejected"].includes(outcome.status)) {
            throw new OrderActionError("CONFLICT", "No pending refund request for this order.");
        }
        return new Order({ ...this.#state, status: outcome.status, refundStatus: outcome.gatewayStatus,
            refundTransactionNo: outcome.transactionNo || this.#state.refundTransactionNo });
    }
    canCompleteLegacyNotification(sentSystemNotification: boolean) {
        return this.#state.status === "pending" && sentSystemNotification;
    }
    completeLegacyAfterNotification(sent: boolean): Order<T & { status: "done" }> {
        if (!this.canCompleteLegacyNotification(sent)) throw new OrderActionError("CONFLICT", "Order is not ready for completion.");
        return new Order({ ...this.#state, status: "done" });
    }
}
