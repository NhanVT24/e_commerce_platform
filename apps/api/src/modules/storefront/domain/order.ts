import { OrderActionError, InsufficientOrderStock } from "./order.error.js";
import type { CheckoutItem } from "./checkout.js";
import { OrderItems } from "./order-items.js";

export const REFUND_WINDOW_MS = 5 * 60 * 1000;
export const orderStatuses = ["pending", "done", "awaiting_payment", "paid", "cancelled", "expired", "payment_failed",
    "refund_pending", "refund_sent", "refund_rejected"] as const;
export type OrderStatus = typeof orderStatuses[number];
export type OrderItem = {
    productId: string; productName: string; quantity: number; unitPrice: number;
    originalUnitPrice?: number; lineTotal: number; version?: number;
};
export type CheckoutProductPrice = {
    productId: string; productName: string; unitPrice: number; originalUnitPrice?: number; stock?: number; version?: number;
};
export type OrderRefundOutcome = {
    status: "refund_pending" | "refund_sent" | "refund_rejected"; gatewayStatus: string; transactionNo?: string;
};
export type CheckoutTransition = {
    status: "paid" | "cancelled" | "expired" | "payment_failed";
    expectedCustomerEmail?: string; expectedPaymentTxnRef?: string; expectedAmount?: number;
    expiresBefore?: string; paymentConfirmedAt?: string;
};

/** One data contract for an order throughout its lifecycle. */
export interface OrderData {
    id: string;
    customerEmail: string;
    status: OrderStatus;
    totalAmount: number;
    items?: readonly OrderItem[];
    itemCount?: number;
    createdAt?: string;
    updatedAt?: string;
    lockedUntil?: string;
    checkoutBankCode?: string;
    checkoutLocale?: "vn" | "en";
    paymentTxnRef?: string;
    paymentUrl?: string;
    paymentConfirmedAt?: string;
    refundRequestId?: string;
    refundStatus?: string;
    refundTransactionNo?: string;
}

export class Order implements OrderData {
    readonly id: string;
    readonly customerEmail: string;
    readonly status: OrderStatus;
    readonly totalAmount: number;
    readonly items: readonly Readonly<OrderItem>[];
    readonly itemCount: number;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly lockedUntil?: string;
    readonly checkoutBankCode?: string;
    readonly checkoutLocale?: "vn" | "en";
    readonly paymentTxnRef?: string;
    readonly paymentUrl?: string;
    readonly paymentConfirmedAt?: string;
    readonly refundRequestId?: string;
    readonly refundStatus?: string;
    readonly refundTransactionNo?: string;

