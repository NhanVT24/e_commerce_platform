import { getPaymentSessionByTxnRef,
  markPaymentEventEnqueued, updatePaymentSessionStatus } from "../vnpay.repository.js";
import type { PaymentSessions } from "../application/ports/payment-ports.js";
import type { Payment } from "../domain/payment-session.js";

const conditional = (error: unknown) => (error as { name?: string })?.name === "ConditionalCheckFailedException";
export class DynamoPaymentSessions implements PaymentSessions {
  find = getPaymentSessionByTxnRef;
  async confirm(payment: Payment) {
    const snapshot = payment.toSnapshot();
    if (snapshot.status !== "success" && snapshot.status !== "failed") throw new Error("Cannot persist a non-final payment confirmation");
    try {
      const session = await updatePaymentSessionStatus({ txnRef: snapshot.txnRef, status: snapshot.status,
        responseCode: snapshot.responseCode ?? "", transactionNo: snapshot.transactionNo ?? "",
        bankCode: snapshot.bankCode ?? "", payDate: snapshot.payDate ?? "", transactionStatus: snapshot.gatewayTransactionStatus });
      return { session, changed: true };
    } catch (error) {
      if (!conditional(error)) throw error;
      return { session: await this.find(snapshot.txnRef), changed: false };
    }
  }
  async markDispatched(txnRef: string) {
    try { await markPaymentEventEnqueued(txnRef); }
    catch (error) { if (!conditional(error)) throw error; }
  }
}
