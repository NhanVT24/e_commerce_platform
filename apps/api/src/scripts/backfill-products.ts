import { ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../config/database-config.js";
import { rawDb } from "../database/dynamodb/client.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

function normalizeText(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/Ä‘/g, "d");
}

function deriveStatus(stock: number) {
  if (stock <= 0) return "out_of_stock";
  if (stock <= 10) return "low_stock";
  return "active";
}

function isProductItem(item: Record<string, any> | null) {
  if (!item) return false;
  if (item.entityType === "PRODUCT") return true;
  return String(item.PK ?? "").startsWith("PRODUCT#") && String(item.SK ?? "") === "DETAIL";
}

function buildPatch(item: Record<string, any>) {
  const patch: Record<string, unknown> = {};

  if (!item.entityType) patch.entityType = "PRODUCT";
  if (!item.searchField) patch.searchField = "name";

  const normalizedName = normalizeText(item.name ?? "");
  if (!item.searchName || item.searchName !== normalizedName) {
    patch.searchName = normalizedName;
  }

  const stock = Number(item.stock ?? 0);
  const status = deriveStatus(stock);
  if (!item.status || item.status !== status) {
    patch.status = status;
  }

  const timestamp = item.updatedAt ?? item.createdAt ?? new Date().toISOString();
  if (!item.updatedAt) patch.updatedAt = timestamp;
  if (!item.createdAt) patch.createdAt = timestamp;
  if (item.originalPrice == null && item.price != null) patch.originalPrice = item.price;
  if (!item.version || Number(item.version) < 1) patch.version = 1;

  return patch;
}

let lastKey;
let scanned = 0;
let updated = 0;

do {
  const result = await rawDb.send(new ScanCommand({
    TableName,
    ExclusiveStartKey: lastKey
  }));

  for (const rawItem of result.Items ?? []) {
    const item = unmarshall(rawItem) as Record<string, any>;
    scanned += 1;

    if (!isProductItem(item)) continue;

    const patch = buildPatch(item);
    const entries = Object.entries(patch);
    if (entries.length === 0) continue;

    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};
    const setters: string[] = [];

    for (const [field, value] of entries) {
      expressionAttributeNames[`#${field}`] = field;
      expressionAttributeValues[`:${field}`] = value;
      setters.push(`#${field} = :${field}`);
    }

    await rawDb.send(new UpdateItemCommand({
      TableName,
      Key: marshall({ PK: item.PK, SK: item.SK }),
      UpdateExpression: `SET ${setters.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: marshall(expressionAttributeValues)
    }));

    updated += 1;
  }

  lastKey = result.LastEvaluatedKey;
} while (lastKey);

console.log(`Scanned ${scanned} items. Backfilled ${updated} product records.`);
