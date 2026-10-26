import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { emailConfig } from "../../config/email-config.js";
import { sesClient } from "./client.js";

type WeeklyRevenueSummary = {
  generatedAt: string;
  rangeStart: string;
  rangeEnd: string;
  currency: "VND";
  orderCount: number;
  totalRevenue: number;
  averageOrderValue: number;
  topProducts: Array<{
    productId: string;
    productName: string;
    quantity: number;
    revenue: number;
  }>;
  orders: Array<{
    id: string;
    customerEmail: string;
    totalAmount: number;
    createdAt: string;
    status: string;
  }>;
};

function assertReportMailConfigured() {
  if (!emailConfig.SES_FROM_EMAIL) {
    throw new Error("Missing SES_FROM_EMAIL configuration.");
  }

  if (!emailConfig.ADMIN_REPORT_EMAIL) {
    throw new Error("Missing ADMIN_REPORT_EMAIL configuration.");
  }
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND"
  }).format(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Ho_Chi_Minh"
    }).format(date);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeChartWidth(value: number, maxValue: number) {
  if (maxValue <= 0 || value <= 0) {
    return 0;
  }

  return Math.max(8, Math.round((value / maxValue) * 100));
}

function buildTopProductRows(summary: WeeklyRevenueSummary) {
  if (summary.topProducts.length === 0) {
    return `
      <tr>
        <td colspan="4" style="padding:16px;border-bottom:1px solid #e2e8f0;color:#64748b;text-align:center;">Chưa có sản phẩm nào phát sinh doanh thu trong kỳ báo cáo.</td>
      </tr>
    `;
  }

  return summary.topProducts.map((item, index) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;text-align:center;">${index + 1}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;">${escapeHtml(item.productName)}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#475569;text-align:center;">${item.quantity}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#ea580c;text-align:right;font-weight:700;">${escapeHtml(formatCurrency(item.revenue))}</td>
    </tr>
  `).join("");
}

function buildRecentOrderRows(summary: WeeklyRevenueSummary) {
  const recentOrders = summary.orders.slice(0, 5);
  if (recentOrders.length === 0) {
    return `
      <tr>
        <td colspan="4" style="padding:16px;border-bottom:1px solid #e2e8f0;color:#64748b;text-align:center;">Tuần này chưa có đơn hoàn tất.</td>
      </tr>
    `;
  }

  return recentOrders.map((order) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;">#${escapeHtml(order.id)}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#475569;">${escapeHtml(order.customerEmail)}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#475569;text-align:center;">${escapeHtml(formatDate(order.createdAt))}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#ea580c;text-align:right;font-weight:700;">${escapeHtml(formatCurrency(order.totalAmount))}</td>
    </tr>
  `).join("");
}

