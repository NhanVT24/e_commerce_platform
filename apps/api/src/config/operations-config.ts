import { z } from "zod";
import "./load-env.js";

export const operationsConfigSchema = z.object({
  SQS_NOTIFICATIONS_QUEUE_URL: z.string().optional(),
  SQS_AUDIT_QUEUE_URL: z.string().optional(),
  SQS_AUDIT_LOG_QUEUE_URL: z.string().optional(),
  SQS_AUDIT_LOG_WORKER_DLQ_URL: z.string().optional(),
  SQS_PAYMENT_EVENTS_QUEUE_URL: z.string().optional(),
  SQS_EMAIL_JOBS_QUEUE_URL: z.string().optional(),
  SQS_STOREFRONT_ORDERS_QUEUE_URL: z.string().optional(),
  SQS_IMAGE_UPLOADS_QUEUE_URL: z.string().optional(),
  SQS_NOTIFICATIONS_DLQ_URL: z.string().optional(),
  SQS_STOREFRONT_ORDERS_DLQ_URL: z.string().optional(),
  SQS_PAYMENT_EVENTS_DLQ_URL: z.string().optional(),
  SQS_EMAIL_JOBS_DLQ_URL: z.string().optional(),
  SQS_IMAGE_UPLOADS_DLQ_URL: z.string().optional(),
  SQS_EVENTBRIDGE_TARGET_DLQ_URL: z.string().optional(),
  SQS_EMAIL_EVENTBRIDGE_DELIVERY_DLQ_URL: z.string().optional(),
  SALE_SCHEDULER_ROLE_ARN: z.string().optional(),
  SALE_SCHEDULER_GROUP_NAME: z.string().default("supermarket-sales"),
  SALE_SCHEDULER_TARGET_ARN: z.string().optional(),
  STOREFRONT_SYNC_QUEUE_PROCESSING: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  SNS_ADMIN_ALERTS_TOPIC_ARN: z.string().optional()
});

export const operationsConfig = operationsConfigSchema.parse(process.env);
