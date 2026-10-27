import { getAwaitingPaymentOrder } from "../../storefront/infrastructure/persistence/order-record.store.js";
import crypto from "node:crypto";
import { Payment } from "../domain/payment-session.js";
import { createPaymentSession, getPaymentSessionByTxnRef } from "../vnpay.repository.js";
import { serializeVnpayParams, signVnpayParams } from "../vnpay-signature.js";
import type { PaymentLinkIssuer, CreatePaymentInput } from "../application/create-payment.js";
import type { RuntimeConfigService } from "../../../config/runtime-config.service.js";
const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatVnpDate(date: Date) {
  const vietnamDate = new Date(date.getTime() + VIETNAM_UTC_OFFSET_MS);
  return `${vietnamDate.getUTCFullYear()}${pad(vietnamDate.getUTCMonth() + 1)}${pad(vietnamDate.getUTCDate())}${pad(vietnamDate.getUTCHours())}${pad(vietnamDate.getUTCMinutes())}${pad(vietnamDate.getUTCSeconds())}`;
}


export class VnpayPaymentLinkIssuer implements PaymentLinkIssuer {
  constructor(private readonly config: () => ReturnType<RuntimeConfigService["getPaymentConfig"]>) {}
  async issue(input: CreatePaymentInput, details: Parameters<PaymentLinkIssuer["issue"]>[1]) {
    const { ipAddress, amount, orderId, createdAt, expiresAt } = details;
    const existing = async () => {
      if (!orderId) return null;
      const order = await getAwaitingPaymentOrder(orderId);
      if (!order?.paymentTxnRef || !order.paymentUrl) return null;
      const session = await getPaymentSessionByTxnRef(order.paymentTxnRef);
      if (!session || session.orderId !== orderId || session.email !== input.email?.trim().toLowerCase() || session.amount !== amount ||
        order.customerEmail !== session.email || order.totalAmount !== amount || order.status !== "awaiting_payment" ||
        order.lockedUntil <= new Date().toISOString()) throw new Error("Checkout payment correlation changed");
      return { paymentUrl: order.paymentUrl, txnRef: session.txnRef, amount: session.amount, orderInfo: session.orderInfo,
        expiresAt: session.expiresAt, timeoutMinutes: 5 };
    };
    const replay = await existing();
    if (replay) return replay;
    const paymentConfig = this.config();
    const txnRef = `NX${crypto.randomUUID().replace(/-/g, "")}`;
    const createDate = formatVnpDate(createdAt);
    const expireDate = formatVnpDate(expiresAt);
    const orderInfo = input.orderDescription?.trim() || `Payment for ${txnRef}`;
    const resolvedIpAddress = ipAddress || "127.0.0.1";
    const params: Record<string, string> = {
      vnp_Version: "2.1.0",
      vnp_Command: "pay",
      vnp_TmnCode: paymentConfig.vnpayTmnCode,
      vnp_Amount: String(amount * 100),
      vnp_CreateDate: createDate,
      vnp_ExpireDate: expireDate,
      vnp_CurrCode: "VND",
      vnp_IpAddr: resolvedIpAddress,
      vnp_Locale: input.locale || "vn",
      vnp_OrderInfo: orderInfo,
      vnp_OrderType: "other",
      vnp_ReturnUrl: paymentConfig.vnpayReturnUrl,
      vnp_TxnRef: txnRef
    };

    if (input.bankCode?.trim()) {
      params.vnp_BankCode = input.bankCode.trim();
    }

    const query = serializeVnpayParams(params);
    const secureHash = signVnpayParams(params, paymentConfig.vnpayHashSecret);
    const paymentUrl = `${paymentConfig.vnpayPaymentUrl}?${query}&vnp_SecureHash=${secureHash}`;

    try { await createPaymentSession(Payment.create({
      txnRef,
      orderId,
      email: input.email?.trim().toLowerCase(),
      orderInfo,
      amount,
      expiresAt: expiresAt.toISOString(),
      transactionDate: createDate, paymentUrl
    }, createdAt.getTime())); } catch (error) {
      // Includes ambiguous commit responses: only the durable winner is replayed.
      const winner = await existing();
      if (winner) return winner;
      throw error;
    }

    return { paymentUrl, txnRef, amount, orderInfo, expiresAt: expiresAt.toISOString(), timeoutMinutes: 5 };
  }
}
