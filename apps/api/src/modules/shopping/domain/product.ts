import { ProductMutationError } from "./product.error.js";
export const productStatuses = ["active", "low_stock", "out_of_stock"] as const;
export type ProductStatus = typeof productStatuses[number];
export type ProductCounterField = "stock" | "soldCount";
export interface ProductActor {
    readonly subject: string;
    readonly isAdmin: boolean;
}
export interface ProductStockAlert {
    productId: string;
    productName: string;
    sku?: string;
    stock: number;
    previousStock: number;
    status: "low_stock" | "out_of_stock";
    previousStatus: string;
}
/** Business data needed by product updates, independent of storage/auth providers. */
export interface ProductSnapshot extends ProductChanges {
    readonly id: string;
    readonly ownerId: string;
    readonly name: string;
    readonly sku?: string;
    readonly stock: number;
    readonly status: string;
    readonly version: number;
}
/** Editable business fields. Persistence keys and operational metadata are excluded. */
export interface ProductChanges {
    name?: string;
    category?: string;
    brand?: string;
    sku?: string;
    stock?: number;
    price?: number;
    originalPrice?: number;
    imageUrl?: string;
    location?: string;
    description?: string;
    rating?: number;
    soldCount?: number;
    featured?: boolean;
    color?: string;
    size?: string;
    material?: string;
    warrantyMonths?: number;
    voltage?: string;
    capacityLiters?: number;
    ageRange?: string;
    skinType?: string;
    weightGrams?: number;
    expiryDate?: string;
}
// Both counter and write repositories now return the same rich entity.
export type ProductCounters = Product;
export type NewProductDetails = ProductChanges & Required<Pick<ProductChanges, "name" | "category" | "brand" | "sku" | "stock" | "price" | "imageUrl" | "location" | "description">>;
/** Immutable business entity. Repositories reconstruct it from a plain snapshot;
 * methods produce a new instance, leaving the authorized/versioned snapshot intact.
 * The version changes only after a successful conditional database write.
 */
