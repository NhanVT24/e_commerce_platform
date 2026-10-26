import { getPaymentSessionByTxnRef } from "../../../vnpay/vnpay.repository.js";
import { inventoryTransaction } from "../../../shopping/infrastructure/persistence/inventory-transaction.js";
import { readProductRecord } from "../../../shopping/infrastructure/persistence/product-record.store.js";
import { normalizeCheckoutItems } from "../../application/checkout-items.js";
import { OrderActionError } from "../../application/order-action.error.js";
import { getAwaitingPaymentOrder, listOrderItems } from "./order-record.store.js";
import type { OrderLifecycleStatus } from "../../domain/order-refund.js";
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

export async function createStorefrontOrder(input: CreateOrderPayload): Promise<StorefrontOrderCreationResult> {
  const normalizedItems = normalizeCheckoutItems(input.items);
  const lines: OrderLine[] = [];
  let totalAmount = 0;
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
  const saleCampaigns = await listActiveSaleCampaigns();

  for (const item of normalizedItems) {
    const product = await readProductRecord(item.productId);
    if (!product) {
      throw new Error(`Product ${item.productId} not found`);
    }

    const availableStock = Number(product.stock ?? 0) - Number(product.reservedStock ?? 0);
    if (availableStock < item.quantity) {
      throw new Error(`Insufficient stock for ${product.name}`);
    }

    const price = resolveSalePrice(product, saleCampaigns).price;
    const lineTotal = price * item.quantity;
    totalAmount += lineTotal;
    productSnapshots.set(item.productId, product);
    lines.push({
      productId: item.productId,
      productName: String(product.name ?? ""),
      price,
      quantity: item.quantity,
      lineTotal
    });
  }
  const orderRecord: StorefrontOrderRecord = {
    PK: `ORDER#${orderId}`,
    SK: "DETAIL",
    entityType: "ORDER",
    id: orderId,
    customerEmail: input.email,
    status: "pending",
    items: lines,
    totalAmount,
    createdAt: now,
    updatedAt: now
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
    const stock = Number(product.stock ?? 0) - item.quantity;
    return { productId: item.productId, productName: String(product.name ?? ""), sku: product.sku,
      previousStock: Number(product.stock ?? 0), stock, previousStatus: String(product.status ?? ""),
      status: stock <= 0 ? "out_of_stock" : stock <= 10 ? "low_stock" : "active" };
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

export async function createAwaitingPaymentOrder(input: {
  orderId: string;
  email: string;
  items: Array<{ productId: string; quantity: number }>;
  holdSeconds: number;
  bankCode?: string;
  locale?: "vn" | "en";
}) {
  const normalizedItems = normalizeCheckoutItems(input.items);
  const now = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + input.holdSeconds * 1000).toISOString();
  const saleCampaigns = await listActiveSaleCampaigns();
  const products = new Map<string, Record<string, any>>();
  const lines: StorefrontOrderItemRecord[] = [];
  let totalAmount = 0;

  for (const item of normalizedItems) {
    const product = await readProductRecord(item.productId);
    if (!product) throw new Error(`Product ${item.productId} not found`);

    const stock = Number(product.stock ?? 0);
    if (stock < item.quantity) {
      throw new Error(`Insufficient stock for ${product.name}`);
    }

    const resolvedPrice = resolveSalePrice(product, saleCampaigns);
    const unitPrice = resolvedPrice.price;
    const lineTotal = unitPrice * item.quantity;
    totalAmount += lineTotal;
    products.set(item.productId, product);
    lines.push({
      ...buildOrderItemKey(input.orderId, item.productId),
      entityType: "ORDER_ITEM",
      orderId: input.orderId,
      productId: item.productId,
      customerEmail: input.email,
      productName: String(product.name ?? ""),
      unitPrice,
      originalUnitPrice: resolvedPrice.originalPrice,
      quantity: item.quantity,
      lineTotal,
      createdAt: now,
      updatedAt: now
    });
  }

  const order: StorefrontAwaitingPaymentOrderRecord = {
    ...buildOrderMetaKey(input.orderId),
    entityType: "ORDER",
    customerEmail: input.email,
    status: "awaiting_payment",
    totalAmount,
    itemCount: lines.length,
    lockedUntil,
    checkoutBankCode: input.bankCode, checkoutLocale: input.locale,
    createdAt: now,
    updatedAt: now,
    ...serviceAuditMetadata({
      actorId: "service:checkout-api",
      source: "CHECKOUT_API",
      reason: "order_created",
      requestId: input.orderId
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
  if (input.expectedCustomerEmail && order.customerEmail !== input.expectedCustomerEmail) {
    throw new Error("Order customer does not match");
  }
  if ((input.expectedPaymentTxnRef && order.paymentTxnRef !== input.expectedPaymentTxnRef) ||
    (input.expectedAmount !== undefined && order.totalAmount !== input.expectedAmount)) throw new Error("Payment correlation changed; reconciliation required");
  if (input.expiresBefore && order.lockedUntil > input.expiresBefore) return { order, items: [], changed: false };
  if (order.status !== "awaiting_payment") {
    if (input.status === "paid" && !["paid", "refund_pending", "refund_sent", "refund_rejected"].includes(order.status)) {
      throw new Error("Payment received after inventory was released; reconciliation required");
    }
    return { order, items: await listOrderItems(input.orderId), changed: false };
  }

  if (input.status !== "paid" && order.paymentTxnRef) {
    const payment = await getPaymentSessionByTxnRef(order.paymentTxnRef);
    if (payment?.status === "success") {
      if (input.status === "expired") return { order, items: [], changed: false };
      throw new OrderActionError("CONFLICT", "Payment confirmed; order synchronization is pending.");
    }
  }
  const items = await listOrderItems(input.orderId);
  if (items.length === 0) throw new Error("Order has no held items");
  const now = new Date().toISOString();
  const isPaymentSuccess = input.status === "paid";
  const inventoryWrites = (await Promise.all(items.map(async item => {
    const product = await readProductRecord(item.productId);
    if (!product) throw new Error(`Product ${item.productId} not found`);
    return inventoryTransaction(product, { stock: isPaymentSuccess ? 0 : item.quantity, sold: isPaymentSuccess ? item.quantity : 0 }, now);
  }))).flat();
  const paymentConfirmedAt = isPaymentSuccess && input.paymentConfirmedAt ? input.paymentConfirmedAt : now;
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

  return { order: { ...order, status: input.status, updatedAt: now, ...(isPaymentSuccess ? { paymentConfirmedAt } : {}) }, items, changed: true };
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
