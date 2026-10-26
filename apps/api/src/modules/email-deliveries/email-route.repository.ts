import {
  ConditionalCheckFailedException,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../config/database-config.js";
import { emailConfig } from "../../config/email-config.js";
import { rawDb } from "../../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
const MAX_WATCHDOG_RESULTS = 100;
const MAX_WATCHDOG_EVALUATED_ITEMS = 1_000;

export type EmailRouteStatus =
  | "PUBLISHING"
  | "PUBLISH_RETRY"
  | "PUBLISH_FAILED"
  | "PUBLISHED"
  | "PUBLISH_UNKNOWN"
  | "RULE_MATCHED"
  | "PROCESSING"
  | "ROUTING_SUSPECTED";

export type EmailRouteRecord = {
  PK: string;
  SK: "STATUS";
  entityType: "EMAIL_ROUTE";
  /** Required by the deployed sparse StatusTimelineIndex key schema. */
  searchName: string;
  emailJobId: string;
  campaignId: string;
  batchIndex: number;
  batchCount: number;
  status: EmailRouteStatus;
  routeStage: number;
  eventId?: string;
  publishedAt?: string;
  ruleMatchedAt?: string;
  processingStartedAt?: string;
  routingSuspectedAt?: string;
  alertStatus?: "PENDING" | "SENT" | "FAILED";
  alertMessageId?: string;
  publishFailureReason?: string;
  publishAttempts: number;
  manualRetryCount?: number;
  lastManualRetryAt?: string;
  nextPublishAt?: string;
  publishLeaseUntil?: string;
  eventBusName?: string;
  eventSource: string;
  eventDetailType: string;
  eventDetail: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const routeStages = {
  PUBLISHING: 10,
  PUBLISHED: 20,
  RULE_MATCHED: 30,
  PROCESSING: 40
} as const;

const MAX_PUBLISH_RECOVERY_RESULTS = 100;
const MAX_PUBLISH_RECOVERY_EVALUATED_ITEMS = 1_000;
const MAX_FAILED_PUBLISH_RESULTS = 100;

function key(emailJobId: string) {
  return { PK: `EMAIL_ROUTE#${emailJobId}`, SK: "STATUS" } as const;
}

function item(value: Record<string, unknown>) {
  return marshall(value, { removeUndefinedValues: true });
}

function isConditionalFailure(error: unknown) {
  return error instanceof ConditionalCheckFailedException
    || (error as { name?: string } | undefined)?.name === "ConditionalCheckFailedException";
}

/**
 * Creates the expectation before PutEvents. Duplicate HTTP requests reuse the
 * same deterministic emailJobId and must never reset a route that advanced.
 */
export async function ensureEmailRoute(input: {
  emailJobId: string;
  campaignId: string;
  batchIndex: number;
  batchCount: number;
  event: {
    busName?: string;
    source: string;
    detailType: string;
    detail: Record<string, unknown>;
  };
}) {
  const now = new Date().toISOString();
  const publishLeaseUntil = new Date(Date.now() + emailConfig.EMAIL_EVENT_PUBLISH_LEASE_SECONDS * 1_000).toISOString();
  const record: EmailRouteRecord = {
    ...key(input.emailJobId),
    entityType: "EMAIL_ROUTE",
    searchName: input.emailJobId,
    emailJobId: input.emailJobId,
    campaignId: input.campaignId,
    batchIndex: input.batchIndex,
    batchCount: input.batchCount,
    status: "PUBLISHING",
    routeStage: routeStages.PUBLISHING,
    publishAttempts: 1,
    publishLeaseUntil,
    eventBusName: input.event.busName,
    eventSource: input.event.source,
    eventDetailType: input.event.detailType,
    eventDetail: input.event.detail,
    createdAt: now,
    updatedAt: now
  };

  try {
    await rawDb.send(new PutItemCommand({
      TableName,
      Item: item(record),
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    }));
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

async function advanceRoute(input: {
  emailJobId: string;
  status: "PUBLISHED" | "RULE_MATCHED" | "PROCESSING";
  routeStage: number;
  timestampField: "publishedAt" | "ruleMatchedAt" | "processingStartedAt";
  timestamp?: string;
}) {
  const timestamp = input.timestamp ?? new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: item(key(input.emailJobId)),
      ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(routeStage) OR routeStage < :nextStage)",
      UpdateExpression: "SET #status = :status, routeStage = :nextStage, #timestamp = if_not_exists(#timestamp, :timestamp), updatedAt = :timestamp REMOVE alertStatus, publishFailureReason, nextPublishAt, publishLeaseUntil",
      ExpressionAttributeNames: {
        "#status": "status",
        "#timestamp": input.timestampField
      },
      ExpressionAttributeValues: item({
        ":status": input.status,
        ":nextStage": input.routeStage,
        ":timestamp": timestamp
      })
    }));
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

export async function markEmailRoutePublished(input: {
  emailJobId: string;
  eventId: string;
  publishedAt?: string;
}) {
  const publishedAt = input.publishedAt ?? new Date().toISOString();

  // Store EventBridge correlation metadata even when the tracker has already
  // advanced the status. This update deliberately does not move updatedAt back.
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: item(key(input.emailJobId)),
    ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: "SET eventId = :eventId, publishedAt = if_not_exists(publishedAt, :publishedAt) REMOVE nextPublishAt, publishLeaseUntil",
    ExpressionAttributeValues: item({
      ":eventId": input.eventId,
      ":publishedAt": publishedAt
    })
  }));

  return advanceRoute({
    emailJobId: input.emailJobId,
    status: "PUBLISHED",
    routeStage: routeStages.PUBLISHED,
    timestampField: "publishedAt",
    timestamp: publishedAt
  });
}

