import {
  BatchWriteItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type WriteRequest
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../config/database-config.js";
import { auditTarget } from "../audit-log/audit-resources.js";
import { deleteAuditedItem } from "../audit-log/audit-delete.js";
import { rawDb } from "../../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
const CLEANUP_LOCK_MINUTES = 30;
const MAX_RECORDS_PER_ENTITY_PER_RUN = 2_500;

type DynamoItem = Record<string, unknown>;
type DynamoKey = Record<string, AttributeValue>;

export type CleanupCandidate = {
  PK: string;
  SK: string;
  entityType: string;
  status?: string;
  isRead?: boolean;
  updatedAt?: string;
};

function toDynamoItem(item: Record<string, unknown>) {
  return marshall(item, { removeUndefinedValues: true });
}

function fromDynamoItem(item?: Record<string, AttributeValue>) {
  return item ? unmarshall(item) as DynamoItem : null;
}

function cleanupJobKey() {
  return { PK: "SYSTEM_JOB#DATA_CLEANUP", SK: "DETAIL" };
}

export async function tryStartDataCleanup(now = new Date()) {
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const lockExpiredAt = new Date(now.getTime() - CLEANUP_LOCK_MINUTES * 60 * 1000).toISOString();
  const startedAt = now.toISOString();

  try {
    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: toDynamoItem(cleanupJobKey()),
      // This conditional write is a distributed lock for duplicate Scheduler invocations.
      ConditionExpression: "(attribute_not_exists(lastStartedAt) OR lastStartedAt <= :lockExpiredAt) AND (attribute_not_exists(lastSucceededAt) OR lastSucceededAt <= :threeDaysAgo)",
      UpdateExpression: "SET entityType = :entityType, #status = :status, lastStartedAt = :startedAt, updatedAt = :startedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: toDynamoItem({
        ":entityType": "SYSTEM_JOB",
        ":status": "running",
        ":startedAt": startedAt,
        ":lockExpiredAt": lockExpiredAt,
        ":threeDaysAgo": threeDaysAgo
      })
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
}

export async function markDataCleanupCompleted(input: { hasRemainingBacklog: boolean; now?: Date }) {
  const completedAt = (input.now ?? new Date()).toISOString();
  const values: Record<string, unknown> = {
    ":status": input.hasRemainingBacklog ? "backlog" : "completed",
    ":completedAt": completedAt
  };
  let updateExpression = "SET #status = :status, lastCompletedAt = :completedAt, updatedAt = :completedAt";

  // Leave the run due tomorrow if there is more than one Lambda execution worth of stale data.
  if (!input.hasRemainingBacklog) {
    values[":succeededAt"] = completedAt;
    updateExpression += ", lastSucceededAt = :succeededAt";
  }

  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: toDynamoItem(cleanupJobKey()),
    UpdateExpression: updateExpression,
    ConditionExpression: "attribute_exists(PK)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: toDynamoItem(values)
  }));
}

export async function listCleanupCandidates(input: {
  entityType: "NOTIFICATION" | "CHECKOUT_GATE" | "CHECKOUT_RESERVATION" | "INVENTORY_DAILY_REPORT" | "EMAIL" | "EMAIL_ROUTE";
  updatedBefore: string;
  isEligible: (item: CleanupCandidate) => boolean;
}) {
  const candidates: CleanupCandidate[] = [];
  let lastKey: DynamoKey | undefined;
  let hasRemainingBacklog = false;

  do {
    const result = await rawDb.send(new QueryCommand({
      TableName,
      IndexName: "EntityUpdatedAtIndex",
      KeyConditionExpression: "entityType = :entityType AND updatedAt <= :updatedBefore",
      ExpressionAttributeValues: toDynamoItem({
        ":entityType": input.entityType,
        ":updatedBefore": input.updatedBefore
      }),
      ExclusiveStartKey: lastKey,
      Limit: Math.min(100, MAX_RECORDS_PER_ENTITY_PER_RUN - candidates.length)
    }));

    for (const rawItem of result.Items ?? []) {
      const item = fromDynamoItem(rawItem) as CleanupCandidate | null;
      if (item && input.isEligible(item)) {
        candidates.push(item);
      }
    }

    lastKey = result.LastEvaluatedKey;
    if (candidates.length >= MAX_RECORDS_PER_ENTITY_PER_RUN && lastKey) {
      hasRemainingBacklog = true;
      break;
    }
  } while (lastKey);

  return { candidates, hasRemainingBacklog };
}

export async function deleteCleanupCandidates(candidates: CleanupCandidate[]) {
  let deletedCount = 0;

  const audited = candidates.filter((candidate) => auditTarget(candidate.PK, candidate.SK));
  const ordinary = candidates.filter((candidate) => !auditTarget(candidate.PK, candidate.SK));
  for (let offset = 0; offset < audited.length; offset += 10) {
    const results = await Promise.all(audited.slice(offset, offset + 10).map((candidate) =>
      deleteAuditedItem(TableName, toDynamoItem({ PK: candidate.PK, SK: candidate.SK }), candidate.updatedAt)));
    deletedCount += results.filter(Boolean).length;
  }

  for (let index = 0; index < ordinary.length; index += 25) {
    let pending: WriteRequest[] = ordinary.slice(index, index + 25).map((candidate) => ({
      DeleteRequest: { Key: toDynamoItem({ PK: candidate.PK, SK: candidate.SK }) }
    }));

    for (let attempt = 0; pending.length > 0 && attempt < 4; attempt += 1) {
      const response = await rawDb.send(new BatchWriteItemCommand({
        RequestItems: { [TableName]: pending }
      }));
      const unprocessed = response.UnprocessedItems?.[TableName] ?? [];
      deletedCount += pending.length - unprocessed.length;
      pending = unprocessed;

      if (pending.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }

    if (pending.length > 0) {
      throw new Error(`DynamoDB left ${pending.length} cleanup records unprocessed after retries.`);
    }
  }

  return deletedCount;
}
