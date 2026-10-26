import { z } from "zod";
import "./load-env.js";

export const storageConfigSchema = z.object({
  S3_BUCKET_NAME: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  S3_PRESIGN_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
});

export const storageConfig = storageConfigSchema.parse(process.env);