function buildProductRevenueChart(summary: WeeklyRevenueSummary) {
  if (summary.topProducts.length === 0) {
    return `
      <div style="margin-top:12px;padding:20px;border:1px dashed #cbd5e1;border-radius:20px;background:#f8fafc;color:#64748b;text-align:center;">
        Chưa có dữ liệu doanh thu theo sản phẩm trong kỳ này.
      </div>
    `;
  }

  const maxRevenue = Math.max(...summary.topProducts.map((item) => item.revenue), 0);

  return `
    <div style="margin-top:16px;padding:20px;border:1px solid #e2e8f0;border-radius:24px;background:linear-gradient(180deg,#f8fafc 0%,#ffffff 100%);">
      ${summary.topProducts.map((item, index) => {
        const width = normalizeChartWidth(item.revenue, maxRevenue);
        const palette = [
          "#0f766e",
          "#ea580c",
          "#2563eb",
          "#dc2626",
          "#7c3aed"
        ];
        const color = palette[index % palette.length];

        return `
          <div style="margin-bottom:${index === summary.topProducts.length - 1 ? 0 : 18}px;">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-end;margin-bottom:8px;">
              <div style="font-size:14px;font-weight:700;color:#0f172a;">${escapeHtml(item.productName)}</div>
              <div style="font-size:13px;color:#475569;white-space:nowrap;">${item.quantity} sản phẩm • ${escapeHtml(formatCurrency(item.revenue))}</div>
            </div>
            <div style="height:14px;border-radius:999px;background:#e2e8f0;overflow:hidden;">
              <div style="height:14px;width:${width}%;min-width:${width > 0 ? 24 : 0}px;border-radius:999px;background:${color};"></div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function buildWeeklyRevenueHtml(summary: WeeklyRevenueSummary) {
  return `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;">
        <div style="padding:28px 32px;background:linear-gradient(135deg,#0f766e,#0f172a);color:#ffffff;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;">NovaX Market Admin</div>
          <h1 style="margin:12px 0 8px;font-size:28px;line-height:1.3;">Báo cáo doanh thu tuần</h1>
          <p style="margin:0;font-size:14px;line-height:1.7;color:#ccfbf1;">
            Kỳ báo cáo từ <strong>${escapeHtml(formatDate(summary.rangeStart))}</strong> đến <strong>${escapeHtml(formatDate(summary.rangeEnd))}</strong>
          </p>
        </div>
        <div style="padding:32px;">
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">
            <div style="padding:20px;border:1px solid #cbd5e1;border-radius:20px;background:#f8fafc;">
              <div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Doanh thu</div>
              <div style="margin-top:8px;font-size:28px;font-weight:800;color:#0f766e;">${escapeHtml(formatCurrency(summary.totalRevenue))}</div>
            </div>
            <div style="padding:20px;border:1px solid #cbd5e1;border-radius:20px;background:#f8fafc;">
              <div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Số đơn hoàn tất</div>
              <div style="margin-top:8px;font-size:28px;font-weight:800;color:#0f172a;">${summary.orderCount}</div>
            </div>
            <div style="padding:20px;border:1px solid #cbd5e1;border-radius:20px;background:#f8fafc;">
              <div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Giá trị đơn TB</div>
              <div style="margin-top:8px;font-size:28px;font-weight:800;color:#ea580c;">${escapeHtml(formatCurrency(summary.averageOrderValue))}</div>
            </div>
          </div>

          <h2 style="margin:32px 0 12px;font-size:20px;color:#0f172a;">Biểu đồ doanh thu theo sản phẩm</h2>
          <p style="margin:0;font-size:14px;line-height:1.7;color:#475569;">
            Biểu đồ dưới đây thể hiện nhóm sản phẩm mang lại doanh thu cao nhất trong 7 ngày gần nhất.
          </p>
          ${buildProductRevenueChart(summary)}

          <h2 style="margin:32px 0 12px;font-size:20px;color:#0f172a;">Top 5 sản phẩm doanh thu cao</h2>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="padding:0 0 12px;text-align:center;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">#</th>
                <th style="padding:0 0 12px;text-align:left;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Sản phẩm</th>
                <th style="padding:0 0 12px;text-align:center;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">SL bán</th>
                <th style="padding:0 0 12px;text-align:right;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Doanh thu</th>
              </tr>
            </thead>
            <tbody>${buildTopProductRows(summary)}</tbody>
          </table>

          <h2 style="margin:32px 0 12px;font-size:20px;color:#0f172a;">5 đơn gần nhất trong kỳ</h2>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="padding:0 0 12px;text-align:left;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Mã đơn</th>
                <th style="padding:0 0 12px;text-align:left;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Khách hàng</th>
                <th style="padding:0 0 12px;text-align:center;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Thời gian</th>
                <th style="padding:0 0 12px;text-align:right;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Tổng tiền</th>
              </tr>
            </thead>
            <tbody>${buildRecentOrderRows(summary)}</tbody>
          </table>

          <p style="margin:24px 0 0;font-size:13px;line-height:1.7;color:#64748b;">
            Email này được tạo tự động lúc ${escapeHtml(formatDate(summary.generatedAt))} và gửi từ hệ thống báo cáo định kỳ của NovaX Market.
          </p>
        </div>
      </div>
    </div>
  `;
}

export async function sendWeeklyRevenueReportEmail(summary: WeeklyRevenueSummary) {
  assertReportMailConfigured();

  await sesClient.send(new SendEmailCommand({
    FromEmailAddress: emailConfig.SES_FROM_EMAIL,
    ReplyToAddresses: emailConfig.SES_REPLY_TO_EMAIL ? [emailConfig.SES_REPLY_TO_EMAIL] : undefined,
    Destination: {
      ToAddresses: [emailConfig.ADMIN_REPORT_EMAIL]
    },
    Content: {
      Simple: {
        Subject: {
          Data: `Báo cáo doanh thu tuần NovaX Market - ${new Date(summary.rangeEnd).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
          Charset: "UTF-8"
        },
        Body: {
          Html: {
            Data: buildWeeklyRevenueHtml(summary),
            Charset: "UTF-8"
          }
        }
      }
    }
  }));
}
