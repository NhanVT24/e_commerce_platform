import { SendInventoryReport } from "./application/send-inventory-report.js";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "../../common/application/application-error.js";
import { emailConfig } from "../../config/email-config.js";
import * as reports from "./inventory-report.repository.js";
import * as deliveries from "../email-deliveries/email-delivery.repository.js";
import { listInventoryReportProducts, markInventoryReportProductsAlerted } from "../shopping/shopping.repository.js";
import { getInventoryDigestSubject, sendInventoryDigestEmail } from "../../integrations/ses/inventory-report-mailer.js";
const useCase = new SendInventoryReport({
 newId: randomUUID,
 listInventoryReportProducts: async () => (await listInventoryReportProducts()).map(row => ({ id: row.id ?? "", name: row.name ?? "", sku: row.sku,
 stock: row.stock ?? 0, status: row.status ?? "active", updatedAt: row.updatedAt ?? "", inventoryAlertSent: Boolean(row.inventoryAlertSent) })),
 markInventoryReportProductsAlerted,
 createPendingInventoryReport: async input => { try { await reports.createPendingInventoryReport(input); } catch(error) {
 if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw new ApplicationError("CONFLICT", "Report already claimed"); throw error; } },
 markInventoryReportAccepted: reports.markInventoryReportAccepted, markInventoryReportFailed: reports.markInventoryReportFailed,
 createPendingEmailDelivery: deliveries.createPendingEmailDelivery, markEmailDeliveryAccepted: deliveries.markEmailDeliveryAccepted,
 markEmailDeliveryFailed: deliveries.markEmailDeliveryFailed, getInventoryDigestSubject, sendInventoryDigestEmail,
 warn: (event, details) => console.error(event, details)
}, { adminEmail: emailConfig.ADMIN_REPORT_EMAIL, senderEmail: emailConfig.SES_FROM_EMAIL });
export function sendDailyInventoryReport(referenceDate = new Date()) { return useCase.execute(referenceDate); }
