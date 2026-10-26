import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { awsConfig } from "../../../config/aws-config.js";
import { operationsConfig } from "../../../config/operations-config.js";
import { ApplicationError } from "../../../common/application/application-error.js";
import * as repository from "../sales.repository.js";
import { getShoppingItem } from "../../shopping/shopping.repository.js";
import type { CampaignStore, CampaignSchedules } from "../application/campaigns.js";
function toAtExpression(value: string) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(value)).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
    return `at(${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second})`;
}
const client = new SchedulerClient({ region: awsConfig.AWS_REGION });
async function conditional<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    }
    catch (error) {
        if ((error as {
            name?: string;
        }).name === "ConditionalCheckFailedException")
            throw new ApplicationError("CONFLICT", "Sale campaign changed at the same time. Please retry.");
        throw error;
    }
}
export const campaignStore: CampaignStore = {
    listSaleCampaigns: repository.listSaleCampaigns, listActiveSaleCampaigns: repository.listActiveSaleCampaigns,
    getSaleCampaign: repository.getSaleCampaign, createSaleCampaign: repository.createSaleCampaign,
    cancelSaleCampaign: id => conditional(() => repository.cancelSaleCampaign(id)),
    transitionSaleCampaign: (id, from, to) => conditional(() => repository.transitionSaleCampaign(id, from, to)),
    closeSaleCampaignBecauseEmpty: input => conditional(() => repository.closeSaleCampaignBecauseEmpty(input)),
    updateSaleCampaignProducts: input => conditional(() => repository.updateSaleCampaignProducts(input))
};
export const campaignProducts = { find: getShoppingItem };
export class AwsCampaignSchedules implements CampaignSchedules {
    assertReady() { if (!operationsConfig.SALE_SCHEDULER_ROLE_ARN || !operationsConfig.SALE_SCHEDULER_TARGET_ARN)
        throw new ApplicationError("NOT_CONFIGURED", "Sale Scheduler is not configured."); }
    async create(campaignId: string, action: "start" | "end", at: string, name: string) {
        await client.send(new CreateScheduleCommand({ Name: name, GroupName: operationsConfig.SALE_SCHEDULER_GROUP_NAME,
            ScheduleExpression: toAtExpression(at), ScheduleExpressionTimezone: "Asia/Ho_Chi_Minh", FlexibleTimeWindow: { Mode: "OFF" },
            ActionAfterCompletion: "DELETE", Target: { Arn: operationsConfig.SALE_SCHEDULER_TARGET_ARN!, RoleArn: operationsConfig.SALE_SCHEDULER_ROLE_ARN!, Input: JSON.stringify({ campaignId, action }) } }));
    }
    async delete(name: string) { await client.send(new DeleteScheduleCommand({ Name: name, GroupName: operationsConfig.SALE_SCHEDULER_GROUP_NAME })); }
}
