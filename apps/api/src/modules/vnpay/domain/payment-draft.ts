export class PaymentDraft {
    readonly #items: readonly Readonly<{ productId: string; quantity: number }>[];
    constructor(items: readonly {
        productId: string;
        quantity: number;
    }[]) {
        this.#items = Object.freeze(items.map(item => Object.freeze({ ...item })));
    }
    assertValidItems(): void { this.validatedQuantities(); }
    private validatedQuantities(): Map<string, number> {
        const items = this.#items;
        if (!items.length || items.length > 20)
            throw new Error("Invalid payment items");
        const quantities = new Map<string, number>();
        for (const item of items) {
            if (!item.productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1)
                throw new Error("Invalid payment item");
            const quantity = (quantities.get(item.productId) ?? 0) + item.quantity;
            if (quantity > 50)
                throw new Error("Invalid payment quantity");
            quantities.set(item.productId, quantity);
        }
        return quantities;
    }
    quantities() { return [...this.validatedQuantities()]; }
    lineAmount(id: string, product: {
        name?: string;
        price?: number;
        stock?: number;
    } | null, skipStockValidation = false) {
        if (!product)
            throw new Error(`Product ${id} not found`);
        const quantity = this.validatedQuantities().get(id);
        if (quantity === undefined)
            throw new Error("Invalid payment item");
        if (!skipStockValidation && Number(product.stock ?? 0) < quantity)
            throw new Error(`Insufficient stock for ${product.name}`);
        return Number(product.price ?? 0) * quantity;
    }
    amount(total: number, override?: number) {
        const amount = override ?? total;
        if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount * 100) || amount * 100 > 999999999999) {
            throw new Error("Payment amount must be a supported positive integer.");
        }
        return amount;
    }
    expiresAt(createdAt: Date, override?: string) {
        const expiresAt = override ? new Date(override) : new Date(createdAt.getTime() + 300000);
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= createdAt)
            throw new Error("Checkout reservation expired before payment creation.");
        return expiresAt;
    }
}
