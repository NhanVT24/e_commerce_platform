import { awsConfig } from "./aws-config.js";
import { databaseConfig } from "./database-config.js";
import { identityConfig } from "./identity-config.js";
import { storageConfig } from "./storage-config.js";
import { eventbridgeConfig } from "./eventbridge-config.js";
import { emailConfig } from "./email-config.js";
import { operationsConfig } from "./operations-config.js";
import { httpConfig } from "./http-config.js";
import { readPaymentConfig } from "./payment-config.js";

// Full HTTP/local application configuration. Background entrypoints use scoped config modules.
export const env = {
  ...awsConfig,
  ...databaseConfig,
  ...identityConfig,
  ...storageConfig,
  ...eventbridgeConfig,
  ...emailConfig,
  ...operationsConfig,
  ...httpConfig,
  ...readPaymentConfig()
};

export type Env = typeof env;
