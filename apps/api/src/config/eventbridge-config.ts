import { z } from "zod";
import "./load-env.js";

export const eventbridgeConfigSchema = z.object({
  EVENTBRIDGE_DEFAULT_BUS_NAME: z.string().optional(),
  EVENTBRIDGE_COMMERCE_BUS_NAME: z.string().optional(),
  EVENTBRIDGE_PAYMENT_BUS_NAME: z.string().optional(),
  EVENTBRIDGE_PLATFORM_BUS_NAME: z.string().optional(),
  EVENTBRIDGE_COMMERCE_ARCHIVE_ARN: z.string().optional(),
  EVENTBRIDGE_PAYMENT_ARCHIVE_ARN: z.string().optional(),
  EVENTBRIDGE_PLATFORM_ARCHIVE_ARN: z.string().optional()
});

export const eventbridgeConfig = eventbridgeConfigSchema.parse(process.env);
