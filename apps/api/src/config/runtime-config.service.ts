import { Injectable } from "@nestjs/common";
import { readPaymentConfig } from "./payment-config.js";

type RuntimeConfig = {
  vnpayTmnCode: string;
  vnpayHashSecret: string;
  vnpayPaymentUrl: string;
  vnpayTransactionUrl?: string;
  vnpayMerchantIp?: string;
  vnpayReturnUrl: string;
  vnpayIpnUrl: string;
};

@Injectable()
export class RuntimeConfigService {
  private cachedConfig: RuntimeConfig | null = null;
  private cachedAt = 0;
  private readonly ttlMs = 5 * 60 * 1000;

  getPaymentConfig() {
    if (this.cachedConfig && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cachedConfig;
    }

    const payment = readPaymentConfig();
    this.cachedConfig = {
      // In AWS these env vars are resolved from SSM-backed CDK dynamic references.
      vnpayTmnCode: payment.VNPAY_TMN_CODE,
      vnpayHashSecret: payment.VNPAY_HASH_SECRET,
      vnpayPaymentUrl: payment.VNPAY_PAYMENT_URL,
      vnpayTransactionUrl: payment.VNPAY_TRANSACTION_URL || undefined,
      vnpayMerchantIp: payment.VNPAY_MERCHANT_IP || undefined,
      vnpayReturnUrl: payment.VNPAY_RETURN_URL,
      vnpayIpnUrl: payment.VNPAY_IPN_URL
    };
    this.cachedAt = Date.now();

    return this.cachedConfig;
  }
}
