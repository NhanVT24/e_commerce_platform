import { BusinessError } from "../../../common/domain/business-error.js";

export interface InventoryAlertDeliverySnapshot {
    eventId: string;
    attempts: number;
}

/** Delivery decisions only; durable lease ownership is enforced by the outbox. */
export class InventoryAlertDelivery {
    readonly #state: Readonly<InventoryAlertDeliverySnapshot>;

    constructor(snapshot: InventoryAlertDeliverySnapshot) {
        this.#state = Object.freeze({ ...snapshot });
    }

    toSnapshot(): InventoryAlertDeliverySnapshot { return { ...this.#state }; }

    assertValid(): void {
        if (!this.#state.eventId.trim() || !Number.isSafeInteger(this.#state.attempts) || this.#state.attempts < 0) {
            throw new BusinessError("INVALID_INPUT", "Invalid inventory alert delivery identity or attempts.");
        }
    }

    exhausted(maxAttempts: number): boolean {
        this.assertValid();
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
            throw new BusinessError("INVALID_INPUT", "Inventory alert attempt limit must be a positive safe integer.");
        }
        return this.#state.attempts >= maxAttempts;
    }

    nextRetryAt(now: number): string {
        this.assertValid();
        const delay = Math.min(900_000, 10_000 * 2 ** Math.min(Math.max(this.#state.attempts - 1, 0), 10));
        const next = new Date(now + delay);
        if (!Number.isFinite(now) || !Number.isFinite(next.getTime())) {
            throw new BusinessError("INVALID_INPUT", "Invalid inventory alert retry time.");
        }
        return next.toISOString();
    }
}
