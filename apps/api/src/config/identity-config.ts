import { z } from "zod";
import "./load-env.js";

export const identityConfigSchema = z.object({
  COGNITO_USER_POOL_ID: z.string().min(1).optional(),
  COGNITO_CLIENT_ID: z.string().min(1).optional(),
  AUTH_ALLOW_UNVERIFIED_JWT: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
});

export const identityConfig = identityConfigSchema.parse(process.env);
