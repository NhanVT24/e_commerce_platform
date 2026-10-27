import { BusinessError } from "../../../common/domain/business-error.js";
import type { NewSaleCampaign, SaleCampaign } from "./campaign.js";
export class Campaign {
    readonly #state: Readonly<SaleCampaign>;
    constructor(snapshot: SaleCampaign) {
        this.#state = Object.freeze({ ...snapshot, productIds: [...snapshot.productIds] });
    }
    toSnapshot(): SaleCampaign { return { ...this.#state, productIds: [...this.#state.productIds] }; }
    static create(id: string, input: NewSaleCampaign, now: number): Campaign {
        Campaign.assertCreation(input, now);
        if (!id.trim() || !input.name.trim() || !Number.isFinite(input.discountPercent) ||
            input.discountPercent <= 0 || input.discountPercent > 100 || !input.productIds.length) {
            throw new BusinessError("INVALID_INPUT", "Invalid sale campaign.");
        }
        const timestamp = new Date(now).toISOString();
        return new Campaign({ ...input, id, campaignStatus: "scheduled", version: 1,
            startScheduleName: `sale-start-${id}`, endScheduleName: `sale-end-${id}`, createdAt: timestamp, updatedAt: timestamp });
    }
    withoutProduct(productId: string): Campaign {
        const change = this.removeProduct(productId);
        return new Campaign({ ...this.#state, productIds: change.productIds,
            campaignStatus: change.closed ? (change.expectedStatus === "active" ? "ended" : "cancelled") : change.expectedStatus });
    }
    cancel(): Campaign {
        if (this.#state.campaignStatus !== "scheduled") throw new BusinessError("CONFLICT", "Only scheduled sale campaigns can be cancelled.");
        return new Campaign({ ...this.#state, campaignStatus: "cancelled" });
    }
    afterScheduledEvent(action: string | undefined, now: number): Campaign | null {
        const transition = this.scheduledTransition(action, now);
        return transition ? new Campaign({ ...this.#state, campaignStatus: transition.to }) : null;
    }
    static assertCreation(input: NewSaleCampaign, now: number): void {
        const start = Date.parse(input.startAt), end = Date.parse(input.endAt);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start <= now + 60000 || end <= start) {
            throw new BusinessError("INVALID_INPUT", "Sale must start at least one minute from now and end after it starts.");
        }
    }
    removeProduct(productId: string) {
        const status = this.#state.campaignStatus;
        if (status !== "scheduled" && status !== "active") {
            throw new BusinessError("INVALID_INPUT", "Only scheduled or active sale campaigns can be changed.");
        }
        const productIds = this.#state.productIds.filter(id => id !== productId);
        return { expectedStatus: status, productIds, alreadyAbsent: !this.#state.productIds.includes(productId), closed: productIds.length === 0 };
    }
    scheduledTransition(action: string | undefined, now: number) {
        if (action === "start")
            return { from: "scheduled" as const, to: now >= Date.parse(this.#state.endAt) ? "ended" as const : "active" as const };
        if (action === "end")
            return { from: this.#state.campaignStatus === "scheduled" ? "scheduled" as const : "active" as const, to: "ended" as const };
        return null;
    }
}
