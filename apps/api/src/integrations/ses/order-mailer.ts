import { EmailDelivery } from "../../modules/email-deliveries/domain/email-delivery.js";
import { randomUUID as newDeliveryId } from "node:crypto";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import crypto from "node:crypto";
import { emailConfig } from "../../config/email-config.js";
import { httpConfig } from "../../config/http-config.js";
import {
  createPendingEmailDelivery,
  markEmailDeliveryAccepted,
  markEmailDeliveryFailed,
  sesTrackingTags,
  type EmailType
} from "../../modules/email-deliveries/email-delivery.repository.js";
import { sesClient } from "./client.js";
import { orderConfirmationContent, type OrderConfirmationInput } from "./order-confirmation-template.js";
import { ordersSenderEmail, replyToAddresses } from "./sender-config.js";

type SendPaymentFailureEmailInput = {
  toEmail: string;
  txnRef: string;
  totalAmount: number;
  orderInfo: string;
  failureReason: string;
  responseCode?: string;
  bankCode?: string;
  payDate?: string;
};

type SendOrderFailureEmailInput = {
  toEmail: string;
  requestId?: string;
  failureReason: string;
  items: Array<{
    productId: string;
    productName?: string;
    quantity: number;
  }>;
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND"
  }).format(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("vi-VN", { hour12: false });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function assertSesConfigured() {
  if (!ordersSenderEmail()) {
    throw new Error("Thiếu cấu hình SES_ORDERS_FROM_EMAIL hoặc SES_FROM_EMAIL.");
  }
}

async function sendTrackedOrderEmail(input: {
  emailType: Extract<EmailType, "order_confirmation" | "payment_failure" | "order_failure" | "refund_status">;
  toEmail: string;
  subject: string;
  html: string;
  text?: string;
  relatedId?: string;
  /** Stable only when this is a retryable, one-per-business-action email. */
  emailId?: string;
}) {
  assertSesConfigured();
  if (!emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME) throw new Error("Missing SES feedback configuration set.");
  let email: Awaited<ReturnType<typeof createPendingEmailDelivery>>;
  try {
    email = await createPendingEmailDelivery(EmailDelivery.createSingle({
      emailType: input.emailType,
      recipientEmail: input.toEmail,
      senderEmail: ordersSenderEmail() ?? "",
      subject: input.subject,
      relatedId: input.relatedId,
      emailId: input.emailId
    }, newDeliveryId, Date.now()));
  } catch (error) {
    // A stable id was already claimed by an earlier attempt. Never issue a
    // second SES request: the previous outcome is either durable or unknown.
    if (input.emailId && (error as { name?: string } | undefined)?.name === "TransactionCanceledException") {
      return { emailId: input.emailId, alreadyProcessed: true as const };
    }
    throw error;
  }

  try {
    const result = await sesClient.send(new SendEmailCommand({
      FromEmailAddress: ordersSenderEmail(),
      ReplyToAddresses: replyToAddresses(),
      Destination: { ToAddresses: [input.toEmail] },
      ...(emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME
        ? { ConfigurationSetName: emailConfig.SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME }
        : {}),
      EmailTags: sesTrackingTags({
        emailId: email.emailId,
        recipientId: email.recipientId,
        emailType: input.emailType
      }),
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: input.html, Charset: "UTF-8" },
            ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {})
          }
        }
      }
    }));
    if (!result.MessageId) throw new Error("SES accepted the email without a MessageId.");
    // Acceptance persistence is separate from sending. Never classify a DB
    // failure after SES accepted as a sending failure (or automatically resend).
    try {
      await markEmailDeliveryAccepted(email.id, result.MessageId);
    } catch (error) {
      console.error("[ses] acceptance_persistence_failed", { emailId: email.id, sesMessageId: result.MessageId });
      // The SES Send event also records acceptance and repairs this projection.
    }
    return { emailId: email.id, sesMessageId: result.MessageId };
  } catch (error) {
    await markEmailDeliveryFailed(email.id, error instanceof Error ? error.message : "Unknown SES send failure");
    throw error;
  }
}

