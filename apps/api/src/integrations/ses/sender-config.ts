import { emailConfig } from "../../config/email-config.js";

export function authSenderEmail() {
  return emailConfig.SES_AUTH_FROM_EMAIL ?? emailConfig.SES_FROM_EMAIL;
}

export function ordersSenderEmail() {
  return emailConfig.SES_ORDERS_FROM_EMAIL ?? emailConfig.SES_FROM_EMAIL;
}

export function replyToAddresses() {
  return emailConfig.SES_REPLY_TO_EMAIL ? [emailConfig.SES_REPLY_TO_EMAIL] : undefined;
}
