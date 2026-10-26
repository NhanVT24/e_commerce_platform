import { createProductRecord } from "./infrastructure/persistence/dynamo-product-creator.js";
import { incrementProductRecord } from "./infrastructure/persistence/dynamo-product-counter-repository.js";
import { deleteProductRecord } from "./infrastructure/persistence/dynamo-product-deleter.js";
import { normalizeText } from "./infrastructure/persistence/product.mapper.js";
import { updateProductRecord } from "./infrastructure/persistence/dynamo-product-write-repository.js";
import {
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../config/database-config.js";
import { rawDb } from "../../database/dynamodb/client.js";
import { keys } from "../../database/dynamodb/keys.js";
import { getMockShoppingItem, listMockShoppingItems } from "./shopping.mock.js";
import {
  buildProductCategoryIndexPartitionKey,
  isProductCategoryIndexRecord
} from "./indexes/product-category.index.js";
import type { ProductRecord } from "./product.types.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

type DynamoKey = Record<string, AttributeValue>;
type ShoppingFilters = {
  category?: string;
  status?: string;
  updatedAtFrom?: string;
  searchField?: "name" | "brand";
  search?: string;
  sortBy?: "price" | "stock" | "updatedAt";
  sortDirection?: "asc" | "desc";
};

export type InventoryReportProduct = Pick<ProductRecord,
  "id" | "name" | "sku" | "stock" | "status" | "updatedAt" | "inventoryAlertSent"
>;

function toDynamoItem(item: Record<string, unknown>) {
  return marshall(item, { removeUndefinedValues: true });
}

function fromDynamoItem(item?: Record<string, AttributeValue>) {
  return item ? (unmarshall(item) as ProductRecord) : null;
}

function isProductItem(item: ProductRecord | null): item is ProductRecord {
  if (!item) return false;
  if (item.entityType === "PRODUCT") return true;
  return String(item.PK ?? "").startsWith("PRODUCT#") && String(item.SK ?? "") === "DETAIL";
}

function encodeCursor(payload: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, any>;
}

function matchesFilters(item: ProductRecord | null, filters: ShoppingFilters = {}) {
  if (!isProductItem(item)) return false;
  if (
    filters.category &&
    filters.category !== "all" &&
    normalizeText(item.category) !== normalizeText(filters.category)
  ) return false;
  if (filters.status && item.status !== filters.status) return false;
  if (
    filters.updatedAtFrom &&
    String(item.updatedAt ?? item.createdAt ?? "") < String(filters.updatedAtFrom)
  ) return false;

  if (filters.search) {
    const search = normalizeText(filters.search);
    const searchField = filters.searchField ?? "name";
    if (searchField === "name") {
      const normalizedName = normalizeText(item.name);
      if (!normalizedName.startsWith(search)) return false;
    } else {
      const haystack = [item.brand]
        .filter(Boolean)
        .map(normalizeText)
        .join(" ");

      if (!haystack.includes(search)) return false;
    }
  }

  return true;
}

function sortItems(items: ProductRecord[], filters: ShoppingFilters = {}) {
  if (!filters.sortBy) {
    return [...items].sort((left, right) =>
      String(right?.updatedAt ?? right?.createdAt ?? "").localeCompare(
        String(left?.updatedAt ?? left?.createdAt ?? "")
      )
    );
  }

  const direction = filters.sortDirection === "asc" ? 1 : -1;
  const field = filters.sortBy;

  if (field === "updatedAt") {
    return [...items].sort((left, right) => {
      const leftValue = String(left?.updatedAt ?? left?.createdAt ?? "");
      const rightValue = String(right?.updatedAt ?? right?.createdAt ?? "");

      if (leftValue === rightValue) {
        return String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
      }

      return leftValue.localeCompare(rightValue) * direction;
    });
  }

  return [...items].sort((left, right) => {
    const leftValue = Number(left?.[field] ?? 0);
    const rightValue = Number(right?.[field] ?? 0);

    if (leftValue === rightValue) {
      return String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
    }

    return (leftValue - rightValue) * direction;
  });
}

async function listShoppingItemsBase(limit = 12, cursor?: string, filters: ShoppingFilters = {}) {
  let result;

  try {
    if (filters.category && filters.category !== "all") {
      result = await queryCategoryIndexUntilEnough(limit, cursor, filters);
    } else if (filters.status) {
      result = await queryStatusUpdatedAtWithSearchFilterUntilEnough(limit, cursor, filters);
    } else if (filters.search || filters.updatedAtFrom) {
      result = (filters.searchField ?? "name") === "brand" && filters.search
        ? await scanBrandSearchUntilEnough(limit, cursor, filters)
        : filters.search
          ? await querySearchUntilEnough(limit, cursor, filters)
          : await scanUntilEnough(limit, cursor, filters);
    } else {
      result = await scanUntilEnough(limit, cursor, filters);
    }
  } catch (error: any) {
    if (
      error?.name !== "ValidationException" &&
      error?.name !== "ResourceNotFoundException"
    ) {
      throw error;
    }

    result = (filters.searchField ?? "name") === "brand" && filters.search
      ? await scanBrandSearchUntilEnough(limit, cursor, filters)
      : await scanUntilEnough(limit, cursor, filters);
  }

  return {
    items: result.items,
    limit,
    cursor: cursor ?? null,
    nextCursor: result.nextCursor,
    hasNextPage: Boolean(result.nextCursor)
  };
}

async function scanUntilEnough(limit: number, cursor?: string, filters: ShoppingFilters = {}) {
  const results: ProductRecord[] = [];
  let state = cursor ? decodeCursor(cursor) : { lastKey: null as DynamoKey | null };

  while (results.length < limit) {
    const missingItems = Math.max(0, limit - results.length);
    if (missingItems === 0) {
      return {
        items: results,
        nextCursor: state.lastKey ? encodeCursor({ lastKey: state.lastKey }) : null
      };
    }

    const result = await rawDb.send(new ScanCommand({
      TableName,
      Limit: missingItems,
      ExclusiveStartKey: state.lastKey ?? undefined
    }));

    for (const rawItem of result.Items ?? []) {
      const item = fromDynamoItem(rawItem);
      if (!matchesFilters(item, filters)) continue;

      results.push(item as ProductRecord);
      if (results.length === limit) {
        return {
          items: results,
          nextCursor: result.LastEvaluatedKey
            ? encodeCursor({ lastKey: result.LastEvaluatedKey })
            : null
        };
      }
    }

    state = { lastKey: result.LastEvaluatedKey ?? null };

    if (!result.LastEvaluatedKey) {
      return { items: results, nextCursor: null };
    }
  }

  return { items: results, nextCursor: null };
}

async function queryCategoryIndexUntilEnough(limit: number, cursor?: string, filters: ShoppingFilters = {}) {
  if (!filters.category || filters.category === "all") {
    return scanUntilEnough(limit, cursor, filters);
  }

  const results: ProductRecord[] = [];
  let state = cursor ? decodeCursor(cursor) : { lastKey: null as DynamoKey | null };

  while (results.length < limit) {
    const missingItems = Math.max(0, limit - results.length);
    if (missingItems === 0) {
      return {
        items: results,
        nextCursor: state.lastKey ? encodeCursor({ lastKey: state.lastKey }) : null
      };
    }

    const result = await rawDb.send(new QueryCommand({
      TableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: toDynamoItem({
        ":pk": buildProductCategoryIndexPartitionKey(filters.category)
      }),
      ScanIndexForward: false,
      Limit: missingItems,
      ExclusiveStartKey: state.lastKey ?? undefined
    }));

    for (const rawItem of result.Items ?? []) {
      const indexItem = unmarshall(rawItem) as Record<string, unknown>;
      if (!isProductCategoryIndexRecord(indexItem)) continue;
      if (!matchesFilters(indexItem.product, filters)) continue;

      results.push(indexItem.product);
      if (results.length === limit) {
        return {
          items: results,
          nextCursor: result.LastEvaluatedKey
            ? encodeCursor({ lastKey: result.LastEvaluatedKey })
            : null
        };
      }
    }

    state = { lastKey: result.LastEvaluatedKey ?? null };

    if (!result.LastEvaluatedKey) {
      return { items: results, nextCursor: null };
    }
  }

  return { items: results, nextCursor: null };
}

async function scanBrandSearchUntilEnough(limit: number, cursor?: string, filters: ShoppingFilters = {}) {
  const results: ProductRecord[] = [];
  let state = cursor ? decodeCursor(cursor) : { lastKey: null as DynamoKey | null };

  while (results.length < limit) {
    const missingItems = Math.max(0, limit - results.length);
    if (missingItems === 0) {
      return {
        items: results,
        nextCursor: state.lastKey ? encodeCursor({ lastKey: state.lastKey }) : null
      };
    }

    const result = await rawDb.send(new ScanCommand({
      TableName,
      FilterExpression: "contains(#brand, :brandValue)",
      ExpressionAttributeNames: { "#brand": "brand" },
      ExpressionAttributeValues: toDynamoItem({
        ":brandValue": String(filters.search ?? "").trim()
      }),
      Limit: missingItems,
      ExclusiveStartKey: state.lastKey ?? undefined
    }));

    for (const rawItem of result.Items ?? []) {
      const item = fromDynamoItem(rawItem);
      if (!matchesFilters(item, filters)) continue;

      results.push(item as ProductRecord);
      if (results.length === limit) {
        return {
          items: results,
          nextCursor: result.LastEvaluatedKey
            ? encodeCursor({ lastKey: result.LastEvaluatedKey })
            : null
        };
      }
    }

    state = { lastKey: result.LastEvaluatedKey ?? null };

    if (!result.LastEvaluatedKey) {
      return { items: results, nextCursor: null };
    }
  }

  return { items: results, nextCursor: null };
}

async function queryStatusUpdatedAtWithSearchFilterUntilEnough(limit: number, cursor?: string, filters: ShoppingFilters = {}) {
  if (!filters.status) {
    if ((filters.searchField ?? "name") === "brand" && filters.search) {
      return scanBrandSearchUntilEnough(limit, cursor, filters);
    }
    if (filters.search) {
      return querySearchUntilEnough(limit, cursor, filters);
    }
    return scanUntilEnough(limit, cursor, filters);
  }

  const results: ProductRecord[] = [];
  const search = filters.search ? normalizeText(filters.search) : null;
  let state = cursor ? decodeCursor(cursor) : { lastKey: null as DynamoKey | null };

  while (results.length < limit) {
    const missingItems = Math.max(0, limit - results.length);
    if (missingItems === 0) {
      return {
        items: results,
        nextCursor: state.lastKey ? encodeCursor({ lastKey: state.lastKey }) : null
      };
    }

    const result = await rawDb.send(new QueryCommand({
      TableName,
      IndexName: "StatusTimelineIndex",
      KeyConditionExpression: "#status = :statusKey AND #updatedAt >= :updatedAtFrom",
      ExpressionAttributeNames: {
        "#status": "status",
        "#updatedAt": "updatedAt",
        "#searchName": "searchName"
      },
      ExpressionAttributeValues: toDynamoItem({
        ":statusKey": filters.status,
        ":updatedAtFrom": filters.updatedAtFrom,
        ":searchPrefix": search
      }),
      FilterExpression: "begins_with(#searchName, :searchPrefix)",
      ScanIndexForward: false,
      Limit: missingItems,
      ExclusiveStartKey: state.lastKey ?? undefined
    }));

    for (const rawItem of result.Items ?? []) {
      const item = fromDynamoItem(rawItem);
      if (!matchesFilters(item, filters)) continue;

      results.push(item as ProductRecord);
      if (results.length === limit) {
        return {
          items: results,
          nextCursor: result.LastEvaluatedKey
            ? encodeCursor({ lastKey: result.LastEvaluatedKey })
            : null
        };
      }
    }

    state = { lastKey: result.LastEvaluatedKey ?? null };

    if (!result.LastEvaluatedKey) {
      return { items: results, nextCursor: null };
    }
  }

  return { items: results, nextCursor: null };
}

async function querySearchUntilEnough(limit: number, cursor?: string, filters: ShoppingFilters = {}) {
  if ((filters.searchField ?? "name") === "brand") {
    return scanBrandSearchUntilEnough(limit, cursor, filters);
  }

  const results: ProductRecord[] = [];
  const search = normalizeText(filters.search);
  let state = cursor ? decodeCursor(cursor) : { lastKey: null as DynamoKey | null };

  while (results.length < limit) {
    const missingItems = Math.max(0, limit - results.length);
    if (missingItems === 0) {
      return {
        items: results,
        nextCursor: state.lastKey ? encodeCursor({ lastKey: state.lastKey }) : null
      };
    }

    const result = await rawDb.send(new QueryCommand({
      TableName,
      IndexName: "SearchNameIndex",
      KeyConditionExpression: "searchField = :fieldName AND begins_with(searchName, :searchPrefix)",
      ExpressionAttributeValues: toDynamoItem({
        ":fieldName": "name",
        ":searchPrefix": search
      }),
      Limit: missingItems,
      ExclusiveStartKey: state.lastKey ?? undefined
    }));

    for (const rawItem of result.Items ?? []) {
      const item = fromDynamoItem(rawItem);
      if (!matchesFilters(item, filters)) continue;

      results.push(item as ProductRecord);
      if (results.length === limit) {
        return {
          items: results,
          nextCursor: result.LastEvaluatedKey
            ? encodeCursor({ lastKey: result.LastEvaluatedKey })
            : null
        };
      }
    }

    state = { lastKey: result.LastEvaluatedKey ?? null };

    if (!result.LastEvaluatedKey) {
      return { items: results, nextCursor: null };
    }
  }

  return { items: results, nextCursor: null };
}

// Compatibility for seed scripts; HTTP mutations use application use cases.
export async function createShoppingItem(input: ProductRecord, ownerSub: string) {
  return createProductRecord(input, ownerSub);
}

export async function getShoppingItem(id: string) {
  const result = await rawDb.send(new GetItemCommand({
    TableName,
    Key: toDynamoItem(keys.product(id)),
    ConsistentRead: true
  }));

  return fromDynamoItem(result.Item);
}

export async function incrementItemValue(id: string, field: string, incrementBy = 1, expectedOwnerSub?: string) {
  return incrementProductRecord(id, field, incrementBy, expectedOwnerSub);
}

export async function listShoppingItems(limit = 12, cursor?: string, filters: ShoppingFilters = {}) {
  if (filters.sortBy) {
    const targetCursor = cursor ? decodeCursor(cursor) : { offset: 0 };
    const sorted = sortItems((await listAllShoppingItemsBase(100, 100, {
      ...filters,
      sortBy: undefined,
      sortDirection: undefined
    })).items, filters);
    const offset = Math.max(0, Number(targetCursor.offset) || 0);
    const items = sorted.slice(offset, offset + limit);
    const nextOffset = offset + items.length;

    return {
      items,
      limit,
      cursor: cursor ?? null,
      nextCursor: nextOffset < sorted.length ? encodeCursor({ offset: nextOffset }) : null,
      hasNextPage: nextOffset < sorted.length
    };
  }

  const baseResult = await listShoppingItemsBase(limit, cursor, filters);
  if (!cursor) {
    return { ...baseResult, items: sortItems(baseResult.items, {}) };
  }

  return baseResult;
}

/** Calculates the cursor state needed to open a requested page of shopping items. */
export async function getShoppingItemsPageCursor(page = 1, limit = 12, filters: ShoppingFilters = {}) {
  if (filters.sortBy) {
    const targetPage = Math.max(1, Number(page) || 1);
    const pageSize = Math.max(1, Number(limit) || 12);
    const sorted = sortItems((await listAllShoppingItemsBase(100, 100, {
      ...filters,
      sortBy: undefined,
      sortDirection: undefined
    })).items, filters);
    const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
    const resolvedPage = Math.min(targetPage, totalPages);
    const resolvedOffset = (resolvedPage - 1) * pageSize;
    const cursorHistory = Array.from({ length: resolvedPage }, (_, index) =>
      index === 0 ? null : encodeCursor({ offset: index * pageSize })
    );

    return {
      page: resolvedPage,
      requestedPage: targetPage,
      cursor: resolvedOffset > 0 ? encodeCursor({ offset: resolvedOffset }) : null,
      cursorHistory,
      hasNextPage: resolvedOffset + pageSize < sorted.length,
      nextCursor: resolvedOffset + pageSize < sorted.length
        ? encodeCursor({ offset: resolvedOffset + pageSize })
        : null,
      reachedEnd: resolvedPage < targetPage
    };
  }

  const targetPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.max(1, Number(limit) || 12);
  const cursorHistory = [null];
  let currentCursor: string | null = null;
  let currentPage = 1;
  let result = await listShoppingItems(pageSize, currentCursor ?? undefined, filters);

  while (currentPage < targetPage && result.nextCursor) {
    currentCursor = result.nextCursor;
    cursorHistory.push(currentCursor);
    currentPage += 1;
    result = await listShoppingItems(pageSize, currentCursor, filters);
  }

  return {
    page: currentPage,
    requestedPage: targetPage,
    cursor: cursorHistory[currentPage - 1] ?? null,
    cursorHistory,
    hasNextPage: Boolean(result.nextCursor),
    nextCursor: result.nextCursor ?? null,
    reachedEnd: currentPage < targetPage
  };
}

export { getMockShoppingItem, listMockShoppingItems };

/** Lists shopping items across multiple DynamoDB pages, up to the configured safety limit. */
export async function listAllShoppingItems(pageLimit = 50, maxPages = 20, filters: ShoppingFilters = {}) {
  if (filters.sortBy) {
    const unsorted = await listAllShoppingItemsBase(pageLimit, maxPages, {
      ...filters,
      sortBy: undefined,
      sortDirection: undefined
    });

    return {
      items: sortItems(unsorted.items, filters),
      nextCursor: unsorted.nextCursor ?? null,
      stoppedByMaxPages: unsorted.stoppedByMaxPages
    };
  }

  const base = await listAllShoppingItemsBase(pageLimit, maxPages, filters);
  return { ...base, items: sortItems(base.items, {}) };
}

export async function listInventoryReportProducts(): Promise<InventoryReportProduct[]> {
  const products: InventoryReportProduct[] = [];

  // Each status has its own partition in StatusTimelineIndex, so this avoids a table Scan.
  for (const status of ["out_of_stock", "low_stock"] as const) {
    let lastKey: DynamoKey | undefined;

    do {
      const result = await rawDb.send(new QueryCommand({
        TableName,
        IndexName: "StatusTimelineIndex",
        KeyConditionExpression: "#status = :status",
        ExpressionAttributeNames: {
          "#status": "status"
        },
        ExpressionAttributeValues: toDynamoItem({
          ":status": status
        }),
        ScanIndexForward: true,
        ExclusiveStartKey: lastKey
      }));

      products.push(...(result.Items ?? [])
        .map((item) => fromDynamoItem(item))
        .filter(isProductItem)
        .filter((item) => item?.inventoryAlertSent !== true)
        .map((item) => ({
          id: String(item?.id ?? ""),
          name: String(item?.name ?? ""),
          sku: item?.sku ? String(item.sku) : undefined,
          stock: Number(item?.stock ?? 0),
          status: item.status ?? status,
          updatedAt: String(item?.updatedAt ?? item?.createdAt ?? ""),
          inventoryAlertSent: item?.inventoryAlertSent === true
        })));

      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  }

  return products;
}

export async function markInventoryReportProductsAlerted(products: InventoryReportProduct[]) {
  let markedCount = 0;

  for (const product of products) {
    try {
      await rawDb.send(new UpdateItemCommand({
        TableName,
        Key: toDynamoItem(keys.product(product.id)),
        // Do not mark a product as alerted if its inventory changed after the
        // digest snapshot was created. It must remain eligible for the next run.
        ConditionExpression: "attribute_exists(PK) AND #stock = :stock AND #status = :status AND (attribute_not_exists(#inventoryAlertSent) OR #inventoryAlertSent = :false)",
        UpdateExpression: "SET #inventoryAlertSent = :true, inventoryAlertSentAt = :alertedAt",
        ExpressionAttributeNames: {
          "#stock": "stock",
          "#status": "status",
          "#inventoryAlertSent": "inventoryAlertSent"
        },
        ExpressionAttributeValues: toDynamoItem({
          ":stock": product.stock,
          ":status": product.status,
          ":false": false,
          ":true": true,
          ":alertedAt": new Date().toISOString()
        })
      }));
      markedCount += 1;
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
  }

  return markedCount;
}

async function listAllShoppingItemsBase(pageLimit = 50, maxPages = 20, filters: ShoppingFilters = {}) {
  const allItems: ProductRecord[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    const result = await listShoppingItemsBase(pageLimit, cursor, filters);
    allItems.push(...result.items);
    cursor = result.nextCursor ?? undefined;
    page += 1;
  } while (cursor && page < maxPages);

  return {
    items: allItems,
    nextCursor: cursor ?? null,
    stoppedByMaxPages: Boolean(cursor)
  };
}

// Compatibility entry point for maintenance scripts; the HTTP update uses
// UpdateProduct and the typed adapter. Keep one implementation of the transaction.
export async function updateShoppingItem(id: string, patch: ProductRecord, version: number, expectedOwnerSub?: string) {
  return updateProductRecord(id, patch, version, expectedOwnerSub);
}

// Compatibility for reseed scripts and audit callers.
export async function deleteShoppingItem(id: string, expectedOwnerSub?: string) {
  return deleteProductRecord(id, expectedOwnerSub);
}