function buildPaymentFailureHtml(input: SendPaymentFailureEmailInput) {
  const resolvedPayDate = input.payDate?.trim() ? formatDate(input.payDate) : "Chưa ghi nhận";
  const responseCode = input.responseCode?.trim() || "--";
  const bankCode = input.bankCode?.trim() || "--";

  return `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;">
        <div style="padding:28px 32px;background:linear-gradient(135deg,#f97316,#dc2626);color:#ffffff;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;">NovaX Market</div>
          <h1 style="margin:12px 0 0;font-size:28px;line-height:1.3;">Thanh toán chưa thành công</h1>
        </div>
        <div style="padding:32px;">
          <p style="margin:0 0 12px;font-size:16px;line-height:1.7;">Xin chào <strong>${escapeHtml(input.toEmail)}</strong>,</p>
          <p style="margin:0 0 20px;font-size:16px;line-height:1.7;">
            Hệ thống ghi nhận trạng thái giao dịch <strong>${escapeHtml(input.txnRef)}</strong> chưa hoàn tất trên VNPAY.
          </p>
          <div style="padding:20px;border-radius:20px;background:#fff1f2;border:1px solid #fda4af;">
            <p style="margin:0 0 8px;font-size:14px;color:#9f1239;">Lý do</p>
            <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#881337;">${escapeHtml(input.failureReason)}</p>
            <p style="margin:0 0 8px;font-size:14px;color:#9f1239;">Mã giao dịch</p>
            <p style="margin:0;font-size:16px;font-weight:600;color:#881337;">${escapeHtml(input.txnRef)}</p>
          </div>
          <table style="width:100%;margin-top:24px;border-collapse:collapse;">
            <tbody>
              <tr>
                <td style="padding:10px 0;color:#64748b;">Số tiền</td>
                <td style="padding:10px 0;text-align:right;font-weight:700;color:#0f172a;">${escapeHtml(formatCurrency(input.totalAmount))}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#64748b;border-top:1px solid #e2e8f0;">Nội dung giao dịch</td>
                <td style="padding:10px 0;text-align:right;color:#0f172a;border-top:1px solid #e2e8f0;">${escapeHtml(input.orderInfo)}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#64748b;border-top:1px solid #e2e8f0;">Mã phản hồi</td>
                <td style="padding:10px 0;text-align:right;color:#0f172a;border-top:1px solid #e2e8f0;">${escapeHtml(responseCode)}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#64748b;border-top:1px solid #e2e8f0;">Ngân hàng</td>
                <td style="padding:10px 0;text-align:right;color:#0f172a;border-top:1px solid #e2e8f0;">${escapeHtml(bankCode)}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#64748b;border-top:1px solid #e2e8f0;">Thời điểm ghi nhận</td>
                <td style="padding:10px 0;text-align:right;color:#0f172a;border-top:1px solid #e2e8f0;">${escapeHtml(resolvedPayDate)}</td>
              </tr>
            </tbody>
          </table>
          <p style="margin:24px 0 0;font-size:14px;line-height:1.7;color:#475569;">
            You can try the payment again or contact NovaX Market for further assistance.
          </p>
        </div>
      </div>
    </div>
  `;
}

