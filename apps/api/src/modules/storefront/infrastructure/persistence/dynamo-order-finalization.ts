import { createStorefrontOrder, getOrderById, readCheckoutPrices } from "./storefront.store.js";
import { Order } from "../../domain/order.js";
import { InsufficientOrderStock } from "../../application/ports/order-finalization-ports.js";
import type { OrderFinalizationRepository } from "../../application/ports/order-finalization-ports.js";

export class DynamoOrderFinalization implements OrderFinalizationRepository {
  loadPrices = readCheckoutPrices;
  async findExisting(id: string) {
    const record = await getOrderById(id);
    if (!record) return null;
    return new Order({ id: record.id, customerEmail: record.customerEmail, status: record.status,
      totalAmount: record.totalAmount, createdAt: record.createdAt, updatedAt: record.updatedAt,
      items: record.items.map(line => ({ ...line })) });
  }
  async commit(entity: Parameters<OrderFinalizationRepository["commit"]>[0]) {
    const snapshot = entity.toSnapshot();
    try { return await createStorefrontOrder({ email: snapshot.customerEmail, items: snapshot.items, requestId: snapshot.id }, entity); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Insufficient stock for ")) throw new InsufficientOrderStock(error.message);
      throw error;
    }
  }
}
