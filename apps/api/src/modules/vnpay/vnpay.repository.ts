import { GetItemCommand, PutItemCommand, TransactWriteItemsCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../config/database-config.js";
import { rawDb } from "../../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

function toDynamoItem(item: Record<string, unknown>) {
  return marshall(item, { removeUndefinedValues: true });
}

export type PaymentSessionStatus = "pending" | "success" | "failed" | "expired";

export type PaymentSessionRecord = {
  PK: string;
  SK: string;
  entityType: "PAYMENT_SESSION";
  txnRef: string;
  orderId?: string;
  email?: string;
  orderInfo: string;
  amount: number;
  status: PaymentSessionStatus;
  createdAt: string;
  transactionDate?: string;
  updatedAt: string;
  expiresAt: string;
  finalizedAt?: string;
  paidAt?: string;
  paymentEventEnqueuedAt?: string;
  paymentUrl?: string;
  recoveryAttempts?: number;
  recoveryNextAt?: string;
  responseCode?: string;
  gatewayTransactionStatus?: string;
  transactionNo?: string;
  bankCode?: string;
  payDate?: string;
  auditActorType?: string;
  auditActorId?: string;
  auditActorRole?: string;
  auditSource?: string;
  auditReason?: string;
  auditRequestId?: string;
};

export async function createPaymentSession(input: {
  txnRef: string;
  orderId?: string;
  email?: string;
  orderInfo: string;
  amount: number;
  expiresAt: string;
  transactionDate: string;
  paymentUrl?: string;
}) {
  const now = new Date().toISOString();
  const record: PaymentSessionRecord = {
    PK: `PAYMENT#${input.txnRef}`,
    SK: "DETAIL",
    entityType: "PAYMENT_SESSION",
    txnRef: input.txnRef,
    paymentUrl: input.paymentUrl,
    orderId: input.orderId,
    email: input.email?.trim().toLowerCase() || undefined,
    orderInfo: input.orderInfo,
    amount: input.amount,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
    transactionDate: input.transactionDate,
    auditActorType: "SERVICE",
    auditActorId: "service:checkout-api",
    auditActorRole: "SYSTEM",
    auditSource: "CHECKOUT_API",
    auditReason: "payment_session_created",
    auditRequestId: input.orderId ?? input.txnRef
  };

  const put = { TableName, Item: toDynamoItem(record), ConditionExpression: "attribute_not_exists(PK)" };
  if (input.orderId && input.paymentUrl) {
    // The link is generated locally. Only this atomic commit makes it usable
    // by checkout; no external charge/refund is initiated here.
    await rawDb.send(new TransactWriteItemsCommand({ TransactItems: [ { Put: put }, { Update: {
      TableName, Key: toDynamoItem({ PK: 'ORDER#' + input.orderId, SK: "ORDER" }),
      ConditionExpression: "#status = :awaiting AND customerEmail = :email AND totalAmount = :amount AND lockedUntil > :now AND attribute_not_exists(paymentTxnRef)",
      UpdateExpression: "SET paymentTxnRef = :ref, paymentUrl = :url",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: toDynamoItem({ ":awaiting": "awaiting_payment", ":email": record.email, ":amount": record.amount,
        ":now": now, ":ref": record.txnRef, ":url": input.paymentUrl })
    } } ] }));
  } else await rawDb.send(new PutItemCommand(put));

  return record;
}

export async function getPaymentSessionByTxnRef(txnRef: string) {
  const result = await rawDb.send(new GetItemCommand({
    TableName,
    ConsistentRead: true,
    Key: toDynamoItem({
      PK: `PAYMENT#${txnRef}`,
      SK: "DETAIL"
    })
  }));

  return result.Item ? (unmarshall(result.Item) as PaymentSessionRecord) : null;
}

export async function updatePaymentSessionStatus(input: {
  txnRef: string;
  status: Exclude<PaymentSessionStatus, "pending">;
  responseCode: string;
  transactionStatus?: string;
  transactionNo: string;
  bankCode: string;
  payDate: string;
}) {
  const now = new Date().toISOString();
  const shouldSetPaidAt = input.status === "success";
  const updateSegments = [
    "SET #status = :status",
    "updatedAt = :updatedAt",
    "finalizedAt = :finalizedAt",
    "responseCode = :responseCode",
    "transactionNo = :transactionNo",
    "bankCode = :bankCode",
    "payDate = :payDate",
    "auditActorType = :auditActorType",
    "auditActorId = :auditActorId",
    "auditActorRole = :auditActorRole",
    "auditSource = :auditSource",
    "auditReason = :auditReason",
    "auditRequestId = :auditRequestId"
  ];

  if (shouldSetPaidAt) {
    updateSegments.push("paidAt = :paidAt");
  }
  if (input.transactionStatus !== undefined) {
    updateSegments.push("gatewayTransactionStatus = :gatewayTransactionStatus");
  }

  const expressionAttributeValues: Record<string, unknown> = {
    ":status": input.status,
    ":pendingStatus": "pending",
    ":updatedAt": now,
    ":finalizedAt": now,
    ":responseCode": input.responseCode,
    ":transactionNo": input.transactionNo,
    ":bankCode": input.bankCode,
    ":payDate": input.payDate,
    ":auditActorType": "SERVICE",
    ":auditActorId": "lambda:vnpay-ipn",
    ":auditActorRole": "SYSTEM",
    ":auditSource": "VNPAY_IPN",
    ":auditReason": input.status === "success" ? "payment_success" : input.status === "expired" ? "payment_timeout" : "payment_failed",
    ":auditRequestId": input.txnRef
  };

  if (shouldSetPaidAt) {
    expressionAttributeValues[":paidAt"] = now;
  }
  if (input.transactionStatus !== undefined) {
    expressionAttributeValues[":gatewayTransactionStatus"] = input.transactionStatus;
  }

  const result = await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: toDynamoItem({
      PK: `PAYMENT#${input.txnRef}`,
      SK: "DETAIL"
    }),
    ConditionExpression: "attribute_exists(PK) AND #status = :pendingStatus",
    ReturnValues: "ALL_NEW",
    UpdateExpression: updateSegments.join(", "),
    ExpressionAttributeNames: {
      "#status": "status"
    },
    ExpressionAttributeValues: toDynamoItem(expressionAttributeValues)
  }));
  if (!result.Attributes) throw new Error("Payment update returned no record");
  return unmarshall(result.Attributes) as PaymentSessionRecord;
}

export async function markPaymentEventEnqueued(txnRef: string) {
  const now = new Date().toISOString();

  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: toDynamoItem({
      PK: `PAYMENT#${txnRef}`,
      SK: "DETAIL"
    }),
    ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(paymentEventEnqueuedAt)",
    UpdateExpression: "SET paymentEventEnqueuedAt = :paymentEventEnqueuedAt, updatedAt = :updatedAt",
    ExpressionAttributeValues: toDynamoItem({
      ":paymentEventEnqueuedAt": now,
      ":updatedAt": now
    })
  }));
}