export async function markEmailRoutePublishRetry(input: {
  emailJobId: string;
  reason: string;
  attempt: number;
  nextPublishAt: string;
}) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: item(key(input.emailJobId)),
      ConditionExpression: "attribute_exists(PK) AND routeStage = :publishingStage AND #status = :publishing AND publishAttempts = :attempt",
      UpdateExpression: "SET #status = :status, publishFailureReason = :reason, nextPublishAt = :nextPublishAt, updatedAt = :now REMOVE publishLeaseUntil",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: item({
        ":publishingStage": routeStages.PUBLISHING,
        ":publishing": "PUBLISHING",
        ":status": "PUBLISH_RETRY",
        ":attempt": input.attempt,
        ":reason": input.reason.slice(0, 500),
        ":nextPublishAt": input.nextPublishAt,
        ":now": now
      })
    }));
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

/** Finds publish attempts that are due, including a PUBLISHING record whose
 * lease expired because the original API/Lambda process stopped mid-flight. */
export async function findDueEmailRoutePublishes(now: string) {
  const routes: EmailRouteRecord[] = [];
  let evaluated = 0;

  for (const candidate of [
    { status: "PUBLISH_RETRY", dueField: "nextPublishAt" },
    { status: "PUBLISHING", dueField: "publishLeaseUntil" }
  ] as const) {
    let cursor: Record<string, AttributeValue> | undefined;
    do {
      const pageLimit = Math.min(100, MAX_PUBLISH_RECOVERY_EVALUATED_ITEMS - evaluated);
      if (pageLimit <= 0) break;

      const response = await rawDb.send(new QueryCommand({
        TableName,
        IndexName: "StatusTimelineIndex",
        KeyConditionExpression: "#status = :status AND updatedAt <= :now",
        FilterExpression: `${candidate.dueField} <= :now`,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: item({ ":status": candidate.status, ":now": now }),
        ExclusiveStartKey: cursor,
        Limit: pageLimit,
        ScanIndexForward: true
      }));

      evaluated += response.ScannedCount ?? 0;
      routes.push(...(response.Items ?? []).map((value) => unmarshall(value) as EmailRouteRecord));
      cursor = response.LastEvaluatedKey;
    } while (cursor && routes.length < MAX_PUBLISH_RECOVERY_RESULTS && evaluated < MAX_PUBLISH_RECOVERY_EVALUATED_ITEMS);

    if (routes.length >= MAX_PUBLISH_RECOVERY_RESULTS || evaluated >= MAX_PUBLISH_RECOVERY_EVALUATED_ITEMS) break;
  }

  return routes.slice(0, MAX_PUBLISH_RECOVERY_RESULTS);
}

