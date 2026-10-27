import type { FailedPaymentOrders } from "../application/ports/payment-ports.js";
import { DynamoCheckoutOrders } from "../../storefront/infrastructure/persistence/dynamo-checkout-orders.js";
import { Order } from "../../storefront/domain/order.js";

export class DynamoFailedPaymentOrders implements FailedPaymentOrders {
  private readonly orders = new DynamoCheckoutOrders();
  async release(input: Parameters<FailedPaymentOrders["release"]>[0]) {
    const order = await this.orders.findById(input.orderId);
    if (!order || order.customerEmail !== input.email || order.totalAmount !== input.amount ||
      order.paymentTxnRef !== input.txnRef) throw new Error("Failed payment does not match held order; reconciliation required");
    await this.orders.transition({ order: new Order(order), expectedCustomerEmail: input.email,
      expectedAmount: input.amount, expectedPaymentTxnRef: input.txnRef,
      status: input.cancelled ? "cancelled" : "payment_failed" });
  }
}
