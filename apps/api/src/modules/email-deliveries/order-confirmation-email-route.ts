import crypto from "node:crypto";
import { eventbridgeConfig } from "../../config/eventbridge-config.js";
import { QueueOrderConfirmation } from "./application/queue-order-confirmation.js";
import { emailAdministrationPorts } from "./infrastructure/email-administration-ports.js";
import type { ConfirmationMail } from "./domain/email-jobs.js";
export function queueOrderConfirmationEmail(input:ConfirmationMail) {
 return new QueueOrderConfirmation(emailAdministrationPorts,Boolean(eventbridgeConfig.EVENTBRIDGE_PLATFORM_BUS_NAME),value=>crypto.createHash("sha256").update(value).digest("hex")).execute(input);
}
