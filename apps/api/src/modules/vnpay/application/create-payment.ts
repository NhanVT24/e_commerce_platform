import { PaymentDraft } from "../domain/payment-draft.js";
export interface CreatePaymentInput {
  email?: string; items: Array<{ productId: string; quantity: number }>;
  orderDescription?: string; bankCode?: string; locale?: "vn" | "en";
}
export interface PaymentCreationOptions { skipStockValidation?: boolean; expiresAt?: string; amount?: number; orderId?: string; }
export interface PaymentProductReader {
  find(id: string): Promise<{ name?: string; price?: number; stock?: number } | null>;
}
export interface PaymentLinkIssuer {
  issue(input: CreatePaymentInput, details: { ipAddress: string; amount: number; orderId?: string; createdAt: Date; expiresAt: Date }):
    Promise<{ paymentUrl: string; txnRef: string; amount: number; orderInfo: string; expiresAt: string; timeoutMinutes: number }>;
}

export class CreatePayment {
  constructor(private readonly products: PaymentProductReader, private readonly issuer: PaymentLinkIssuer,
    private readonly now: () => number = Date.now) {}
  async execute(input: CreatePaymentInput, ipAddress: string, options: PaymentCreationOptions = {}) {
    const draft = new PaymentDraft(input.items);
    draft.assertValidItems();
    let total = 0;
    // Checkout supplies the committed sale-price snapshot. Do not recompute
    // it from today's product price or reject a product deleted after the hold.
    if (options.amount === undefined || !options.skipStockValidation) {
      for (const [id] of draft.quantities()) {
        const product = await this.products.find(id);
        total += draft.lineAmount(id, product, options.skipStockValidation);
      }
    }
    const amount = draft.amount(total, options.amount);
    const createdAt = new Date(this.now());
    const expiresAt = draft.expiresAt(createdAt, options.expiresAt);
    return this.issuer.issue(input, { ipAddress, amount, orderId: options.orderId, createdAt, expiresAt });
  }
}
