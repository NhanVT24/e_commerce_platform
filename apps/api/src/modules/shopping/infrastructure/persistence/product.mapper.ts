import { Product, productEditableFields } from "../../domain/product.js";
import { deriveStockStatus as deriveStatus } from "../../domain/stock-policy.js";
import type { ProductRecord } from "../../product.types.js";
type ProductInput = ProductRecord;

export function normalizeText(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/Ä‘/g, "d");
}

export function toProductRecord(input: ProductInput, current: ProductRecord | null): ProductInput {
  const stock = input.stock ?? current?.stock ?? 0;
  const status = deriveStatus(stock);
  return {
    ...current,
    ...input,
    stock,
    status,
    searchField: input.searchField ?? current?.searchField ?? "name",
    searchName: normalizeText(input.name ?? current?.name ?? ""),
    originalPrice: input.originalPrice ?? current?.originalPrice ?? input.price ?? current?.price ?? 0
  };
}

export function toProduct(record: ProductRecord): Product {
  return new Product({
    ...Object.fromEntries(productEditableFields.filter(field => record[field] !== undefined).map(field => [field, record[field]])),
    id: String(record.id ?? ""), ownerId: String(record.ownerSub ?? ""),
    name: String(record.name ?? ""), sku: record.sku ? String(record.sku) : undefined,
    stock: Number(record.stock ?? 0), status: String(record.status ?? ""),
    version: Number(record.version ?? 0), soldCount: Number(record.soldCount ?? 0)
  });
}
