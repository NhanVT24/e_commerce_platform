import type { Notification, NewNotificationSnapshot } from "./domain/notification.js";
import { PutItemCommand, ScanCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../config/database-config.js";
import { deleteAuditedItem } from "../audit-log/audit-delete.js";
import { rawDb } from "../../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

function toDynamoItem(item: Record<string, unknown>) {
  return marshall(item, { removeUndefinedValues: true });
}

function fromDynamoItem(item?: Record<string, AttributeValue>) {
  return item ? (unmarshall(item) as Record<string, any>) : null;
}

export type NotificationRecord = {
  PK: string;
  SK: string;
  entityType: "NOTIFICATION";
  id: string;
  customerEmail: string;
  title: string;
  message: string;
  channel: "email" | "system";
  status: "pending" | "sent" | "read";
  isRead: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export async function createNotification(entity: Notification<NewNotificationSnapshot>) {
  const snapshot = entity.toSnapshot();
  const record: NotificationRecord = { PK: 'NOTIFICATION#' + snapshot.id, SK: 'DETAIL', entityType: 'NOTIFICATION', ...snapshot };

  await rawDb.send(new PutItemCommand({
    TableName,
    Item: toDynamoItem(record),
    ConditionExpression: "attribute_not_exists(PK)"
  }));

  return record;
}

export async function listNotificationsByCustomer(email: string) {
  const result = await rawDb.send(new ScanCommand({
    TableName,
    FilterExpression: "entityType = :entityType AND customerEmail = :customerEmail",
    ExpressionAttributeValues: toDynamoItem({
      ":entityType": "NOTIFICATION",
      ":customerEmail": email
    })
  }));

  return (result.Items ?? [])
    .map((item) => fromDynamoItem(item) as NotificationRecord | null)
    .map((item) => item ? { ...item, isRead: Boolean(item.isRead ?? item.status === "read") } : item)
    .filter(Boolean)
    .sort((left, right) => String(right?.createdAt ?? "").localeCompare(String(left?.createdAt ?? "")));
}

export async function listAllNotifications() {
  const result = await rawDb.send(new ScanCommand({
    TableName,
    FilterExpression: "entityType = :entityType",
    ExpressionAttributeValues: toDynamoItem({
      ":entityType": "NOTIFICATION"
    })
  }));

  return (result.Items ?? [])
    .map((item) => fromDynamoItem(item) as NotificationRecord | null)
    .map((item) => item ? { ...item, isRead: Boolean(item.isRead ?? item.status === "read") } : item)
    .filter(Boolean)
    .sort((left, right) => String(right?.createdAt ?? "").localeCompare(String(left?.createdAt ?? "")));
}

export async function markNotificationAsRead(id: string) {
  const now = new Date().toISOString();
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: toDynamoItem({
      PK: `NOTIFICATION#${id}`,
      SK: "DETAIL"
    }),
    ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: "SET #status = :status, isRead = :isRead, updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#status": "status"
    },
    ExpressionAttributeValues: toDynamoItem({
      ":status": "read",
      ":isRead": true,
      ":updatedAt": now
    })
  }));
}

export async function markNotificationAsSent(id: string) {
  const now = new Date().toISOString();
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: toDynamoItem({
      PK: `NOTIFICATION#${id}`,
      SK: "DETAIL"
    }),
    UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
    ConditionExpression: "attribute_exists(PK)",
    ExpressionAttributeNames: {
      "#status": "status"
    },
    ExpressionAttributeValues: toDynamoItem({
      ":status": "sent",
      ":updatedAt": now
    })
  }));
}

export async function deleteNotification(id: string) {
  return deleteAuditedItem(TableName, toDynamoItem({ PK: `NOTIFICATION#${id}`, SK: "DETAIL" }));
}

export async function deleteNotifications(ids: string[]) {
  // Each delete atomically persists its audit. A failed item is surfaced instead
  // of silently dropping BatchWrite's UnprocessedItems.
  for (const id of new Set(ids)) await deleteNotification(id);
}
