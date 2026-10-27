import { InventoryReport, InventoryReportDelivery } from "../domain/inventory-report.js";
import { EmailDelivery, type PendingEmailMeta, type PendingEmailRecipient } from "../../email-deliveries/domain/email-delivery.js";
import { ApplicationError } from "../../../common/application/application-error.js";
import type { ProductStatus } from "../../shopping/domain/product.js";
export interface DigestProduct {
    id: string;
    name: string;
    sku?: string;
    stock: number;
    status: ProductStatus;
    updatedAt: string;
    inventoryAlertSent: boolean;
}
export interface InventoryReportPorts {
    newId(): string;
    listInventoryReportProducts(): Promise<DigestProduct[]>;
    markInventoryReportProductsAlerted(products: DigestProduct[]): Promise<number>;
    createPendingInventoryReport(report: InventoryReportDelivery): Promise<void>;
    markInventoryReportAccepted(id: string, message: string): Promise<boolean>;
    markInventoryReportFailed(id: string, reason: string): Promise<void>;
    createPendingEmailDelivery(entity: EmailDelivery<PendingEmailMeta, PendingEmailRecipient>): Promise<{
        id: string;
    }>;
    markEmailDeliveryAccepted(id: string, message: string): Promise<boolean>;
    markEmailDeliveryFailed(id: string, reason: string): Promise<void>;
    getInventoryDigestSubject(date: string): string;
    sendInventoryDigestEmail(input: {
        emailId: string;
        reportId: string;
        reportDate: string;
        lowStockProducts: DigestProduct[];
        outOfStockProducts: DigestProduct[];
    }): Promise<string>;
    warn(event: string, details: Record<string, unknown>): void;
}
export class SendInventoryReport {
    constructor(private readonly ports: InventoryReportPorts, private readonly config: {
        adminEmail?: string;
        senderEmail?: string;
    }) { }
    async execute(referenceDate = new Date()) {
        if (!this.config.adminEmail) {
            throw new Error("Missing ADMIN_REPORT_EMAIL configuration.");
        }
        const report = new InventoryReport(referenceDate);
        const reportDate = report.reportDate;
        if (!report.isScheduled) {
            return { sent: false, reason: "not_scheduled_report_date" as const, reportDate };
        }
        const products = await this.ports.listInventoryReportProducts();
        if (products.length === 0) {
            return { sent: false, reason: "no_low_or_out_of_stock_products" as const };
        }
        const reportId = report.id;
        const { lowStockProducts, outOfStockProducts } = report.classify(products);
        try {
            await this.ports.createPendingInventoryReport(InventoryReportDelivery.create(report, this.config.adminEmail,
                lowStockProducts.length, outOfStockProducts.length, Date.now()));
        }
        catch (error) {
            if (error instanceof ApplicationError && error.code === "CONFLICT") {
                return { sent: false, reason: "report_already_created" as const, reportId };
            }
            throw error;
        }
        const email = await this.ports.createPendingEmailDelivery(EmailDelivery.createSingle({
            emailType: "inventory_daily_report",
            recipientEmail: this.config.adminEmail,
            senderEmail: this.config.senderEmail ?? "",
            subject: this.ports.getInventoryDigestSubject(reportDate),
            reportId
        }, this.ports.newId, Date.now()));
        let sesMessageId: string;
        try {
            sesMessageId = await this.ports.sendInventoryDigestEmail({
                emailId: email.id,
                reportId,
                reportDate,
                lowStockProducts,
                outOfStockProducts
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown SES send failure";
            await Promise.all([this.ports.markInventoryReportFailed(reportId, message), this.ports.markEmailDeliveryFailed(email.id, message)]);
            // Daily inventory mail is intentionally not retried immediately; the next scheduled run re-evaluates stock.
            return { sent: false, reason: "ses_send_failed" as const, reportId };
        }
        await Promise.all([
            this.ports.markInventoryReportAccepted(reportId, sesMessageId),
            this.ports.markEmailDeliveryAccepted(email.id, sesMessageId)
        ]);
        try {
            const alertedProductCount = await this.ports.markInventoryReportProductsAlerted(products);
            return { sent: true, reportId, sesMessageId, productCount: products.length, alertedProductCount };
        }
        catch (error) {
            this.ports.warn("inventory-report.alert_state_update_failed", {
                reportId,
                error: error instanceof Error ? error.message : "Unknown alert state update failure"
            });
            return { sent: true, reportId, sesMessageId, productCount: products.length, alertedProductCount: 0 };
        }
    }
}
