import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Deployed Lambdas receive their configuration from CDK. Never supplement it
// with a developer .env file accidentally included in an artifact.
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env"), quiet: true });
}
