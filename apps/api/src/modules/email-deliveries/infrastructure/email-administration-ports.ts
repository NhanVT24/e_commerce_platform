import { eventbridgeConfig } from "../../../config/eventbridge-config.js";
import { publishEventBridgeEvent } from "../../../integrations/eventbridge/publisher.js";
import * as deliveries from "../email-delivery.repository.js";
import * as routes from "../email-route.repository.js";
import { nextEmailPublishRetryAt } from "../email-publish-retry.js";
import type { EmailAdministrationPorts, MailEvent } from "../application/ports.js";
const event = ({ channel: _channel, ...input }: MailEvent) => ({ ...input, busName: eventbridgeConfig.EVENTBRIDGE_PLATFORM_BUS_NAME });
export const emailAdministrationPorts: EmailAdministrationPorts = {
    getEmailDelivery: deliveries.getEmailDelivery, listEmailDeliveriesWithStatus: deliveries.listEmailDeliveriesWithStatus,
    listFailedEmailRoutePublishes: routes.listFailedEmailRoutePublishes, retryFailedEmailRoutePublish: routes.retryFailedEmailRoutePublish,
    ensureEmailRoute: route => routes.ensureEmailRoute(route, eventbridgeConfig.EVENTBRIDGE_PLATFORM_BUS_NAME),
    markEmailRoutePublished: routes.markEmailRoutePublished, markEmailRoutePublishRetry: routes.markEmailRoutePublishRetry,
    nextEmailPublishRetryAt, publishEventBridgeEvent: input => publishEventBridgeEvent(event(input))
};
