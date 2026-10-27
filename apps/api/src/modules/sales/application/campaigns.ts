import { Campaign } from "../domain/sale-campaign.js";
import { ApplicationError } from "../../../common/application/application-error.js";
import type { SaleCampaign, SaleCampaignStatus, NewSaleCampaign } from "../domain/campaign.js";
export interface CampaignStore {
    listSaleCampaigns(): Promise<SaleCampaign[]>;
    listActiveSaleCampaigns(): Promise<SaleCampaign[]>;
    getSaleCampaign(id: string): Promise<SaleCampaign | null>;
    createSaleCampaign(campaign: Campaign): Promise<SaleCampaign>;
    cancelSaleCampaign(campaign: Campaign): Promise<void>;
    transitionSaleCampaign(campaign: Campaign, from: SaleCampaignStatus): Promise<void>;
    closeSaleCampaignBecauseEmpty(input: {
        campaign: Campaign;
        expectedStatus: "scheduled" | "active";
        expectedVersion: number;
    }): Promise<SaleCampaign | null>;
    updateSaleCampaignProducts(input: {
        campaign: Campaign;
        expectedStatus: "scheduled" | "active";
        expectedVersion: number;
    }): Promise<SaleCampaign | null>;
}
export interface CampaignProducts<TProduct> {
    find(id: string): Promise<TProduct | null>;
}
export interface CampaignSchedules {
    assertReady(): void;
    create(id: string, action: "start" | "end", at: string, name: string): Promise<void>;
    delete(name: string): Promise<void>;
}
const scheduleName = (id: string, action: "start" | "end") => `sale-${action}-${id}`;
function ignoreConflict(error: unknown) { if (!(error instanceof ApplicationError) || error.code !== "CONFLICT")
    throw error; }
export class SalesUseCases<TProduct> {
    constructor(private readonly campaigns: CampaignStore, private readonly products: CampaignProducts<TProduct>, private readonly schedules: CampaignSchedules, private readonly newId: () => string, private readonly now: () => number = Date.now) { }
    async list() { return this.campaigns.listSaleCampaigns(); }
    async listProducts(id: string) {
        const campaign = await this.campaigns.getSaleCampaign(id);
        if (!campaign)
            throw new ApplicationError("NOT_FOUND", "Sale campaign not found.");
        const results = await Promise.all(campaign.productIds.map((productId) => this.products.find(productId)));
        return {
            campaign,
            items: results.filter((product): product is NonNullable<typeof product> => Boolean(product))
        };
    }
    async create(input: NewSaleCampaign) {
        Campaign.assertCreation(input, this.now());
        for (const productId of input.productIds)
            if (!await this.products.find(productId))
                throw new ApplicationError("INVALID_INPUT", `Product ${productId} does not exist.`);
        this.schedules.assertReady();
        const id = this.newId();
        const startName = scheduleName(id, "start");
        const endName = scheduleName(id, "end");
        const entity = Campaign.create(id, input, this.now());
        const campaign = await this.campaigns.createSaleCampaign(entity);
        try {
            const scheduled = await Promise.allSettled([this.schedules.create(campaign.id, "start", input.startAt, startName), this.schedules.create(campaign.id, "end", input.endAt, endName)]);
            const rejected = scheduled.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (rejected)
                throw rejected.reason;
        }
        catch (error) {
            // Compensate for a partial Scheduler failure so a campaign cannot become active unexpectedly.
            await Promise.allSettled([this.schedules.delete(startName), this.schedules.delete(endName)]);
            await this.campaigns.cancelSaleCampaign(entity.cancel()).catch(() => undefined);
            throw error;
        }
        return campaign;
    }
    async cancel(id: string) {
        const campaign = await this.campaigns.getSaleCampaign(id);
        if (!campaign)
            throw new ApplicationError("NOT_FOUND", "Sale campaign not found.");
        const cancelled = new Campaign(campaign).cancel();
        await Promise.allSettled([this.schedules.delete(campaign.startScheduleName), this.schedules.delete(campaign.endScheduleName)]);
        await this.campaigns.cancelSaleCampaign(cancelled);
        return { success: true };
    }
    async removeProduct(id: string, productId: string) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const campaign = await this.campaigns.getSaleCampaign(id);
            if (!campaign)
                throw new ApplicationError("NOT_FOUND", "Sale campaign not found.");
            const change = new Campaign(campaign).removeProduct(productId);
            const next = new Campaign(campaign).withoutProduct(productId);
            if (change.alreadyAbsent) return { campaign, closed: change.closed };
            const remainingProductIds = change.productIds;
            try {
                if (remainingProductIds.length === 0) {
                    const closedCampaign = await this.campaigns.closeSaleCampaignBecauseEmpty({
                        campaign: next,
                        expectedStatus: change.expectedStatus,
                        expectedVersion: campaign.version
                    });
                    // The state is committed first; schedule deletion is cleanup and can safely be retried by AWS later.
                    await Promise.allSettled([this.schedules.delete(campaign.startScheduleName), this.schedules.delete(campaign.endScheduleName)]);
                    return { campaign: closedCampaign!, closed: true };
                }
                const updatedCampaign = await this.campaigns.updateSaleCampaignProducts({
                    campaign: next,
                    expectedStatus: change.expectedStatus,
                    expectedVersion: campaign.version,
                });
                return { campaign: updatedCampaign!, closed: false };
            }
            catch (error) {
                if (!(error instanceof ApplicationError) || error.code !== "CONFLICT")
                    throw error;
            }
        }
        throw new ApplicationError("CONFLICT", "Sale campaign changed at the same time. Please retry.");
    }
    async handleScheduleEvent(input: {
        campaignId?: string;
        action?: string;
    }) {
        const campaign = await this.campaigns.getSaleCampaign(String(input.campaignId ?? ""));
        if (!campaign)
            return { ignored: "campaign_not_found" };
        const checkedAt = this.now();
        const transition = new Campaign(campaign).scheduledTransition(input.action, checkedAt);
        if (!transition) return { ignored: "unknown_action" };
        const next = new Campaign(campaign).afterScheduledEvent(input.action, checkedAt)!;
        await this.campaigns.transitionSaleCampaign(next, transition.from).catch(ignoreConflict);
        return transition.to === "active" ? { active: true } : { ended: true };
    }
    async getActiveCampaigns() { return this.campaigns.listActiveSaleCampaigns(); }
}
