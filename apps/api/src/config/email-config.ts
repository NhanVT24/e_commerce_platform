import { z } from "zod";
import "./load-env.js";

export const emailConfigSchema = z.object({
  EMAIL_ROUTING_ACK_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  EMAIL_EVENT_PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  EMAIL_EVENT_PUBLISH_RETRY_BASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  EMAIL_EVENT_PUBLISH_RETRY_MAX_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  EMAIL_EVENT_PUBLISH_LEASE_SECONDS: z.coerce.number().int().min(30).max(900).default(120),
  SES_FROM_EMAIL: z.string().email().optional(),
  SES_AUTH_FROM_EMAIL: z.string().email().optional(),
  SES_ORDERS_FROM_EMAIL: z.string().email().optional(),
  SES_REPLY_TO_EMAIL: z.string().email().optional(),
  SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME: z.string().min(1).optional(),
  SES_EVENTS_TOPIC_ARN: z.string().optional(),
  ADMIN_REPORT_EMAIL: z.string().email().optional()
});

export const emailConfig = emailConfigSchema.parse(process.env);
