import { BusinessError } from "../../../common/domain/business-error.js";
export interface NewEmailRoute extends EmailRouteSnapshot {
    campaignId: string; batchIndex: number; batchCount: number; status: "PUBLISHING";
    eventSource: string; eventDetailType: string; eventDetail: Record<string, unknown>;
    createdAt: string; updatedAt: string;
}
export interface EmailRouteSnapshot {
    emailJobId: string;
    publishAttempts: number;
    eventSource?: string;
    eventDetailType?: string;
    eventDetail?: Record<string, unknown>;
}
export class EmailRoute<T extends EmailRouteSnapshot = EmailRouteSnapshot> {
    readonly #state: Readonly<T>;
    constructor(snapshot: T) { this.#state = Object.freeze({ ...snapshot, eventDetail: snapshot.eventDetail ? structuredClone(snapshot.eventDetail) : undefined }); }
    get emailJobId() { return this.#state.emailJobId; }
    toSnapshot(): T { return { ...this.#state, eventDetail: this.#state.eventDetail ? structuredClone(this.#state.eventDetail) : undefined }; }
    static create(input: { emailJobId: string; campaignId: string; batchIndex: number; batchCount: number;
        event: { source: string; detailType: string; detail: Record<string, unknown> } }, now: number): EmailRoute<NewEmailRoute> {
        if (!input.emailJobId.trim() || !input.campaignId.trim() || !Number.isSafeInteger(input.batchIndex) || input.batchIndex < 0 ||
            !Number.isSafeInteger(input.batchCount) || input.batchCount < 1 || input.batchIndex >= input.batchCount ||
            !input.event.source || !input.event.detailType || !Number.isFinite(new Date(now).getTime())) {
            throw new BusinessError("INVALID_INPUT", "Invalid email route.");
        }
        const timestamp = new Date(now).toISOString();
        return new EmailRoute({ emailJobId: input.emailJobId, campaignId: input.campaignId,
            batchIndex: input.batchIndex, batchCount: input.batchCount, status: "PUBLISHING", publishAttempts: 1,
            eventSource: input.event.source, eventDetailType: input.event.detailType, eventDetail: input.event.detail,
            createdAt: timestamp, updatedAt: timestamp });
    }
    exhausted(maxAttempts: number) { return this.#state.publishAttempts >= maxAttempts; }
    get hasPublishPayload() { return Boolean(this.#state.eventSource && this.#state.eventDetailType && this.#state.eventDetail); }
}