export class Product {
    readonly #state: Readonly<ProductSnapshot>;
    constructor(snapshot: ProductSnapshot) {
        // Preserve the stored status so a stale projection can be repaired and can
        // still cause the same transition alert as before. Mutations derive it anew.
        this.#state = Object.freeze({ ...snapshot, soldCount: snapshot.soldCount ?? 0 });
    }
    get id() { return this.#state.id; }
    get ownerId() { return this.#state.ownerId; }
    get name() { return this.#state.name; }
    get sku() { return this.#state.sku; }
    get stock() { return this.#state.stock; }
    get soldCount() { return this.#state.soldCount ?? 0; }
    get status() { return this.#state.status; }
    get stockStatus(): ProductStatus { return Product.stockStatus(this.stock); }
    get version() { return this.#state.version; }
    toSnapshot(): ProductSnapshot { return { ...this.#state }; }
    /** Only the counters/version needed for safe writes, not a DTO schema check.
     * Rehydration is passive; creation/mutation paths opt into these invariants.
     */
    assertValidState(): void {
        if (!Number.isSafeInteger(this.stock) || this.stock < 0 ||
            !Number.isSafeInteger(this.soldCount) || this.soldCount < 0 ||
            !Number.isSafeInteger(this.version) || this.version < 0) {
            throw new ProductMutationError("INVALID_INPUT", "Invalid product snapshot");
        }
    }
    static create(id: string, ownerId: string, details: NewProductDetails): Product {
        Product.assertEditableStock(details.stock);
        const product = new Product({ ...details, id, ownerId, version: 1,
            rating: details.rating ?? 4.8, soldCount: details.soldCount ?? 0,
            featured: details.featured ?? false, status: Product.stockStatus(details.stock) });
        product.assertValidState();
        return product;
    }
    static stockStatus(stock: number): ProductStatus {
        // Historical legacy callers still classify non-positive stock as sold out.
        if (stock <= 0)
            return "out_of_stock";
        if (stock <= 10)
            return "low_stock";
        return "active";
    }
    static assertEditableStock(stock: number): void {
        if (!Number.isSafeInteger(stock) || stock < 0 || stock > 999999) {
            throw new ProductMutationError("INVALID_INPUT", "Invalid product stock");
        }
    }
    static counterAfterAdjustment(current: number, delta: number): number {
        if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(delta)) {
            throw new RangeError("Product counters require safe integers");
        }
        const next = current + delta;
        if (!Number.isSafeInteger(next))
            throw new RangeError("Product counter overflow");
        return Math.max(0, next);
    }
    assertCanBeManagedBy(actor: ProductActor): void {
        if (!actor.subject.trim())
            throw new ProductMutationError("INVALID_INPUT", "Invalid product actor");
        if (!actor.isAdmin && this.ownerId !== actor.subject) {
            throw new ProductMutationError("FORBIDDEN", "You can only modify products that you created.");
        }
    }
    assertVersion(expectedVersion: number): void {
        if (this.version !== expectedVersion) {
            throw new ProductMutationError("CONFLICT", "Record changed, missing, or condition failed");
        }
    }
    update(changes: ProductChanges): Product {
        this.assertValidState();
        this.assertVersionCanAdvance();
        if (changes.stock !== undefined)
            Product.assertEditableStock(changes.stock);
        const stock = changes.stock ?? this.stock;
        const next = new Product({ ...this.#state, ...changes, id: this.id, ownerId: this.ownerId,
            version: this.version, stock, status: Product.stockStatus(stock) });
        next.assertValidState();
        return next;
    }
    /** Administrative adjustment preserves the existing clamp-to-zero behavior.
     * This is not a checkout reservation, which must reject insufficient stock.
     */
    adjustCounter(field: ProductCounterField, delta: number): Product {
        this.assertValidState();
        this.assertVersionCanAdvance();
        if (field !== "stock" && field !== "soldCount") {
            throw new ProductMutationError("INVALID_INPUT", "Invalid product counter");
        }
        let next: number;
        try {
            next = Product.counterAfterAdjustment(this[field], delta);
        }
        catch (error) {
            if (error instanceof RangeError)
                throw new ProductMutationError("INVALID_INPUT", error.message);
            throw error;
        }
        const stock = field === "stock" ? next : this.stock;
        return new Product({ ...this.#state, [field]: next, status: Product.stockStatus(stock) });
    }
    increaseStock(quantity: number): Product {
        this.assertQuantity(quantity);
        return this.adjustCounter("stock", quantity);
    }
    decreaseStock(quantity: number): Product {
        this.assertQuantity(quantity);
        this.assertVersionCanAdvance();
        return this.changeInventory({ stock: -quantity, sold: 0 });
    }
    /** Stock/sales change used by checkout, cancellation and refund transactions.
     * Never clamps: an invalid transition must leave the transaction unbuilt.
     */
    changeInventory(delta: {
        stock: number;
        sold: number;
    }, reservedStock = 0): Product {
        this.assertValidState();
        const stock = this.stock + delta.stock, soldCount = this.soldCount + delta.sold;
        if (![delta.stock, delta.sold, stock, soldCount, reservedStock, this.version + 1].every(Number.isSafeInteger) ||
            stock < 0 || soldCount < 0 || reservedStock < 0 || stock < reservedStock) {
            throw new ProductMutationError("INVALID_INPUT", `Invalid inventory transition for ${this.id}`);
        }
        return new Product({ ...this.#state, stock, soldCount, status: Product.stockStatus(stock) });
    }
    stockAlertSince(previous: Product): ProductStockAlert | null {
        const status = this.status;
        if ((status !== "low_stock" && status !== "out_of_stock") || status === previous.status)
            return null;
        return { productId: this.id, productName: this.name, sku: this.sku, stock: this.stock,
            previousStock: previous.stock, status, previousStatus: previous.status };
    }
    private assertQuantity(quantity: number): void {
        if (!Number.isSafeInteger(quantity) || quantity < 0) {
            throw new ProductMutationError("INVALID_INPUT", "Product quantity must be a non-negative safe integer");
        }
    }
    private assertVersionCanAdvance(): void {
        if (!Number.isSafeInteger(this.version + 1)) {
            throw new ProductMutationError("INVALID_INPUT", "Product version overflow");
        }
    }
}
