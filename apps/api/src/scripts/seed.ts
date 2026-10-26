import crypto from "node:crypto";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../config/database-config.js";
import { rawDb } from "../database/dynamodb/client.js";
import { createShoppingItem, listAllShoppingItems } from "../modules/shopping/shopping.repository.js";

const categories = ["Thoi trang", "Dien tu", "Gia dung", "Me va be", "Lam dep", "Bach hoa"] as const;
const brands = ["FlexWear", "SoundMax", "HomePro", "BabyNest", "PureSkin", "Daily Mart"] as const;
const locations = ["TP.HCM", "Ha Noi", "Da Nang", "Can Tho", "Binh Duong", "Hai Phong"] as const;
const fashionColors = ["Den", "Trang", "Xanh navy", "Kem"] as const;
const fashionSizes = ["S", "M", "L", "XL"] as const;
const materials = ["Cotton", "Jean", "Da PU", "Polyester"] as const;
const voltages = ["220V", "110V", "5V USB-C"] as const;
const ageRanges = ["0-6 thang", "6-12 thang", "1-3 tuoi", "3-6 tuoi"] as const;
const skinTypes = ["Da dau", "Da kho", "Da hon hop", "Moi loai da"] as const;
const categoryNamePrefixes: Record<string, string> = {
  "Thoi trang": "Ao",
  "Dien tu": "Tai nghe",
  "Gia dung": "Noi",
  "Me va be": "Ta",
  "Lam dep": "Serum",
  "Bach hoa": "Snack"
};

type SeedOptions = {
  products: number;
  customers: number;
  ordersPerCustomer: number;
  includeOrders: boolean;
  force: boolean;
};

type ProductSeedRecord = {
  id: string;
  name: string;
  category: string;
  brand: string;
  sku: string;
  stock: number;
  price: number;
  originalPrice: number;
  imageUrl: string;
  location: string;
  description: string;
  rating: number;
  soldCount: number;
  featured: boolean;
  createdAt: string;
  updatedAt: string;
};

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;

function toDynamoItem(item: Record<string, unknown>) {
  return marshall(item, { removeUndefinedValues: true });
}

function parseNumberFlag(name: string, fallback: number) {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  const value = Number(raw?.split("=")[1] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function buildOptions(): SeedOptions {
  return {
    products: parseNumberFlag("products", 500),
    customers: parseNumberFlag("customers", 25),
    ordersPerCustomer: parseNumberFlag("orders-per-customer", 8),
    includeOrders: hasFlag("include-orders"),
    force: hasFlag("force")
  };
}

function buildCategorySpecificAttributes(category: string, index: number) {
  if (category === "Thoi trang") {
    return {
      color: fashionColors[index % fashionColors.length],
      size: fashionSizes[index % fashionSizes.length],
      material: materials[index % materials.length]
    };
  }

  if (category === "Dien tu") {
    return {
      warrantyMonths: 12 + (index % 3) * 6,
      voltage: voltages[index % voltages.length],
      weightGrams: 150 + index * 5
    };
  }

  if (category === "Gia dung") {
    return {
      material: materials[index % materials.length],
      capacityLiters: Number((1.5 + (index % 12) * 0.75).toFixed(1))
    };
  }

  if (category === "Me va be") {
    return {
      ageRange: ageRanges[index % ageRanges.length],
      material: materials[index % materials.length]
    };
  }

  if (category === "Lam dep") {
    return {
      skinType: skinTypes[index % skinTypes.length],
      weightGrams: 50 + index * 2,
      expiryDate: `2027-${String((index % 12) + 1).padStart(2, "0")}-15`
    };
  }

  return {
    weightGrams: 200 + index * 3,
    expiryDate: `2027-${String((index % 12) + 1).padStart(2, "0")}-28`
  };
}

function buildProducts(count: number): ProductSeedRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const category = categories[index % categories.length];
    const brand = brands[index % brands.length];
    const stock = (index * 7) % 130;
    const price = 50000 + index * 1500;
    const updatedAt = new Date(Date.UTC(2026, 6, 30 - (index % 14), 8, index % 60, 0)).toISOString();

    return {
      id: crypto.randomUUID(),
      name: `${categoryNamePrefixes[category] ?? "San pham"} ${index + 1}`,
      category,
      brand,
      sku: `SKU-${String(index + 1).padStart(5, "0")}`,
      stock,
      price,
      originalPrice: price + 20000,
      imageUrl: "https://placehold.co/1200x1200/png?text=Items",
      location: locations[index % locations.length],
      description: `Mo ta ngan cho san pham ${index + 1} thuoc danh muc ${category}.`,
      rating: Number((4 + ((index % 10) / 10)).toFixed(1)),
      soldCount: 100 + index * 9,
      featured: index % 8 === 0,
      createdAt: updatedAt,
      updatedAt,
      ...buildCategorySpecificAttributes(category, index)
    };
  });
}

