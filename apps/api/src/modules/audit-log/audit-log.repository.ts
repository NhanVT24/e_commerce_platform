import { BadRequestException, NotFoundException } from "@nestjs/common";
import { BatchGetItemCommand, GetItemCommand, QueryCommand, type KeysAndAttributes } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { databaseConfig } from "../../config/database-config.js";
import { rawDb } from "../../database/dynamodb/client.js";
import { auditResourceTypes } from "./audit-resources.js";
import type { AuditLogRecord } from "./audit-log.js";

export type AuditResourceTypeFilter = AuditLogRecord["resourceType"] | "ALL";

const defaultAuditLogTableName = "supermarket-audit-log";
const maxAuditLimit = 100;

export async function getAuditLog(input: { pk?: unknown; sk?: unknown }) {
  const key = z.object({
    pk: z.string().max(2048).regex(/^AUDIT_LOG#(ORDER|PAYMENT|USER|PRODUCT|SALE_CAMPAIGN|NOTIFICATION|CHECKOUT|EMAIL|EMAIL_ROUTE|OPERATION)#[^\s]+$/),
    sk: z.string().max(1024).regex(/^EVENT#[^\s]+$/)
  }).safeParse(input);
  if (!key.success) throw new BadRequestException("Invalid audit event key.");
  const result = await rawDb.send(new GetItemCommand({
    TableName: databaseConfig.AUDIT_LOG_TABLE_NAME ?? defaultAuditLogTableName,
    Key: marshall({ PK: key.data.pk, SK: key.data.sk }),
    ConsistentRead: true
  }));
  if (!result.Item) throw new NotFoundException("Audit event not found.");
  return unmarshall(result.Item) as AuditLogRecord;
}

function normalizeLimit(limit: unknown) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(maxAuditLimit, Math.max(1, Math.trunc(parsed)));
}

function normalizeResourceType(value: unknown): AuditResourceTypeFilter {
  const normalized = String(value || "ALL").trim().toUpperCase();
  return auditResourceTypes.find((type) => type === normalized) ?? "ALL";
}

async function queryByResourceType(resourceType: AuditLogRecord["resourceType"], limit: number, cursor?: PageKey) {
  const result = await rawDb.send(new QueryCommand({
    TableName: databaseConfig.AUDIT_LOG_TABLE_NAME ?? defaultAuditLogTableName,
    IndexName: "ResourceTimelineIndex",
    KeyConditionExpression: "#resourceType = :resourceType",
    ExpressionAttributeNames: {
      "#resourceType": "resourceType"
    },
    ExpressionAttributeValues: {
      ":resourceType": { S: resourceType }
    },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: cursor ? marshall(cursor) : undefined
  }));

  return { items: (result.Items ?? []).map((item) => unmarshall(item) as AuditLogRecord), hasMore: Boolean(result.LastEvaluatedKey) };
}

const keySchema = z.object({ PK: z.string(), SK: z.string(), resourceType: z.enum(auditResourceTypes), occurredAt: z.string() }).strict();
type PageKey = z.infer<typeof keySchema>;
const cursorSchema = z.object({
  resourceType: z.enum(["ALL", ...auditResourceTypes]),
  keys: z.partialRecord(z.enum(auditResourceTypes), keySchema)
}).strict();

export async function listAuditLogs(input: { resourceType?: unknown; limit?: unknown; cursor?: unknown }) {
  const limit = normalizeLimit(input.limit);
  const resourceType = normalizeResourceType(input.resourceType);
  const queriedTypes = resourceType === "ALL" ? auditResourceTypes : [resourceType];
  let positions: z.infer<typeof cursorSchema>["keys"] = {};
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 16384) throw new Error("Invalid cursor");
      const decoded = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
      if (decoded.resourceType !== resourceType) throw new Error("Filter mismatch");
      for (const type of auditResourceTypes) {
        if (decoded.keys[type] && decoded.keys[type]?.resourceType !== type) throw new Error("Partition mismatch");
      }
      positions = decoded.keys;
    } catch {
      throw new BadRequestException("Invalid audit pagination cursor.");
    }
  }
  const results = await Promise.all(queriedTypes.map((type) => queryByResourceType(type, limit + 1, positions[type])));
  const records = results.flatMap((result) => result.items);

  // Stable sorting preserves DynamoDB's partition order when timestamps tie.
  const items = records
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, limit);
  // Advance each partition only past records returned in the merged page.
  for (const item of items) positions[item.resourceType] = { PK: item.PK, SK: item.SK, resourceType: item.resourceType, occurredAt: item.occurredAt };
  const hasMore = records.length > limit || results.some((result) => result.hasMore);
  return { items, nextCursor: hasMore ? Buffer.from(JSON.stringify({ resourceType, keys: positions })).toString("base64url") : null };
}

export async function getAuditOrderEmails(orderIds: string[]) {
  const emails = new Map<string, string>();
  const table = databaseConfig.DYNAMODB_TABLE_NAME;
  for (let offset = 0; offset < orderIds.length; offset += 100) {
    let pending: Record<string, KeysAndAttributes> = {
      [table]: {
        Keys: orderIds.slice(offset, offset + 100).map((id) => marshall({ PK: `ORDER#${id}`, SK: "ORDER" })),
        ProjectionExpression: "PK, customerEmail"
      }
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await rawDb.send(new BatchGetItemCommand({ RequestItems: pending }));
      for (const raw of result.Responses?.[table] ?? []) {
        const item = unmarshall(raw);
        if (typeof item.customerEmail === "string") emails.set(String(item.PK).slice(6), item.customerEmail);
      }
      pending = result.UnprocessedKeys ?? {};
      if (!Object.values(pending).some((request) => request.Keys?.length)) break;
      if (attempt === 3) throw new Error("Audit owner lookup could not complete. Please retry.");
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt + Math.random() * 50));
    }
  }
  return emails;
}