/** Atomically leases one due route and increments the attempt before the
 * external PutEvents call. The exact attempt value prevents stale writers from
 * rescheduling a newer attempt. */
export async function claimEmailRoutePublish(input: {
  emailJobId: string;
  expectedAttempt: number;
  maxAttempts: number;
  now: string;
  leaseUntil: string;
}) {
  try {
    const response = await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: item(key(input.emailJobId)),
      ConditionExpression: "routeStage = :publishingStage AND publishAttempts = :expectedAttempt AND publishAttempts < :maxAttempts AND ((#status = :retry AND nextPublishAt <= :now) OR (#status = :publishing AND publishLeaseUntil <= :now))",
      UpdateExpression: "SET #status = :publishing, publishLeaseUntil = :leaseUntil, updatedAt = :now REMOVE nextPublishAt ADD publishAttempts :one",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: item({
        ":publishingStage": routeStages.PUBLISHING,
        ":expectedAttempt": input.expectedAttempt,
        ":maxAttempts": input.maxAttempts,
        ":retry": "PUBLISH_RETRY",
        ":publishing": "PUBLISHING",
        ":now": input.now,
        ":leaseUntil": input.leaseUntil,
        ":one": 1
      }),
      ReturnValues: "ALL_NEW"
    }));
    return response.Attributes ? unmarshall(response.Attributes) as EmailRouteRecord : undefined;
  } catch (error) {
    if (isConditionalFailure(error)) return undefined;
    throw error;
  }
}

export async function markEmailRoutePublishFailed(input: {
  emailJobId: string;
  attempt: number;
  reason: string;
}) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: item(key(input.emailJobId)),
      ConditionExpression: "routeStage = :publishingStage AND (#status = :publishing OR #status = :retry) AND publishAttempts = :attempt",
      UpdateExpression: "SET #status = :failed, publishFailureReason = :reason, alertStatus = :pending, updatedAt = :now REMOVE nextPublishAt, publishLeaseUntil",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: item({
        ":publishingStage": routeStages.PUBLISHING,
        ":publishing": "PUBLISHING",
        ":retry": "PUBLISH_RETRY",
        ":attempt": input.attempt,
        ":failed": "PUBLISH_FAILED",
        ":reason": input.reason.slice(0, 500),
        ":pending": "PENDING",
        ":now": now
      })
    }));
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

/** Returns terminal producer-side failures for the admin recovery console.
 * The controller must expose only summary fields because eventDetail can
 * contain recipient addresses and the complete email body. */
export async function listFailedEmailRoutePublishes(limit = 50) {
  const safeLimit = Math.max(1, Math.min(MAX_FAILED_PUBLISH_RESULTS, Math.trunc(limit)));
  const response = await rawDb.send(new QueryCommand({
    TableName,
    IndexName: "StatusTimelineIndex",
    KeyConditionExpression: "#status = :failed",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: item({ ":failed": "PUBLISH_FAILED" }),
    Limit: safeLimit,
    ScanIndexForward: false
  }));

  return (response.Items ?? []).map((value) => unmarshall(value) as EmailRouteRecord);
}

/** Starts a fresh bounded retry cycle after an admin has fixed the root cause.
 * The status condition makes concurrent/double-click retries idempotent: only
 * the first request can move PUBLISH_FAILED back to PUBLISH_RETRY. */
