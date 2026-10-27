export class OrderActionError extends Error {
    constructor(readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT", message: string) {
        super(message);
        this.name = "OrderActionError";
    }
}
export class InsufficientOrderStock extends OrderActionError {
    constructor(message: string) { super("CONFLICT", message); this.name = "InsufficientOrderStock"; }
}
