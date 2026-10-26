import { readPaymentConfig } from "../../../config/payment-config.js";
import "reflect-metadata";
import { createStandaloneContext } from "../../../core/app/create-standalone-context.js";
import { WorkflowCheckout } from "../../../modules/storefront/application/workflow-checkout/workflow-checkout.js";
import { auditContext, serviceAuditContext } from "../../../modules/audit-log/audit-context.js";

type WorkflowInput = { detail?: { email?: string; requestId?: string; items?: Array<{ productId: string; quantity: number }> } };

// This runtime calls the payment provider; validate before any order mutation.
readPaymentConfig();

export const handler = async (event: WorkflowInput, lambdaContext?: { awsRequestId?: string }) => {
  const payload = event.detail ?? {};
  const email = String(payload.email ?? "").trim().toLowerCase();
  if (!email || !payload.requestId || !payload.items?.length) throw new Error("Missing workflow order payload.");
  const context = await createStandaloneContext();
  return auditContext.run(serviceAuditContext({ actorId: "lambda:order-workflow-step", source: "ORDER_WORKFLOW",
    reason: "checkout_hold", requestId: lambdaContext?.awsRequestId ?? payload.requestId }),
    () => context.get(WorkflowCheckout).execute(email, payload.items, payload.requestId));
};
