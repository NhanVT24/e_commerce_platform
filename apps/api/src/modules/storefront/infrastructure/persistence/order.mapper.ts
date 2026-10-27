import { Order } from "../../domain/order.js";
import type { StorefrontAwaitingPaymentOrderRecord, StorefrontOrderItemRecord, StorefrontOrderRecord } from "./storefront.store.js";

export function toCheckoutOrder(record: StorefrontAwaitingPaymentOrderRecord, items: readonly StorefrontOrderItemRecord[] = []): Order {
  return new Order({
    id: record.PK.replace(/^ORDER#/, ""), customerEmail: record.customerEmail,
    status: record.status, totalAmount: record.totalAmount, itemCount: record.itemCount,
    items: items.map(item => ({ productId: item.productId, productName: item.productName,
      quantity: item.quantity, unitPrice: item.unitPrice, originalUnitPrice: item.originalUnitPrice, lineTotal: item.lineTotal })),
    createdAt: record.createdAt, updatedAt: record.updatedAt, lockedUntil: record.lockedUntil,
    checkoutBankCode: record.checkoutBankCode, checkoutLocale: record.checkoutLocale,
    paymentTxnRef: record.paymentTxnRef, paymentUrl: record.paymentUrl, paymentConfirmedAt: record.paymentConfirmedAt,
    refundRequestId: record.refundRequestId, refundStatus: record.refundStatus, refundTransactionNo: record.refundTransactionNo
  });
}

export function toLegacyOrder(record: StorefrontOrderRecord): Order {
  return new Order({ id: record.id, customerEmail: record.customerEmail, status: record.status,
    totalAmount: record.totalAmount, createdAt: record.createdAt, updatedAt: record.updatedAt,
    items: record.items.map(item => ({ productId: item.productId, productName: item.productName,
      quantity: item.quantity, unitPrice: item.price, originalUnitPrice: item.originalUnitPrice, lineTotal: item.lineTotal })) });
}
