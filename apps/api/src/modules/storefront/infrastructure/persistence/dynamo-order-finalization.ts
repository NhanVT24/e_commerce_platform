import { createStorefrontOrder, getOrderById, readCheckoutPrices } from "./storefront.store.js";
import { toLegacyOrder } from "./order.mapper.js";
import { InsufficientOrderStock } from "../../application/ports/order-finalization-ports.js";
import type { OrderFinalizationRepository } from "../../application/ports/order-finalization-ports.js";

export class DynamoOrderFinalization implements OrderFinalizationRepository {
  loadPrices = readCheckoutPrices;
  async findExisting(id: string) {
    const record = await getOrderById(id);
    if (!record) return null;
    return toLegacyOrder(record);
  }
  async commit(entity: Parameters<OrderFinalizationRepository["commit"]>[0]) {
    const orderData = entity;
    try {
      const result = await createStorefrontOrder({ email: orderData.customerEmail, items: [...orderData.items], requestId: orderData.id }, entity);
      return { order: toLegacyOrder(result.order), stockChanges: result.stockChanges };
    }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Insufficient stock for ")) throw new InsufficientOrderStock(error.message);
      throw error;
    }
  }
}