async function seedProducts(count: number) {
  const products = buildProducts(count);

  for (const product of products) {
    await createShoppingItem(product, "SYSTEM#SEED");
  }

  return products;
}

function buildOrderLines(products: ProductSeedRecord[], seedIndex: number) {
  const lineCount = 1 + (seedIndex % 3);
  const lines = Array.from({ length: lineCount }, (_, lineIndex) => {
    const product = products[(seedIndex * 3 + lineIndex) % products.length];
    const quantity = 1 + ((seedIndex + lineIndex) % 2);
    const price = Number(product.price);

    return {
      productId: product.id,
      productName: product.name,
      quantity,
      price,
      lineTotal: quantity * price
    };
  });

  return {
    items: lines,
    totalAmount: lines.reduce((sum, line) => sum + line.lineTotal, 0)
  };
}

async function putOrderWithNotifications(input: {
  email: string;
  products: ProductSeedRecord[];
  seedIndex: number;
}) {
  const now = new Date(Date.UTC(2026, 7, 1 + (input.seedIndex % 9), 3 + (input.seedIndex % 8), input.seedIndex % 60, 0)).toISOString();
  const orderId = crypto.randomUUID();
  const { items, totalAmount } = buildOrderLines(input.products, input.seedIndex);
  const status = input.seedIndex % 4 === 0 ? "pending" : "done";

  await rawDb.send(new PutItemCommand({
    TableName,
    Item: toDynamoItem({
      PK: `ORDER#${orderId}`,
      SK: "DETAIL",
      entityType: "ORDER",
      id: orderId,
      customerEmail: input.email,
      status,
      items,
      totalAmount,
      createdAt: now,
      updatedAt: now
    })
  }));

  const channels = ["system", "email"] as const;
  for (const channel of channels) {
    const notificationId = crypto.randomUUID();
    const notificationStatus = status === "done" ? "sent" : "pending";

    await rawDb.send(new PutItemCommand({
      TableName,
      Item: toDynamoItem({
        PK: `NOTIFICATION#${notificationId}`,
        SK: "DETAIL",
        entityType: "NOTIFICATION",
        id: notificationId,
        customerEmail: input.email,
        title: channel === "email" ? "Email xac nhan don hang" : "Thong bao xu ly don hang",
        message: channel === "email"
          ? `Email xac nhan cho don ${orderId} dang duoc mo phong trong test data.`
          : `Thong bao he thong cho don ${orderId} dang duoc mo phong trong test data.`,
        channel,
        status: notificationStatus,
        isRead: false,
        metadata: {
          orderId,
          template: channel === "email" ? "order-confirmation" : "system-order-update"
        },
        createdAt: now,
        updatedAt: now
      })
    }));
  }
}

async function seedOrders(customers: number, ordersPerCustomer: number, products: ProductSeedRecord[]) {
  let seedIndex = 0;

  for (let customerIndex = 0; customerIndex < customers; customerIndex += 1) {
    const email = `customer${String(customerIndex + 1).padStart(3, "0")}@example.com`;

    for (let orderIndex = 0; orderIndex < ordersPerCustomer; orderIndex += 1) {
      await putOrderWithNotifications({
        email,
        products,
        seedIndex
      });
      seedIndex += 1;
    }
  }

  return customers * ordersPerCustomer;
}

const options = buildOptions();
const existing = await listAllShoppingItems(1, 1);

if (!options.force && (existing.items ?? []).length > 0) {
  console.log("Products already exist. Skip seeding. Re-run with --force after resetting data if you want more.");
  process.exit(0);
}

const products = await seedProducts(options.products);
console.log(`Seeded ${products.length} sample products.`);

if (options.includeOrders) {
  const totalOrders = await seedOrders(options.customers, options.ordersPerCustomer, products);
  console.log(`Seeded ${totalOrders} sample orders with notifications.`);
}

console.log("Seed completed.", options);
