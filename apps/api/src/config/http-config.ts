import { z } from "zod";
import "./load-env.js";

export const httpConfigSchema = z.object({
  PORT: z.coerce.number().default(4000),
  STOREFRONT_PUBLIC_URL: z.string().url().optional(),
  NEXT_PUBLIC_API_URL: z.string().url().optional()
});

export const httpConfig = httpConfigSchema.parse(process.env);
