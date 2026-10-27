import { getPaymentSessionByTxnRef } from "../../../vnpay/vnpay.repository.js";
import { inventoryTransaction } from "../../../shopping/infrastructure/persistence/inventory-transaction.js";
import { readProductRecord } from "../../../shopping/infrastructure/persistence/product-record.store.js";
import { normalizeCheckoutItems } from "../../application/checkout-items.js";
import { OrderActionError } from "../../application/order-action.error.js";
import { getAwaitingPaymentOrder, listOrderItems } from "./order-record.store.js";
import type { OrderLifecycleStatus } from "../../domain/order-refund.js";
import { Order, type CheckoutProductPrice } from "../../domain/order.js";
import { toProduct } from "../../../shopping/infrastructure/persistence/product.mapper.js";
export { getAwaitingPaymentOrder, listOrderItems } from "./order-record.store.js";
import crypto from "node:crypto";
import { GetItemCommand, PutItemCommand, ScanCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../../../config/database-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { listShoppingItems } from "../../../shopping/shopping.repository.js";
import { resolveSalePrice } from "../../../sales/sale-pricing.js";
import { listActiveSaleCampaigns } from "../../../sales/sales.repository.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

type OrderLine = {
  productId: string;
  productName: string;
  price: number;
  originalUnitPrice?: number;
  quantity: number;
  lineTotal: number;
};

type CreateOrderPayload = {
  requestId?: string;
  email: string;
  items: Array<{ productId: string; quantity: number }>;
};

type AuditSourceMetadata = {
  auditActorType: "USER" | "ADMIN" | "SERVICE" | "SYSTEM";
  auditActorId: string;
  auditActorRole: string;
  auditSource: string;
  auditReason: string;
  auditRequestId?: string;
};

export type AwaitingPaymentOrderStatus = OrderLifecycleStatus;

export type StorefrontAwaitingPaymentOrderRecord = {
  PK: string;
  SK: "ORDER";
  entityType: "ORDER";
  customerEmail: string;
  status: AwaitingPaymentOrderStatus;
  totalAmount: number;
  itemCount: number;
  lockedUntil: string;
  createdAt: string;
  updatedAt: string;
  paymentUrl?: string;
  checkoutBankCode?: string;
  checkoutLocale?: "vn" | "en";
  paymentTxnRef?: string;
  paymentConfirmedAt?: string;
  refundRequestId?: string;
  refundStatus?: string;
  refundTransactionNo?: string;
  refundUpdatedAt?: string;
  auditActorType?: string;
  auditActorId?: string;
  auditActorRole?: string;
  auditSource?: string;
  auditReason?: string;
  auditRequestId?: string;
};

export type StorefrontOrderItemRecord = {
  PK: string;
  SK: string;
  entityType: "ORDER_ITEM";
  orderId: string;
  productId: string;
  customerEmail: string;
  productName: string;
  unitPrice: number;
  originalUnitPrice?: number;
  quantity: number;
  lineTotal: number;
  createdAt: string;
  updatedAt: string;
};

export type StorefrontOrderQueuePayload = {
  type: "storefront.order.requested";
  requestId: string;
  email: string;
  items: Array<{ productId: string; quantity: number }>;
  createdAt: string;
};

export type InventoryStockChange = {
  productId: string;
  productName: string;
  sku?: string;
  previousStock: number;
  stock: number;
  previousStatus: string;
  status: string;
};

export type StorefrontOrderRecord = {
  PK: string;
  SK: string;
  entityType: "ORDER";
  id: string;
  customerEmail: string;
  status: "pending" | "done";
  items: OrderLine[];
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
};

export type StorefrontOrderCreationResult = {
  order: StorefrontOrderRecord;
  stockChanges: InventoryStockChange[];
};

function toDynamoItem(item: Record<string, unknown>) {
  return marshall(item, { removeUndefinedValues: true });
}

function fromDynamoItem(item?: Record<string, AttributeValue>) {
  return item ? (unmarshall(item) as Record<string, any>) : null;
}

function serviceAuditMetadata(input: {
  actorId: string;
  source: string;
  reason: string;
  requestId?: string;
}): AuditSourceMetadata {
  return {
    auditActorType: "SERVICE",
    auditActorId: input.actorId,
    auditActorRole: "SYSTEM",
    auditSource: input.source,
    auditReason: input.reason,
    auditRequestId: input.requestId
  };
}

function buildOrderMetaKey(orderId: string) {
  return { PK: `ORDER#${orderId}`, SK: "ORDER" as const };
}

function orderIdFromPk(pk: string) {
  return pk.startsWith("ORDER#") ? pk.slice("ORDER#".length) : "";
}

function buildOrderItemKey(orderId: string, productId: string) {
  return { PK: `ORDER#${orderId}`, SK: `ORDER_ITEM#${productId}` };
}

export async function createStorefrontOrder(input: CreateOrderPayload, prepared?: Order): Promise<StorefrontOrderCreationResult> {
  const normalizedItems = normalizeCheckoutItems(input.items);
  const now = new Date().toISOString();
  const orderId = input.requestId || crypto.randomUUID();
  if (input.requestId) {
    const existing = await getOrderById(orderId);
    if (existing) {
      assertSameOrder(existing, input.email, normalizedItems);
      return { order: existing, stockChanges: [] };
    }
  }
  const productSnapshots = new Map<string, Record<string, any>>();
  const entity = prepared ?? Order.createLegacy({ id: orderId, customerEmail: input.email, items: normalizedItems,
    products: await readCheckoutPrices(normalizedItems), now: Date.now(), holdSeconds: 300 });
  const orderData = entity;

  for (const item of normalizedItems) {
    const product = await readProductRecord(item.productId);
    if (!product) {
      throw new Error(`Product ${item.productId} not found`);
    }

    const availableStock = Number(product.stock ?? 0) - Number(product.reservedStock ?? 0);
    if (availableStock < item.quantity) {
      throw new Error(`Insufficient stock for ${product.name}`);
    }

    if (Number(product.version ?? 0) !== orderData.items.find(line => line.productId === item.productId)?.version) {
      throw new OrderActionError("CONFLICT", "Product inventory changed during checkout");
    }
    productSnapshots.set(item.productId, product);
  }
  if (orderData.status !== "pending") throw new OrderActionError("INVALID_INPUT", "Expected a new queued order.");
  const orderRecord: StorefrontOrderRecord = {
    PK: `ORDER#${orderId}`,
    SK: "DETAIL",
    entityType: "ORDER",
    id: orderId,
    customerEmail: input.email,
    status: orderData.status,
    items: orderData.items.map(line => ({ productId: line.productId, productName: line.productName, quantity: line.quantity, price: line.unitPrice, lineTotal: line.lineTotal })),
    totalAmount: orderData.totalAmount,
    createdAt: orderData.createdAt,
    updatedAt: orderData.updatedAt
  };
  try {
    await rawDb.send(new TransactWriteItemsCommand({
      TransactItems: [
        ...normalizedItems.flatMap(item => inventoryTransaction(productSnapshots.get(item.productId)!, { stock: -item.quantity, sold: item.quantity }, now)),
        {
          Put: {
            TableName,
            Item: toDynamoItem(orderRecord),
            ConditionExpression: "attribute_not_exists(PK)"
          }
        }
      ]
    }));
  } catch (error) {
    const candidate = error as { name?: string };
    if (candidate?.name === "TransactionCanceledException") {
      if (input.requestId) {
        const existing = await getOrderById(orderId);
        if (existing) { assertSameOrder(existing, input.email, normalizedItems); return { order: existing, stockChanges: [] }; }
      }
      for (const item of normalizedItems) {
        const latestProduct = await readProductRecord(item.productId);
        if (!latestProduct) {
          throw new Error(`Product ${item.productId} not found`);
        }

        if (Number(latestProduct.stock ?? 0) < item.quantity) {
          throw new Error(`Insufficient stock for ${latestProduct.name}`);
        }
      }

      const conflictError = new Error("Product inventory changed during checkout");
      conflictError.name = "ConditionalCheckFailedException";
      throw conflictError;
    }

    throw error;
  }

  const stockChanges: InventoryStockChange[] = normalizedItems.map(item => {
    const product = productSnapshots.get(item.productId)!;
    const current = toProduct(product);
    const changed = current.changeInventory({ stock: -item.quantity, sold: item.quantity }, Number(product.reservedStock ?? 0));
    return { productId: current.id, productName: current.name, sku: current.sku,
      previousStock: current.stock, stock: changed.stock, previousStatus: current.status, status: changed.stockStatus };
  });

  return {
    order: orderRecord,
    stockChanges
  };
}

export async function getOrderById(id: string) {
  const result = await rawDb.send(new GetItemCommand({
    TableName,
    ConsistentRead: true,
    Key: toDynamoItem({
      PK: `ORDER#${id}`,
      SK: "DETAIL"
    })
  }));

  return fromDynamoItem(result.Item) as StorefrontOrderRecord | null;
}

/** Read-only prices; application passes these into Order.create. */
export async function readCheckoutPrices(items: readonly { productId: string; quantity: number }[]): Promise<CheckoutProductPrice[]> {
  const saleCampaigns = await listActiveSaleCampaigns();
  const prices: CheckoutProductPrice[] = [];
  for (const item of items) {
    const product = await readProductRecord(item.productId);
    if (!product) throw new Error('Product ' + item.productId + ' not found');
    const price = resolveSalePrice(product, saleCampaigns);
    prices.push({ productId: item.productId, productName: String(product.name ?? ''),
      unitPrice: price.price, originalUnitPrice: price.originalPrice,
      stock: Number(product.stock ?? 0) - Number(product.reservedStock ?? 0), version: Number(product.version ?? 0) });
  }
  return prices;
}

/** Compatibility entry point for maintenance/tests; construction uses the entity. */
export async function createAwaitingPaymentOrder(input: {
  orderId: string; email: string; items: Array<{ productId: string; quantity: number }>;
  holdSeconds: number; bankCode?: string; locale?: 'vn' | 'en';
}) {
  const items = normalizeCheckoutItems(input.items);
  return persistAwaitingPaymentOrder(Order.create({ id: input.orderId, customerEmail: input.email,
    items, products: await readCheckoutPrices(items), now: Date.now(), holdSeconds: input.holdSeconds,
    bankCode: input.bankCode, locale: input.locale }));
}

export async function persistAwaitingPaymentOrder(entity: Order) {
  const orderData = entity;
  if (orderData.status !== "awaiting_payment") throw new OrderActionError("INVALID_INPUT", "Expected a new checkout order.");
  const now = orderData.createdAt;
  const normalizedItems = orderData.items;
  const products = new Map<string, Record<string, any>>();
  for (const line of orderData.items) {
    const product = await readProductRecord(line.productId);
    if (!product || Number(product.version ?? 0) !== line.version) {
      throw new OrderActionError('CONFLICT', 'Inventory changed. Please refresh and retry checkout.');
    }
    products.set(line.productId, product);
  }
  const lines: StorefrontOrderItemRecord[] = orderData.items.map(({ version: _version, ...line }) => ({
    ...buildOrderItemKey(orderData.id, line.productId), entityType: "ORDER_ITEM",
    orderId: orderData.id, customerEmail: orderData.customerEmail, ...line,
    createdAt: orderData.createdAt, updatedAt: orderData.updatedAt
  }));
  const order: StorefrontAwaitingPaymentOrderRecord = {
    ...buildOrderMetaKey(orderData.id),
    entityType: "ORDER",
    customerEmail: orderData.customerEmail,
    status: orderData.status,
    totalAmount: orderData.totalAmount,
    itemCount: orderData.itemCount,
    lockedUntil: orderData.lockedUntil,
    checkoutBankCode: orderData.checkoutBankCode, checkoutLocale: orderData.checkoutLocale,
    createdAt: now,
    updatedAt: now,
    ...serviceAuditMetadata({
      actorId: "service:checkout-api",
      source: "CHECKOUT_API",
      reason: "order_created",
      requestId: orderData.id
    })
  };

  await rawDb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Put: {
          TableName,
          Item: toDynamoItem(order),
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
        }
      },
      ...normalizedItems.flatMap((item) => {
        const product = products.get(item.productId)!;
        return [...inventoryTransaction(product, { stock: -item.quantity, sold: 0 }, now), {
          Put: { TableName, Item: toDynamoItem(lines.find(line => line.productId === item.productId)!),
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" }
        }];
      })
    ]
  }));

  return { order, items: lines };
}

