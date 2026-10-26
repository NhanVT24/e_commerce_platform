import type { Function } from "aws-cdk-lib/aws-lambda";

// Environment and grants are selected together so adding a worker does not
// silently give it every integration, provider secret and administrative right.
const environmentGroups = {
  database: ["DYNAMODB_TABLE_NAME"],
  inventory: ["INVENTORY_ALERT_OUTBOX_ENABLED"],
  identity: ["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"],
  storage: ["S3_BUCKET_NAME", "S3_PUBLIC_BASE_URL"],
  imageUrls: ["S3_PUBLIC_BASE_URL"],
  events: ["EVENTBRIDGE_DEFAULT_BUS_NAME", "EVENTBRIDGE_COMMERCE_BUS_NAME", "EVENTBRIDGE_PAYMENT_BUS_NAME", "EVENTBRIDGE_PLATFORM_BUS_NAME"],
  alerts: ["SNS_ADMIN_ALERTS_TOPIC_ARN", "ADMIN_REPORT_EMAIL"],
  mail: ["SES_FROM_EMAIL", "SES_AUTH_FROM_EMAIL", "SES_ORDERS_FROM_EMAIL", "SES_REPLY_TO_EMAIL", "SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME", "STOREFRONT_PUBLIC_URL", "ADMIN_REPORT_EMAIL"],
  emailRecovery: ["EMAIL_EVENT_PUBLISH_MAX_ATTEMPTS"],
  payment: ["VNPAY_TMN_CODE", "VNPAY_HASH_SECRET", "VNPAY_PAYMENT_URL", "VNPAY_TRANSACTION_URL", "VNPAY_MERCHANT_IP", "VNPAY_RETURN_URL", "VNPAY_IPN_URL"],
  admin: ["AUDIT_LOG_TABLE_NAME", "SQS_NOTIFICATIONS_QUEUE_URL", "SQS_PAYMENT_EVENTS_QUEUE_URL", "SQS_EMAIL_JOBS_QUEUE_URL", "SQS_STOREFRONT_ORDERS_QUEUE_URL", "SQS_IMAGE_UPLOADS_QUEUE_URL", "SQS_NOTIFICATIONS_DLQ_URL", "SQS_STOREFRONT_ORDERS_DLQ_URL", "SQS_PAYMENT_EVENTS_DLQ_URL", "SQS_EMAIL_JOBS_DLQ_URL", "SQS_IMAGE_UPLOADS_DLQ_URL", "SQS_EVENTBRIDGE_TARGET_DLQ_URL", "SQS_EMAIL_EVENTBRIDGE_DELIVERY_DLQ_URL", "EVENTBRIDGE_COMMERCE_ARCHIVE_ARN", "EVENTBRIDGE_PAYMENT_ARCHIVE_ARN", "EVENTBRIDGE_PLATFORM_ARCHIVE_ARN"]
} as const;

type EnvironmentGroup = keyof typeof environmentGroups;
type EnvironmentKey = typeof environmentGroups[EnvironmentGroup][number];
export type LambdaCapability = "databaseRead" | "databaseWrite" | "mail" | "events" | "alerts" | "storage" | "admin";
export type LambdaGrants = Record<LambdaCapability, (fn: Function) => void>;
export interface ApplicationLambdaProfile {
  readonly environment: Record<string, string>;
  readonly capabilities: readonly LambdaCapability[];
}

export function createApplicationLambdaProfiles(environment: Record<EnvironmentKey, string>) {
  function profile(groups: readonly EnvironmentGroup[], capabilities: readonly LambdaCapability[]): ApplicationLambdaProfile {
    const keys = new Set(groups.flatMap(group => [...environmentGroups[group]]));
    return { environment: Object.fromEntries([...keys].map(key => [key, environment[key]])), capabilities };
  }

  return {
    http: profile(["database", "inventory", "identity", "storage", "events", "alerts", "mail", "emailRecovery", "payment", "admin"], ["databaseWrite", "storage", "events", "alerts", "mail", "admin"]),
    order: profile(["database", "events", "alerts", "mail"], ["databaseWrite", "events", "alerts", "mail"]),
    notification: profile(["database", "events", "alerts", "mail"], ["databaseWrite", "events", "alerts", "mail"]),
    emailDelivery: profile(["database", "mail"], ["databaseWrite", "mail"]),
    emailTracker: profile(["database"], ["databaseWrite"]),
    emailWatchdog: profile(["database", "alerts"], ["databaseWrite", "alerts"]),
    // Recovery republishes the original persisted bus name; allow all application buses.
    emailRecovery: profile(["database", "events", "alerts", "emailRecovery"], ["databaseWrite", "events", "alerts"]),
    weeklyReport: profile(["database", "mail"], ["databaseRead", "mail"]),
    inventoryReport: profile(["database", "mail"], ["databaseWrite", "mail"]),
    emailFeedback: profile(["database"], ["databaseWrite"]),
    checkout: profile(["database", "events", "alerts", "mail", "payment"], ["databaseWrite", "events", "alerts", "mail"]),
    readPayment: profile(["database"], ["databaseRead"]),
    image: profile(["imageUrls"], []),
    buildReport: profile(["database"], ["databaseRead"]),
    sendReport: profile(["mail"], ["mail"]),
    auditEvent: profile([], []),
    expireOrders: profile(["database"], ["databaseWrite"]),
    refundRecovery: profile(["database", "payment", "mail"], ["databaseWrite", "mail"]),
    paymentRecovery: profile(["database", "payment", "events", "alerts", "mail"], ["databaseWrite", "events", "alerts", "mail"]),
    cleanup: profile(["database"], ["databaseWrite"]),
    saleCampaign: profile(["database"], ["databaseWrite"])
  };
}
