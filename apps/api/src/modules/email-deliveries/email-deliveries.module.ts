import { Logger, Module } from "@nestjs/common";
import crypto from "node:crypto";
import { emailConfig } from "../../config/email-config.js";
import { eventbridgeConfig } from "../../config/eventbridge-config.js";
import { EmailDeliveriesController } from "./email-deliveries.controller.js";
import { EmailAdministration } from "./application/email-administration.js";
import { emailAdministrationPorts } from "./infrastructure/email-administration-ports.js";
@Module({ controllers: [EmailDeliveriesController], providers: [{ provide: EmailAdministration, useFactory: () => new EmailAdministration(
 emailAdministrationPorts, { senderEmail: emailConfig.SES_FROM_EMAIL, eventsEnabled: Boolean(eventbridgeConfig.EVENTBRIDGE_PLATFORM_BUS_NAME) },
 crypto.randomUUID, value => crypto.createHash("sha256").update(value).digest("hex"), new Logger(EmailAdministration.name)) }] })
export class EmailDeliveriesModule {}