export async function attachPaymentTxnRef(orderId: string, txnRef: string, email?: string, paymentUrl?: string) {
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: toDynamoItem(buildOrderMetaKey(orderId)),
    ConditionExpression: "#status = :awaiting AND (attribute_not_exists(paymentTxnRef) OR paymentTxnRef = :txnRef)" + (email ? " AND customerEmail = :email" : ""),
    UpdateExpression: "SET paymentTxnRef = :txnRef" + (paymentUrl ? ", paymentUrl = :paymentUrl" : ""),
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: toDynamoItem({ ":awaiting": "awaiting_payment", ":txnRef": txnRef, ":email": email, ":paymentUrl": paymentUrl })
  }));
}

export async function transitionAwaitingPaymentOrder(input: {
  orderId: string;
  expectedCustomerEmail?: string;
  expectedPaymentTxnRef?: string;
  expectedAmount?: number;
  expiresBefore?: string;
  status: Extract<AwaitingPaymentOrderStatus, "paid" | "cancelled" | "expired" | "payment_failed">;
  paymentConfirmedAt?: string;
}) {
  const order = await getAwaitingPaymentOrder(input.orderId);
  if (!order) throw new Error("Order not found");
  const now = new Date().toISOString();
  const paymentSucceeded = input.status !== 'paid' && order.status === 'awaiting_payment' && order.paymentTxnRef
    ? (await getPaymentSessionByTxnRef(order.paymentTxnRef))?.status === 'success' : false;
  const decision = new Order({ ...order, id: input.orderId }).checkoutTransition(input, now, paymentSucceeded);
  if (!decision.changed) return { order, items: decision.loadItems ? await listOrderItems(input.orderId) : [], changed: false };
  const next = decision.order;
  const items = await listOrderItems(input.orderId);
  if (items.length === 0) throw new Error("Order has no held items");
  const isPaymentSuccess = input.status === "paid";
  const inventoryWrites = (await Promise.all(items.map(async item => {
    const product = await readProductRecord(item.productId);
    if (!product) throw new Error(`Product ${item.productId} not found`);
    return inventoryTransaction(product, Order.checkoutInventoryDelta(item.quantity, input.status), now);
  }))).flat();
  const paymentConfirmedAt = next.paymentConfirmedAt;
  const auditMetadata = input.status === "expired"
    ? serviceAuditMetadata({ actorId: "lambda:release-expired-orders", source: "ORDER_EXPIRY_WORKER", reason: "payment_timeout", requestId: input.orderId })
    : input.status === "paid"
      ? serviceAuditMetadata({ actorId: "lambda:vnpay-ipn", source: "VNPAY_IPN", reason: "payment_success", requestId: input.orderId })
      : serviceAuditMetadata({ actorId: "service:payment-workflow", source: "PAYMENT_WORKFLOW", reason: input.status, requestId: input.orderId });

  await rawDb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Update: {
          TableName,
          Key: toDynamoItem(buildOrderMetaKey(input.orderId)),
          ConditionExpression: "#status = :awaitingPayment" + (input.expectedCustomerEmail ? " AND customerEmail = :expectedCustomerEmail" : "") +
            (input.expectedPaymentTxnRef ? " AND paymentTxnRef = :expectedTxnRef" : "") +
            (input.expectedAmount !== undefined ? " AND totalAmount = :expectedAmount" : "") +
            (input.expiresBefore ? " AND lockedUntil <= :expiresBefore" : ""),
          UpdateExpression: isPaymentSuccess
            ? "SET #status = :status, updatedAt = :updatedAt, finalizedAt = :updatedAt, paymentConfirmedAt = :paymentConfirmedAt, auditActorType = :auditActorType, auditActorId = :auditActorId, auditActorRole = :auditActorRole, auditSource = :auditSource, auditReason = :auditReason, auditRequestId = :auditRequestId"
            : "SET #status = :status, updatedAt = :updatedAt, finalizedAt = :updatedAt, auditActorType = :auditActorType, auditActorId = :auditActorId, auditActorRole = :auditActorRole, auditSource = :auditSource, auditReason = :auditReason, auditRequestId = :auditRequestId",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: toDynamoItem({ ":awaitingPayment": "awaiting_payment", ":expectedCustomerEmail": input.expectedCustomerEmail, ":status": input.status, ":updatedAt": now,
            ":expectedTxnRef": input.expectedPaymentTxnRef, ":expectedAmount": input.expectedAmount, ":expiresBefore": input.expiresBefore,
            ":paymentConfirmedAt": isPaymentSuccess ? paymentConfirmedAt : undefined,
            ":auditActorType": auditMetadata.auditActorType,
            ":auditActorId": auditMetadata.auditActorId,
            ":auditActorRole": auditMetadata.auditActorRole,
            ":auditSource": auditMetadata.auditSource,
            ":auditReason": auditMetadata.auditReason,
            ":auditRequestId": auditMetadata.auditRequestId })
        }
      },
      ...inventoryWrites,
      ...(input.status !== "paid" && order.paymentTxnRef ? [{ ConditionCheck: {
        TableName, Key: toDynamoItem({ PK: 'PAYMENT#' + order.paymentTxnRef, SK: "DETAIL" }),
        ConditionExpression: "attribute_not_exists(PK) OR #paymentStatus <> :success",
        ExpressionAttributeNames: { "#paymentStatus": "status" },
        ExpressionAttributeValues: toDynamoItem({ ":success": "success" })
      } }] : [])
    ]
  }));

  return { order: { ...order, status: next.status, updatedAt: now, ...(isPaymentSuccess ? { paymentConfirmedAt } : {}) }, items, changed: true };
}

