import crypto from "node:crypto";
import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../config/database-config.js";
import { rawDb } from "../../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
export type SaleCampaignStatus = "scheduled" | "active" | "ended" | "cancelled";
export type SaleCampaign = {
  PK: string; SK: "DETAIL"; entityType: "SALE_CAMPAIGN"; id: string; name: string;
  campaignStatus: SaleCampaignStatus; discountPercent: number; productIds: string[];
  startAt: string; endAt: string; startScheduleName: string; endScheduleName: string;
  version: number; createdAt: string; updatedAt: string;
};
function key(id: string) { return { PK: `SALE_CAMPAIGN#${id}`, SK: "DETAIL" } as const; }
function marshal(item: Record<string, unknown>) { return marshall(item, { removeUndefinedValues: true }); }
function unmarshal(item?: Record<string, AttributeValue>) { return item ? unmarshall(item) as SaleCampaign : null; }

export async function createSaleCampaign(input: Omit<SaleCampaign, "PK" | "SK" | "entityType" | "version" | "createdAt" | "updatedAt">) {
  const now = new Date().toISOString(); const id = input.id || crypto.randomUUID();
  const record: SaleCampaign = { ...key(id), entityType: "SALE_CAMPAIGN", id, version: 1, createdAt: now, updatedAt: now, ...input };
  await rawDb.send(new PutItemCommand({ TableName, Item: marshal(record), ConditionExpression: "attribute_not_exists(PK)" }));
  return record;
}
export async function getSaleCampaign(id: string) {
  const result = await rawDb.send(new GetItemCommand({ TableName, Key: marshal(key(id)), ConsistentRead: true }));
  return unmarshal(result.Item);
}
export async function listSaleCampaigns() {
  const result = await rawDb.send(new QueryCommand({ TableName, IndexName: "EntityUpdatedAtIndex", KeyConditionExpression: "entityType = :entityType", ExpressionAttributeValues: marshal({ ":entityType": "SALE_CAMPAIGN" }), ScanIndexForward: false }));
  return (result.Items ?? []).map(unmarshal).filter(Boolean) as SaleCampaign[];
}
export async function listActiveSaleCampaigns(now = new Date()) {
  const result = await rawDb.send(new QueryCommand({ TableName, IndexName: "SaleCampaignTimelineIndex", KeyConditionExpression: "campaignStatus = :status", ExpressionAttributeValues: marshal({ ":status": "active" }) }));
  return (result.Items ?? []).map(unmarshal).filter((campaign): campaign is SaleCampaign => Boolean(campaign && campaign.startAt <= now.toISOString() && campaign.endAt > now.toISOString()));
}
export async function transitionSaleCampaign(id: string, from: SaleCampaignStatus, to: SaleCampaignStatus) {
  const now = new Date().toISOString();
  await rawDb.send(new UpdateItemCommand({ TableName, Key: marshal(key(id)), UpdateExpression: "SET campaignStatus = :to, updatedAt = :now, #version = #version + :one", ConditionExpression: "attribute_exists(PK) AND campaignStatus = :from", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: marshal({ ":to": to, ":from": from, ":now": now, ":one": 1 }) }));
}
export async function cancelSaleCampaign(id: string) {
  const now = new Date().toISOString();
  await rawDb.send(new UpdateItemCommand({ TableName, Key: marshal(key(id)), UpdateExpression: "SET campaignStatus = :status, updatedAt = :now, #version = #version + :one", ConditionExpression: "attribute_exists(PK) AND campaignStatus = :scheduled", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: marshal({ ":status": "cancelled", ":now": now, ":one": 1 }) }));
}

export async function updateSaleCampaignProducts(input: {
  id: string;
  expectedStatus: Extract<SaleCampaignStatus, "scheduled" | "active">;
  expectedVersion: number;
  productIds: string[];
}) {
  const now = new Date().toISOString();
  const result = await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: marshal(key(input.id)),
    UpdateExpression: "SET productIds = :productIds, updatedAt = :now, #version = #version + :one",
    ConditionExpression: "attribute_exists(PK) AND campaignStatus = :expectedStatus AND #version = :expectedVersion",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: marshal({ ":productIds": input.productIds, ":now": now, ":one": 1, ":expectedStatus": input.expectedStatus, ":expectedVersion": input.expectedVersion }),
    ReturnValues: "ALL_NEW"
  }));
  return unmarshal(result.Attributes);
}

export async function closeSaleCampaignBecauseEmpty(input: {
  id: string;
  expectedStatus: Extract<SaleCampaignStatus, "scheduled" | "active">;
  expectedVersion: number;
}) {
  const now = new Date().toISOString();
  const finalStatus: SaleCampaignStatus = input.expectedStatus === "active" ? "ended" : "cancelled";
  const result = await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: marshal(key(input.id)),
    UpdateExpression: "SET productIds = :emptyProducts, campaignStatus = :finalStatus, updatedAt = :now, #version = #version + :one",
    ConditionExpression: "attribute_exists(PK) AND campaignStatus = :expectedStatus AND #version = :expectedVersion",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: marshal({ ":emptyProducts": [], ":finalStatus": finalStatus, ":now": now, ":one": 1, ":expectedStatus": input.expectedStatus, ":expectedVersion": input.expectedVersion }),
    ReturnValues: "ALL_NEW"
  }));
  return unmarshal(result.Attributes);
}
