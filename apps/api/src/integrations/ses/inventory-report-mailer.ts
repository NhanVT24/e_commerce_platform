import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { emailConfig } from "../../config/email-config.js";
import { sesTrackingTags } from "../../modules/email-deliveries/email-delivery.repository.js";
import type { InventoryReportProduct } from "../../modules/shopping/shopping.repository.js";
import { sesClient } from "./client.js";

type InventoryDigestInput = {
  emailId: string;
  reportId: string;
  reportDate: string;
  lowStockProducts: InventoryReportProduct[];
  outOfStockProducts: InventoryReportProduct[];
  // Used only by the SES simulator CLI. Scheduled production reports continue
  // to use ADMIN_REPORT_EMAIL.
  recipientEmail?: string;
};

export function getInventoryDigestSubject(reportDate: string) {
  return `Inventory Report - ${reportDate}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function buildRows(products: InventoryReportProduct[]) {
  if (products.length === 0) {
    return "<tr><td colspan=\"4\" style=\"padding:12px;color:#64748b;\">Khong co san pham.</td></tr>";
  }

  return products.map((product) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(product.name)}</td>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(product.sku ?? "-")}</td>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;">${product.stock}</td>
      <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(product.updatedAt || "-")}</td>
    </tr>
  `).join("");
}

function buildInventoryDigestHtml(input: InventoryDigestInput) {
  return `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
        <div style="padding:24px 28px;background:#0f766e;color:#ffffff;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">NovaX Market</div>
          <h1 style="margin:10px 0 0;font-size:24px;">Inventory Report</h1>
          <p style="margin:8px 0 0;color:#ccfbf1;">Date: ${escapeHtml(input.reportDate)}</p>
        </div>
        <div style="padding:28px;">
          <p style="margin:0 0 20px;line-height:1.6;">There are <strong>${input.outOfStockProducts.length}</strong> products out of stock and <strong>${input.lowStockProducts.length}</strong> products with low stock that need attention.</p>
          <h2 style="margin:24px 0 10px;color:#b91c1c;">Out of Stock (${input.outOfStockProducts.length})</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr><th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;">Product</th><th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;">SKU</th><th style="text-align:right;padding:10px;border-bottom:2px solid #e2e8f0;">Stock</th><th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;">Updated</th></tr></thead><tbody>${buildRows(input.outOfStockProducts)}</tbody></table>
          <h2 style="margin:28px 0 10px;color:#c2410c;">Low Stock (${input.lowStockProducts.length})</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr><th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;">Product</th><th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;">SKU</th><th style="text-align:right;padding:10px;border-bottom:2px solid #e2e8f0;">Stock</th><th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;">Updated</th></tr></thead><tbody>${buildRows(input.lowStockProducts)}</tbody></table>
        </div>
      </div>
    </div>
  `;
}

export async function sendInventoryDigestEmail(input: InventoryDigestInput) {
  if (!emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME) throw new Error("Missing SES feedback configuration set.");
  const recipientEmail = input.recipientEmail?.trim() || emailConfig.ADMIN_REPORT_EMAIL;
  if (!emailConfig.SES_FROM_EMAIL || !recipientEmail) {
    throw new Error("Missing SES_FROM_EMAIL or inventory report recipient configuration.");
  }

  const result = await sesClient.send(new SendEmailCommand({
    FromEmailAddress: emailConfig.SES_FROM_EMAIL,
    ReplyToAddresses: emailConfig.SES_REPLY_TO_EMAIL ? [emailConfig.SES_REPLY_TO_EMAIL] : undefined,
    Destination: { ToAddresses: [recipientEmail] },
    ConfigurationSetName: emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME,
    // SES copies these tags to SNS feedback events so the receiving Lambda can find this report.
    EmailTags: [
      ...sesTrackingTags({ emailId: input.emailId, recipientId: input.emailId, emailType: "inventory_daily_report" }),
      { Name: "reportId", Value: input.reportId },
      { Name: "reportType", Value: "daily-inventory" }
    ],
    Content: {
      Simple: {
        Subject: { Data: getInventoryDigestSubject(input.reportDate), Charset: "UTF-8" },
        Body: { Html: { Data: buildInventoryDigestHtml(input), Charset: "UTF-8" } }
      }
    }
  }));

  if (!result.MessageId) {
    throw new Error("SES accepted the inventory report without a MessageId.");
  }

  return result.MessageId;
}
