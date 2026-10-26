import { z } from "zod";
import "./load-env.js";

export const awsConfigSchema = z.object({
  AWS_REGION: z.string().default("ap-southeast-1"),
  AWS_ACCESS_KEY_ID: z.string().default("local"),
  AWS_SECRET_ACCESS_KEY: z.string().default("local")
});

export const awsConfig = awsConfigSchema.parse(process.env);
