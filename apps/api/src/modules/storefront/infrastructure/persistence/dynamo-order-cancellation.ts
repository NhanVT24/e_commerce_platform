import { transitionAwaitingPaymentOrder } from "./storefront.store.js";
import { getAwaitingPaymentOrder } from "./order-record.store.js";
import { toCheckoutOrder } from "./order.mapper.js";
import { listOrderItems } from "./order-record.store.js";
import type { OrderCancellationRepository } from "../../application/ports/order-lifecycle-ports.js";
import { OrderActionError } from "../../application/order-action.error.js";

export class DynamoOrderCancellation implements OrderCancellationRepository {
  async findById(id: string) {
    const record = await getAwaitingPaymentOrder(id);
    return record ? toCheckoutOrder(record, await listOrderItems(id)) : null;
  }

  async cancel(entity: Parameters<OrderCancellationRepository["cancel"]>[0]) {
    const { id: orderId, customerEmail } = entity;
    try {
      const result = await transitionAwaitingPaymentOrder({ orderId, expectedCustomerEmail: customerEmail, status: "cancelled" });
      return { order: toCheckoutOrder(result.order, result.items), changed: result.changed };
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      const competingTransition = failure?.name === "TransactionCanceledException" &&
        failure.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed";
      const accessRace = error instanceof Error &&
        (error.message === "Order not found" || error.message === "Order customer does not match");
      if (!competingTransition && !accessRace) throw error;
      const current = await this.findById(orderId);
      if (!current || current.customerEmail !== customerEmail) throw new OrderActionError("NOT_FOUND", "Order not found.");
      // Only the order condition indicates a competing state transition. A missing
      // inventory item, throttling or transaction contention must remain an error.
      if (competingTransition) {
        if (current.status !== "awaiting_payment") return { order: current, changed: false };
        throw new OrderActionError("CONFLICT", "Order changed. Please refresh and try again.");
      }
      throw error;
    }
  }
}