export async function retryFailedEmailRoutePublish(emailJobId: string, retryAt?: string) {
  const now = retryAt ?? new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: item(key(emailJobId)),
      ConditionExpression: "attribute_exists(PK) AND routeStage = :publishingStage AND #status = :failed",
      UpdateExpression: "SET #status = :retry, publishAttempts = :zero, nextPublishAt = :now, lastManualRetryAt = :now, updatedAt = :now REMOVE publishLeaseUntil, alertStatus, alertMessageId ADD manualRetryCount :one",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: item({
        ":publishingStage": routeStages.PUBLISHING,
        ":failed": "PUBLISH_FAILED",
        ":retry": "PUBLISH_RETRY",
        ":zero": 0,
        ":one": 1,
        ":now": now
      })
    }));
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

export function markEmailRouteRuleMatched(emailJobId: string, timestamp?: string) {
  return advanceRoute({
    emailJobId,
    status: "RULE_MATCHED",
    routeStage: routeStages.RULE_MATCHED,
    timestampField: "ruleMatchedAt",
    timestamp
  });
}

export function markEmailRouteProcessing(emailJobId: string, timestamp?: string) {
  return advanceRoute({
    emailJobId,
    status: "PROCESSING",
    routeStage: routeStages.PROCESSING,
    timestampField: "processingStartedAt",
    timestamp
  });
}

export async function findStalePublishedEmailRoutes(updatedBefore: string) {
  const routes: EmailRouteRecord[] = [];
  let evaluated = 0;
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const pageLimit = Math.min(100, MAX_WATCHDOG_EVALUATED_ITEMS - evaluated);
    if (pageLimit <= 0) break;

    const response = await rawDb.send(new QueryCommand({
      TableName,
      IndexName: "EntityUpdatedAtIndex",
      KeyConditionExpression: "entityType = :entityType AND updatedAt <= :updatedBefore",
      FilterExpression: "#status = :published",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: item({
        ":entityType": "EMAIL_ROUTE",
        ":updatedBefore": updatedBefore,
        ":published": "PUBLISHED"
      }),
      ExclusiveStartKey: cursor,
      Limit: pageLimit
    }));

    evaluated += response.ScannedCount ?? 0;
    routes.push(...(response.Items ?? []).map((value) => unmarshall(value) as EmailRouteRecord));
    cursor = response.LastEvaluatedKey;
  } while (cursor && routes.length < MAX_WATCHDOG_RESULTS && evaluated < MAX_WATCHDOG_EVALUATED_ITEMS);

  return routes.slice(0, MAX_WATCHDOG_RESULTS);
}

/** Claims one timeout exactly once. The status check closes the race where the
 * tracker advances the route after the watchdog query but before this update. */
export async function markEmailRouteRoutingSuspected(emailJobId: string) {
  const now = new Date().toISOString();
  try {
    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: item(key(emailJobId)),
      ConditionExpression: "#status = :published AND routeStage = :publishedStage",
      UpdateExpression: "SET #status = :suspected, routingSuspectedAt = :now, alertStatus = :pending, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: item({
        ":published": "PUBLISHED",
        ":publishedStage": routeStages.PUBLISHED,
        ":suspected": "ROUTING_SUSPECTED",
        ":pending": "PENDING",
        ":now": now
      })
    }));
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

export async function markEmailRouteAlertResult(input: {
  emailJobId: string;
  sent: boolean;
  messageId?: string;
}) {
  const now = new Date().toISOString();
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: item(key(input.emailJobId)),
    // The tracker may recover the route while SNS is publishing. Persist the
    // alert outcome as audit metadata without forcing the route status back.
    ConditionExpression: "attribute_exists(PK)",
    UpdateExpression: "SET alertStatus = :alertStatus, alertMessageId = :messageId, updatedAt = :now",
    ExpressionAttributeValues: item({
      ":alertStatus": input.sent ? "SENT" : "FAILED",
      ":messageId": input.messageId ?? "",
      ":now": now
    })
  }));
}