export async function listOrdersByCustomer(email: string) {
  const orders: Record<string, any>[] = [];
  let cursor: Record<string, AttributeValue> | undefined;
  do {
    const result = await rawDb.send(new ScanCommand({
      TableName, ExclusiveStartKey: cursor,
      FilterExpression: "entityType = :entityType AND customerEmail = :customerEmail",
      ExpressionAttributeValues: toDynamoItem({
        ":entityType": "ORDER", ":customerEmail": email
      })
    }));
    for (const raw of result.Items ?? []) {
      const order = fromDynamoItem(raw);
      if (!order) continue;
      if (order.SK === "ORDER") {
        const orderId = orderIdFromPk(String(order.PK ?? ""));
        if (!orderId) continue;
        order.id = orderId;
        order.items = (await listOrderItems(orderId)).map((item) => ({
          ...item, price: item.unitPrice
        }));
      }
      orders.push(order);
    }
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return orders
    .sort((left, right) => String(right?.createdAt ?? "").localeCompare(String(left?.createdAt ?? "")));
}

function assertSameOrder(order: StorefrontOrderRecord, email: string, items: Array<{productId: string; quantity: number}>) {
  const match = order.customerEmail === email && order.items.length === items.length &&
    items.every(item => order.items.some(line => line.productId === item.productId && line.quantity === item.quantity));
  if (!match) throw new OrderActionError("CONFLICT", "Request ID already belongs to another order.");
}
