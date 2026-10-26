import { z } from "zod";
import "./load-env.js";

export const databaseConfigSchema = z.object({
  INVENTORY_ALERT_OUTBOX_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  DYNAMODB_ENDPOINT: z.string().optional(),
  DYNAMODB_TABLE_NAME: z.string().default("MarketplaceProducts"),
  AUDIT_LOG_TABLE_NAME: z.string().optional()
});

export const databaseConfig = databaseConfigSchema.parse(process.env);