function buildOrderFailureHtml(input: SendOrderFailureEmailInput) {
  const rows = input.items.map((item) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;">${escapeHtml(item.productName?.trim() || item.productId)}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#475569;text-align:center;">${item.quantity}</td>
    </tr>
  `).join("");

  return `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;">
        <div style="padding:28px 32px;background:linear-gradient(135deg,#fb923c,#dc2626);color:#ffffff;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;">NovaX Market</div>
          <h1 style="margin:12px 0 0;font-size:28px;line-height:1.3;">Đơn hàng chưa thể xử lý</h1>
        </div>
        <div style="padding:32px;">
          <p style="margin:0 0 12px;font-size:16px;line-height:1.7;">Xin chào <strong>${escapeHtml(input.toEmail)}</strong>,</p>
          <p style="margin:0 0 20px;font-size:16px;line-height:1.7;">Hệ thống chưa thể hoàn tất yêu cầu đặt hàng của bạn.</p>
          <div style="padding:20px;border-radius:20px;background:#fff1f2;border:1px solid #fda4af;">
            <p style="margin:0 0 8px;font-size:14px;color:#9f1239;">Lý do</p>
            <p style="margin:0;font-size:18px;font-weight:700;color:#881337;">${escapeHtml(input.failureReason)}</p>
          </div>
          ${input.requestId ? `<p style="margin:20px 0 0;font-size:14px;color:#475569;">Mã yêu cầu: <strong>${escapeHtml(input.requestId)}</strong></p>` : ""}
          <table style="width:100%;margin-top:24px;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="padding:0 0 12px;text-align:left;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Sản phẩm</th>
                <th style="padding:0 0 12px;text-align:center;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Số lượng</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:24px 0 0;font-size:14px;line-height:1.7;color:#475569;">You can try again later or choose a different product. If you need further assistance, please contact NovaX Market.</p>
        </div>
      </div>
    </div>
  `;
}

export async function sendOrderConfirmationEmail(input: OrderConfirmationInput) {
  const orderUrl = httpConfig.STOREFRONT_PUBLIC_URL
    ? new URL(`/store/orders/detail?orderId=${encodeURIComponent(input.orderId)}`, httpConfig.STOREFRONT_PUBLIC_URL).toString()
    : undefined;
  const content = orderConfirmationContent({ ...input, orderUrl });
  return sendTrackedOrderEmail({
    emailType: "order_confirmation",
    toEmail: input.toEmail,
    subject: content.subject,
    html: content.html,
    text: content.text,
    relatedId: input.orderId,
    // Retried queue deliveries must reuse this claim. A deliberate resend
    // should use a separate explicit operation, not this function.
    emailId: crypto.createHash("sha256").update(`order-confirmation:${input.orderId}`).digest("hex")
  });
}

export type RefundEmailStatus = "refund_pending" | "refund_sent" | "refund_rejected";

export async function sendRefundStatusEmail(input: {
  toEmail: string;
  orderId: string;
  totalAmount: number;
  status: RefundEmailStatus;
}) {
  const messages: Record<RefundEmailStatus, { subject: string; detail: string }> = {
    refund_pending: {
      subject: `Yêu cầu hoàn tiền đang được xử lý - đơn ${input.orderId}`,
      detail: "Yêu cầu hoàn tiền đã được ghi nhận và đang chờ kết quả từ VNPAY."
    },
    refund_sent: {
      subject: `Đã gửi hoàn tiền - đơn ${input.orderId}`,
      detail: "Lệnh hoàn tiền đã được VNPAY chấp nhận. Thời gian tiền về tài khoản phụ thuộc vào ngân hàng."
    },
    refund_rejected: {
      subject: `Yêu cầu hoàn tiền bị từ chối - đơn ${input.orderId}`,
      detail: "VNPAY đã từ chối yêu cầu hoàn tiền. Vui lòng liên hệ bộ phận hỗ trợ để được kiểm tra."
    }
  };
  const message = messages[input.status];
  const orderUrl = httpConfig.STOREFRONT_PUBLIC_URL
    ? new URL(`/store/orders/detail?orderId=${encodeURIComponent(input.orderId)}`, httpConfig.STOREFRONT_PUBLIC_URL).toString()
    : undefined;
  const detail = `${message.detail} Số tiền yêu cầu hoàn: ${formatCurrency(input.totalAmount)}.`;
  return sendTrackedOrderEmail({
    emailType: "refund_status",
    toEmail: input.toEmail,
    subject: message.subject,
    html: `<p>Xin chào,</p><p>${escapeHtml(detail)}</p><p>Mã đơn hàng: <strong>${escapeHtml(input.orderId)}</strong></p>${orderUrl ? `<p><a href="${escapeHtml(orderUrl)}">Xem đơn hàng</a></p>` : ""}`,
    text: `${detail}\nMã đơn hàng: ${input.orderId}${orderUrl ? `\nXem đơn hàng: ${orderUrl}` : ""}`,
    relatedId: input.orderId
  });
}

export async function sendPaymentFailureEmail(input: SendPaymentFailureEmailInput) {
  return sendTrackedOrderEmail({
    emailType: "payment_failure",
    toEmail: input.toEmail,
    subject: `Payment failed for transaction ${input.txnRef}`,
    html: buildPaymentFailureHtml(input),
    relatedId: input.txnRef
  });
}

export async function sendOrderFailureEmail(input: SendOrderFailureEmailInput) {
  return sendTrackedOrderEmail({
    emailType: "order_failure",
    toEmail: input.toEmail,
    subject: "Order could not be processed - NovaX Market",
    html: buildOrderFailureHtml(input),
    relatedId: input.requestId
  });
}
