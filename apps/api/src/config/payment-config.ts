import { z } from "zod";
import "./load-env.js";

export const paymentConfigSchema = z.object({
  VNPAY_TMN_CODE: z.string().min(1),
  VNPAY_HASH_SECRET: z.string().min(1),
  VNPAY_PAYMENT_URL: z.string().url().default("https://sandbox.vnpayment.vn/paymentv2/vpcpay.html"),
  VNPAY_TRANSACTION_URL: z.union([z.literal(""), z.string().url()]).optional(),
  VNPAY_MERCHANT_IP: z.string().optional(),
  VNPAY_RETURN_URL: z.string().url(),
  VNPAY_IPN_URL: z.string().url()
});

// Validate provider credentials only in runtimes that actually perform payments.
export function readPaymentConfig(input: NodeJS.ProcessEnv = process.env) {
  return paymentConfigSchema.parse(input);
}