    /** Restore stored data. New orders must go through create() to calculate totals. */
    constructor(data: OrderData) {
        if (!data.id.trim() || !data.customerEmail.trim() || !orderStatuses.includes(data.status) ||
            !Number.isFinite(data.totalAmount) || data.totalAmount < 0) {
            throw new OrderActionError("INVALID_INPUT", "Invalid stored order data.");
        }
        this.id = data.id;
        this.customerEmail = data.customerEmail;
        this.status = data.status;
        this.totalAmount = data.totalAmount;
        this.items = Object.freeze((data.items ?? []).map(item => Object.freeze({ ...item })));
        this.itemCount = data.itemCount ?? this.items.length;
        this.createdAt = data.createdAt;
        this.updatedAt = data.updatedAt;
        this.lockedUntil = data.lockedUntil;
        this.checkoutBankCode = data.checkoutBankCode;
        this.checkoutLocale = data.checkoutLocale;
        this.paymentTxnRef = data.paymentTxnRef;
        this.paymentUrl = data.paymentUrl;
        this.paymentConfirmedAt = data.paymentConfirmedAt;
        this.refundRequestId = data.refundRequestId;
        this.refundStatus = data.refundStatus;
        this.refundTransactionNo = data.refundTransactionNo;
        Object.freeze(this);
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
    }): Order {
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
        const items = OrderItems.create(input.items).toArray().map(item => {
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
        return new Order({ id: input.id, customerEmail: input.customerEmail,
            status: "awaiting_payment", totalAmount, itemCount: items.length, items,
            lockedUntil: lockedUntil.toISOString(), createdAt: timestamp, updatedAt: timestamp,
            checkoutBankCode: input.bankCode, checkoutLocale: input.locale });
    }
    static createLegacy(input: Parameters<typeof Order.create>[0]): Order {
        const order = Order.create(input);
        return new Order({ ...order, status: "pending" });
    }
    isOwnedBy(email: string) { return this.customerEmail === email; }
    assertOwnedBy(email: string): void {
        if (!this.isOwnedBy(email))
            throw new OrderActionError("NOT_FOUND", "Order not found.");
    }
    assertAwaitingPayment(): void {
        if (this.status !== "awaiting_payment") {
            throw new OrderActionError("CONFLICT", "Checkout already has a payment session or has ended.");
        }
    }
    withPayment(txnRef: string, paymentUrl: string): Order {
        this.assertAwaitingPayment();
        if (!txnRef.trim() || !paymentUrl.trim() || (this.paymentTxnRef && this.paymentTxnRef !== txnRef)) {
            throw new OrderActionError("CONFLICT", "Checkout payment identity changed.");
        }
        return new Order({ ...this, paymentTxnRef: txnRef, paymentUrl });
    }
    checkoutTransition(input: CheckoutTransition, now: string, paymentSucceeded: boolean) {
        if (input.expectedCustomerEmail && !this.isOwnedBy(input.expectedCustomerEmail)) throw new Error("Order customer does not match");
        if ((input.expectedPaymentTxnRef && this.paymentTxnRef !== input.expectedPaymentTxnRef) ||
            (input.expectedAmount !== undefined && this.totalAmount !== input.expectedAmount)) {
            throw new Error("Payment correlation changed; reconciliation required");
        }
        if (input.expiresBefore && this.lockedUntil && this.lockedUntil > input.expiresBefore) {
            return { changed: false, loadItems: false, order: this };
        }
        if (this.status !== "awaiting_payment") {
            if (input.status === "paid" && !["paid", "refund_pending", "refund_sent", "refund_rejected"].includes(this.status)) {
                throw new Error("Payment received after inventory was released; reconciliation required");
            }
            return { changed: false, loadItems: true, order: this };
        }
        if (input.status !== "paid" && paymentSucceeded) {
            if (input.status === "expired") return { changed: false, loadItems: false, order: this };
            throw new OrderActionError("CONFLICT", "Payment confirmed; order synchronization is pending.");
        }
        return { changed: true, loadItems: true, order: new Order({ ...this, status: input.status, updatedAt: now,
            ...(input.status === "paid" ? { paymentConfirmedAt: input.paymentConfirmedAt || now } : {}) }) };
    }
    static checkoutInventoryDelta(quantity: number, status: CheckoutTransition["status"]) {
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new OrderActionError("INVALID_INPUT", "Invalid held order quantity.");
        return { stock: status === "paid" ? 0 : quantity, sold: status === "paid" ? quantity : 0 };
    }
    isCheckoutExpiredAt(now: string): boolean {
        return this.status === "awaiting_payment" && Boolean(this.lockedUntil && this.lockedUntil <= now);
    }
    assertCheckoutReplay(email: string, requested: readonly CheckoutItem[], saved: readonly CheckoutItem[], now: string): void {
        const sameItems = saved.length === requested.length && requested.every(item =>
            saved.some(line => line.productId === item.productId && line.quantity === item.quantity));
        if (!this.isOwnedBy(email) || !sameItems || this.status !== "awaiting_payment" ||
            Boolean(this.paymentUrl) !== Boolean(this.paymentTxnRef) ||
            !this.lockedUntil || this.isCheckoutExpiredAt(now)) {
            throw new OrderActionError("CONFLICT", "Checkout ID already exists, is being prepared, or has expired.");
        }
    }
    get isReleased() { return ["expired", "cancelled", "payment_failed"].includes(this.status); }
    get isAwaitingLegacyCompletion() { return this.status === "pending"; }
    get isLegacyCompleted() { return this.status === "done"; }
    static isTerminalRefundStatus(status: string) { return status === "refund_sent" || status === "refund_rejected"; }
    get isTerminalRefund() { return Order.isTerminalRefundStatus(this.status); }
    matchesPayment(input: {
        email: string;
        amount: number;
        txnRef: string;
    }) {
        return this.isOwnedBy(input.email) && this.totalAmount === input.amount && this.paymentTxnRef === input.txnRef;
    }
    isRefundEligibleAt(now: number) {
        const paidAt = this.paymentConfirmedAt ? Date.parse(this.paymentConfirmedAt) : NaN;
        return this.status === "paid" && Boolean(this.paymentTxnRef) && Number.isFinite(paidAt) && now < paidAt + REFUND_WINDOW_MS;
    }
    matchesRefundPayment(payment: {
        status: string;
        amount: number;
        orderId?: string;
    } | null) {
        return Boolean(payment && payment.status === "success" && payment.amount === this.totalAmount &&
            (!payment.orderId || payment.orderId === this.id));
    }
    claimRefund(requestId: string, now: number): Order {
        if (!requestId.trim())
            throw new OrderActionError("INVALID_INPUT", "Refund request identity is required.");
        if (this.refundRequestId || !this.isRefundEligibleAt(now)) {
            throw new OrderActionError("CONFLICT", "Refund is available for 5 minutes after confirmed payment.");
        }
        return new Order({ ...this, status: "refund_pending", refundStatus: "pending", refundRequestId: requestId });
    }
    refundResponse() {
        return { orderId: this.id, status: this.status, refundStatus: this.refundStatus };
    }
    recordRefundOutcome(outcome: OrderRefundOutcome): Order {
        if (this.status !== "refund_pending" || !this.refundRequestId ||
            !["refund_pending", "refund_sent", "refund_rejected"].includes(outcome.status)) {
            throw new OrderActionError("CONFLICT", "No pending refund request for this order.");
        }
        return new Order({ ...this, status: outcome.status, refundStatus: outcome.gatewayStatus,
            refundTransactionNo: outcome.transactionNo || this.refundTransactionNo });
    }
    canCompleteLegacyNotification(sentSystemNotification: boolean) {
        return this.status === "pending" && sentSystemNotification;
    }
    completeLegacyAfterNotification(sent: boolean): Order {
        if (!this.canCompleteLegacyNotification(sent)) throw new OrderActionError("CONFLICT", "Order is not ready for completion.");
        return new Order({ ...this, status: "done" });
    }
}
