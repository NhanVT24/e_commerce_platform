import * as path from "node:path";
import {
  CfnDynamicReference,
  CfnDynamicReferenceService,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps
} from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as pipes from "aws-cdk-lib/aws-pipes";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { createProductImagesDistribution } from "../module/cloudfront";
import { createMarketplaceTable } from "../module/dynamodb";
import { createQueues, createSesFeedbackDlq } from "../module/sqs";
import { createProductImagesAliases } from "../module/route53";
import { createProductImagesBucket } from "../module/s3";
import { createHttpApi } from "./http-api";

export interface AwsApiStackProps extends StackProps {
  // API Gateway REGIONAL custom domain: api.truyenmasinhvien.com.
  // This certificate must be in the API region, ap-southeast-1.
  readonly apiCertificateArn?: string;
  readonly apiCustomDomainName?: string;
  readonly apiHostedZoneDomainName?: string;
  // Product image CDN custom domain: assets.truyenmasinhvien.com.
  // This uses CloudFront, so its certificate must be in us-east-1.
  readonly productImagesCertificateArn?: string;
  readonly productImagesDomainNames?: string[];
  readonly productImagesHostedZoneDomainName?: string;
}

export class AwsApiStack extends Stack {
  readonly auditSourceStreamArn: string;
  readonly auditLogMainQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: AwsApiStackProps = {}) {
    super(scope, id, props);

    const gsiDeploymentPhase = this.node.tryGetContext("dynamodbGsiDeploymentPhase");
    if (gsiDeploymentPhase && gsiDeploymentPhase !== "entity-only") {
      throw new Error("dynamodbGsiDeploymentPhase must be 'entity-only' when provided.");
    }
    // DynamoDB permits only one GSI create/delete operation per table update.
    // Use entity-only for the first deployment, then deploy normally to add the sale index.
    const includeSaleCampaignTimelineIndex = gsiDeploymentPhase !== "entity-only";
    if (props.apiCustomDomainName && !props.apiCertificateArn) {
      throw new Error("apiCertificateArn is required when apiCustomDomainName is provided.");
    }

    const inventoryOutboxEnabled = new CfnParameter(this, "InventoryAlertOutboxEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable durable inventory alerts after deploying relay and compatible consumers."
    });

    const callbackUrl = new CfnParameter(this, "CallbackUrl", {
      type: "String",
      default: "https://dwft9aemqzcp.cloudfront.net/auth/callback",
      description: "Frontend callback URL after Cognito sign-in"
    });

    const logoutUrl = new CfnParameter(this, "LogoutUrl", {
      type: "String",
      default: "https://dwft9aemqzcp.cloudfront.net/",
      description: "Frontend logout redirect URL after Cognito sign-out"
    });

    const cognitoDomainPrefix = new CfnParameter(this, "CognitoDomainPrefix", {
      type: "String",
      default: "replace-me-supermarket-auth",
      allowedPattern: "^[a-z0-9-]+$",
      description: "Globally unique domain prefix for Cognito hosted UI"
    });

    const cognitoSignupAllowedEmailDomains = new CfnParameter(this, "CognitoSignupAllowedEmailDomains", {
      type: "String",
      default: "",
      description: "Comma-separated email domains allowed to self sign up. Leave empty to allow all non-blocked domains."
    });

    const cognitoSignupBlockedEmailDomains = new CfnParameter(this, "CognitoSignupBlockedEmailDomains", {
      type: "String",
      default: "",
      description: "Comma-separated email domains blocked from Cognito sign-up."
    });

    const cognitoSignupBlockedEmails = new CfnParameter(this, "CognitoSignupBlockedEmails", {
      type: "String",
      default: "",
      description: "Comma-separated email addresses blocked from Cognito sign-up."
    });

    const cognitoAutoConfirmNativeSignup = new CfnParameter(this, "CognitoAutoConfirmNativeSignup", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Whether the PreSignUp trigger should auto-confirm native Cognito self sign-up."
    });

    const cognitoAutoVerifyNativeEmail = new CfnParameter(this, "CognitoAutoVerifyNativeEmail", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Whether the PreSignUp trigger should auto-verify email for native Cognito self sign-up."
    });

    const googleClientIdSsmPath = new CfnParameter(this, "GoogleClientIdSsmPath", {
      type: "String",
      default: "/supermarket/google/client-id",
      description: "SSM parameter path for Google OAuth client id"
    });

    const googleClientSecretSsmPath = new CfnParameter(this, "GoogleClientSecretSsmPath", {
      type: "String",
      default: "/supermarket/google/client-secret",
      noEcho: true,
      description: "SSM parameter path for Google OAuth client secret"
    });

    const vnpayTmnCodeSsmPath = new CfnParameter(this, "VnpayTmnCodeSsmPath", {
      type: "String",
      default: "/supermarket/vnpay/tmn-code",
      description: "SSM parameter path for VNPay terminal code"
    });

    const vnpayPaymentUrlSsmPath = new CfnParameter(this, "VnpayPaymentUrlSsmPath", {
      type: "String",
      default: "/supermarket/vnpay/payment-url",
      description: "SSM parameter path for VNPay payment gateway URL"
    });

    const vnpayTransactionUrl = new CfnParameter(this, "VnpayTransactionUrl", {
      type: "String",
      default: "",
      description: "VNPay merchant transaction API URL for refund and querydr; leave blank for sandbox"
    });

    const vnpayMerchantIp = new CfnParameter(this, "VnpayMerchantIp", {
      type: "String",
      default: "",
      description: "Merchant server IP used in VNPay refund and query requests"
    });

    const vnpayHashSecretSsmPath = new CfnParameter(this, "VnpayHashSecretSsmPath", {
      type: "String",
      default: "/supermarket/vnpay/hash-secret",
      noEcho: true,
      description: "SSM parameter path for VNPay hash secret"
    });

    const dynamoTableName = new CfnParameter(this, "DynamoTableName", {
      type: "String",
      default: "MarketplaceProductsDev",
      description: "DynamoDB table name for this stack"
    });

    const vnpayReturnUrl = new CfnParameter(this, "VnpayReturnUrl", {
      type: "String",
      default: "https://dwft9aemqzcp.cloudfront.net/store/checkout/result",
      description: "Frontend return URL after VNPay payment"
    });

    const vnpayIpnUrl = new CfnParameter(this, "VnpayIpnUrl", {
      type: "String",
      default: "https://b5j3895qth.execute-api.ap-southeast-1.amazonaws.com/prod/api/payments/vnpay/ipn",
      description: "VNPay IPN callback URL"
    });

    const sesFromEmail = new CfnParameter(this, "SesFromEmail", {
      type: "String",
      default: "noreply@truyenmasinhvien.com",
      description: "SES sender address covered by a verified email or domain identity"
    });
    const sesAuthFromEmail = new CfnParameter(this, "SesAuthFromEmail", {
      type: "String",
      default: "auth@truyenmasinhvien.com",
      description: "SES sender for Cognito authentication and welcome emails"
    });
    const sesOrdersFromEmail = new CfnParameter(this, "SesOrdersFromEmail", {
      type: "String",
      default: "orders@truyenmasinhvien.com",
      description: "SES sender for order and payment emails"
    });
    const sesReplyToEmail = new CfnParameter(this, "SesReplyToEmail", {
      type: "String",
      default: "nhan18072020@gmail.com",
      description: "Inbox for replies to outgoing email"
    });
    const storefrontPublicUrl = new CfnParameter(this, "StorefrontPublicUrl", {
      type: "String",
      default: "https://truyenmasinhvien.com",
      description: "Public storefront origin for links in customer emails"
    });

    const emailWorkerTestMode = new CfnParameter(this, "EmailWorkerTestMode", {
      type: "String",
      default: "disabled",
      allowedValues: ["disabled", "fail", "recover"],
      description: "TEST ONLY: email worker mode; use disabled outside an isolated test environment"
    });

    const adminReportEmail = new CfnParameter(this, "AdminReportEmail", {
      type: "String",
      default: "vonhan2432005@gmail.com",
      description: "Admin email address that receives the weekly revenue report"
    });

    const table = createMarketplaceTable(this, dynamoTableName.valueAsString, includeSaleCampaignTimelineIndex);
    this.auditSourceStreamArn = table.attrStreamArn;
    const auditLogTable = new dynamodb.CfnTable(this, "AuditLogTable", {
      tableName: "supermarket-audit-log",
      billingMode: "PAY_PER_REQUEST",
      attributeDefinitions: [
        { attributeName: "PK", attributeType: "S" },
        { attributeName: "SK", attributeType: "S" },
        { attributeName: "resourceType", attributeType: "S" },
        { attributeName: "occurredAt", attributeType: "S" }
      ],
      keySchema: [
        { attributeName: "PK", keyType: "HASH" },
        { attributeName: "SK", keyType: "RANGE" }
      ],
      globalSecondaryIndexes: [
        {
          indexName: "ResourceTimelineIndex",
          keySchema: [
            { attributeName: "resourceType", keyType: "HASH" },
            { attributeName: "occurredAt", keyType: "RANGE" }
          ],
          projection: { projectionType: "ALL" }
        }
      ]
    });
    auditLogTable.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const idempotencyTable = new dynamodb.Table(this, "WorkerIdempotencyTable", {
      tableName: "supermarket-worker-idempotency",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN
    });

    const productImagesBucket = createProductImagesBucket(this);
    const {
      productImagesDistribution,
      productImagesDomainNames,
      productImagesPublicBaseUrl
    } = createProductImagesDistribution(this, productImagesBucket, {
      certificateArn: props.productImagesCertificateArn,
      domainNames: props.productImagesDomainNames
    });
    createProductImagesAliases(
      this,
      productImagesDistribution,
      productImagesDomainNames,
      props.productImagesHostedZoneDomainName
    );

    const {
      notificationsDlq,
      notificationsQueue,
      auditQueue,
      eventBridgeTargetDlq,
      storefrontOrdersDlq,
      storefrontOrdersQueue,
      paymentEventsDlq,
      paymentEventsQueue,
      emailJobsDlq,
      emailEventBridgeDeliveryDlq,
      emailRouteTrackerDlq,
      emailRoutingWatchdogDlq,
      emailPublishRecoveryDlq,
      emailEventBridgeFailureTestTargetQueue,
      emailEventBridgeSuccessTestQueue,
      emailJobsQueue,
      imageUploadsDlq,
      imageUploadsQueue
    } = createQueues(this);

    const commerceEventBus = new events.EventBus(this, "SupermarketCommerceEventBus", {
      eventBusName: "supermarket-commerce-bus"
    });
    const paymentEventBus = new events.EventBus(this, "SupermarketPaymentEventBus", {
      eventBusName: "supermarket-payment-bus"
    });
    const platformEventBus = new events.EventBus(this, "SupermarketPlatformEventBus", {
      eventBusName: "supermarket-platform-bus"
    });
    const saleSchedulerGroup = new scheduler.CfnScheduleGroup(this, "SaleSchedulerGroup", {
      name: "supermarket-sales"
    });
    const commerceArchive = new events.CfnArchive(this, "SupermarketCommerceArchive", {
      archiveName: "supermarket-commerce-archive",
      description: "Lưu lịch sử event commerce để replay khi cần.",
      sourceArn: commerceEventBus.eventBusArn,
      retentionDays: 30
    });
    const paymentArchive = new events.CfnArchive(this, "SupermarketPaymentArchive", {
      archiveName: "supermarket-payment-archive",
      description: "Lưu lịch sử event payment để replay khi cần.",
      sourceArn: paymentEventBus.eventBusArn,
      retentionDays: 30
    });
    const platformArchive = new events.CfnArchive(this, "SupermarketPlatformArchive", {
      archiveName: "supermarket-platform-archive",
      description: "Saves the history of platform events for replay when needed.",
      sourceArn: platformEventBus.eventBusArn,
      retentionDays: 30
    });

    const sharedLambdaCode = lambda.Code.fromAsset(path.resolve(__dirname, "../../apps/api/dist/lambda.zip"));
    const cognitoCustomSenderKey = new kms.Key(this, "CognitoCustomSenderKey", {
      alias: "alias/supermarket-cognito-custom-sender",
      description: "Encrypts Cognito custom sender verification codes before invoking Lambda.",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY
    });
    cognitoCustomSenderKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("cognito-idp.amazonaws.com")],
      actions: [
        "kms:DescribeKey",
        "kms:Encrypt",
        "kms:GenerateDataKey"
      ],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "aws:SourceAccount": this.account
        },
        ArnLike: {
          "aws:SourceArn": `arn:${this.partition}:cognito-idp:${this.region}:${this.account}:userpool/*`
        }
      }
    }));

    const triggerPreSignUpFunction = new lambda.Function(this, "TriggerPreSignUp", {
      functionName: "TriggerPreSignUp",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      handler: "src/entrypoints/lambda/cognito/pre-sign-up.handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        COGNITO_SIGNUP_ALLOWED_EMAIL_DOMAINS: cognitoSignupAllowedEmailDomains.valueAsString,
        COGNITO_SIGNUP_BLOCKED_EMAIL_DOMAINS: cognitoSignupBlockedEmailDomains.valueAsString,
        COGNITO_SIGNUP_BLOCKED_EMAILS: cognitoSignupBlockedEmails.valueAsString,
        COGNITO_AUTO_CONFIRM_NATIVE_SIGNUP: cognitoAutoConfirmNativeSignup.valueAsString,
        COGNITO_AUTO_VERIFY_NATIVE_EMAIL: cognitoAutoVerifyNativeEmail.valueAsString
      },
      code: sharedLambdaCode,
      initialPolicy: [
        new iam.PolicyStatement({
          actions: [
            "cognito-idp:AdminLinkProviderForUser",
            "cognito-idp:ListUsers"
          ],
          resources: ["*"]
        })
      ]
    });

    const cognitoTriggerFunction = new lambda.Function(this, "CognitoTriggerFunction", {
      functionName: "supermarket-cognito-trigger",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      handler: "src/entrypoints/lambda/cognito/cognito-trigger.handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        DYNAMODB_TABLE_NAME: dynamoTableName.valueAsString,
        EVENTBRIDGE_DEFAULT_BUS_NAME: platformEventBus.eventBusName,
        EVENTBRIDGE_PLATFORM_BUS_NAME: platformEventBus.eventBusName,
        COGNITO_CUSTOM_SENDER_KMS_KEY_ARN: cognitoCustomSenderKey.keyArn,
        SES_FROM_EMAIL: sesAuthFromEmail.valueAsString,
        SES_AUTH_FROM_EMAIL: sesAuthFromEmail.valueAsString,
        SES_REPLY_TO_EMAIL: sesReplyToEmail.valueAsString
      },
      code: sharedLambdaCode,
      initialPolicy: [
        new iam.PolicyStatement({
          actions: [
            "cognito-idp:AdminGetUser",
            "cognito-idp:AdminAddUserToGroup",
            "cognito-idp:AdminListGroupsForUser"
          ],
          resources: ["*"]
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          resources: [table.attrArn]
        }),
        new iam.PolicyStatement({
          actions: ["events:PutEvents"],
          resources: [platformEventBus.eventBusArn]
        }),
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: ["*"]
        })
      ]
    });
    cognitoCustomSenderKey.grantDecrypt(cognitoTriggerFunction);

    const userPool = new cognito.UserPool(this, "AdminUserPool", {
      userPoolName: "supermarket-admin-users",
      selfSignUpEnabled: true,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInAliases: { email: true },
      autoVerify: { email: true },
      email: cognito.UserPoolEmail.withSES({
        fromEmail: sesAuthFromEmail.valueAsString,
        fromName: "Supermarket",
        replyTo: sesReplyToEmail.valueAsString
      }),
      mfa: cognito.Mfa.OFF,
      customSenderKmsKey: cognitoCustomSenderKey,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true }
      },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false
      },
      lambdaTriggers: {
        customEmailSender: cognitoTriggerFunction,
        preSignUp: triggerPreSignUpFunction,
        preAuthentication: cognitoTriggerFunction,
        postAuthentication: cognitoTriggerFunction,
        postConfirmation: cognitoTriggerFunction
      }
    });
    // Cognito must reference the verified SES domain identity, while From
    // remains the full sender address. CDK defaults SourceArn to the address.
    const sesSenderDomain = Fn.select(1, Fn.split("@", sesAuthFromEmail.valueAsString));
    (userPool.node.defaultChild as cognito.CfnUserPool).addPropertyOverride(
      "EmailConfiguration.SourceArn",
      this.formatArn({ service: "ses", resource: "identity", resourceName: sesSenderDomain })
    );
    userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      cognitoTriggerFunction,
      cognito.LambdaVersion.V2_0
    );

    const customerGroup = new cognito.CfnUserPoolGroup(this, "CustomerGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "customer",
      description: "Customers can browse products and place orders"
    });
    // The admin group predates this CDK stack and is managed operationally in
    // the existing user pool. Declaring it here would make CloudFormation try
    // to create the same physical group and fail with AlreadyExists.

    const apiAccessScope = new cognito.ResourceServerScope({
      scopeName: "access",
      scopeDescription: "Access the supermarket API"
    });
    const apiResourceServer = userPool.addResourceServer("ApiResourceServer", {
      identifier: "supermarket-api",
      scopes: [apiAccessScope]
    });

    const googleClientId = new CfnDynamicReference(
      CfnDynamicReferenceService.SSM,
      googleClientIdSsmPath.valueAsString
    ).toString();

    const googleClientSecret = new CfnDynamicReference(
      CfnDynamicReferenceService.SSM,
      googleClientSecretSsmPath.valueAsString
    ).toString();

    const googleIdentityProvider = new cognito.UserPoolIdentityProviderGoogle(this, "GoogleIdentityProvider", {
      userPool,
      clientId: googleClientId,
      clientSecretValue: SecretValue.unsafePlainText(googleClientSecret),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME
      }
    });

    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: "supermarket-web-client",
      authFlows: { userPassword: true, userSrp: true },
      // Five-minute access/ID tokens limit the impact of a leaked bearer JWT.
      // Seven days gives users a reasonable inactive-session window; rotation
      // issues a replacement refresh token for an actively used session.
      accessTokenValidity: Duration.minutes(5),
      idTokenValidity: Duration.minutes(5),
      refreshTokenValidity: Duration.days(7),
      refreshTokenRotationGracePeriod: Duration.seconds(30),
      preventUserExistenceErrors: true,
      generateSecret: false,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.GOOGLE
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.resourceServer(apiResourceServer, apiAccessScope)
        ],
        callbackUrls: [callbackUrl.valueAsString],
        logoutUrls: [logoutUrl.valueAsString]
      }
    });
    userPoolClient.node.addDependency(googleIdentityProvider);

    const vnpayTmnCodeValue = new CfnDynamicReference(
      CfnDynamicReferenceService.SSM,
      vnpayTmnCodeSsmPath.valueAsString
    ).toString();

    const vnpayPaymentUrlValue = new CfnDynamicReference(
      CfnDynamicReferenceService.SSM,
      vnpayPaymentUrlSsmPath.valueAsString
    ).toString();

    const vnpayHashSecretValue = new CfnDynamicReference(
      CfnDynamicReferenceService.SSM,
      vnpayHashSecretSsmPath.valueAsString
    ).toString();

    const userPoolDomain = userPool.addDomain("HostedUiDomain", {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix.valueAsString },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN
    });
    const managedLoginBranding = new cognito.CfnManagedLoginBranding(this, "ManagedLoginBranding", {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true
    });
    managedLoginBranding.node.addDependency(userPoolDomain);

    const adminAlertsTopic = new sns.Topic(this, "AdminAlertsTopic", {
      topicName: "supermarket-admin-alerts",
      displayName: "Supermarket Admin Alerts"
    });
    adminAlertsTopic.addSubscription(new subscriptions.EmailSubscription(adminReportEmail.valueAsString));
    new events.Rule(this, "AuditStreamAlarmNotificationRule", {
      eventPattern: {
        source: ["aws.cloudwatch"],
        detailType: ["CloudWatch Alarm State Change"],
        detail: {
          alarmName: [
            "supermarket-audit-log-pipe-dlq-messages-visible",
            "supermarket-audit-log-pipe-execution-failures"
          ],
          state: { value: ["ALARM"] }
        }
      },
      targets: [new eventsTargets.SnsTopic(adminAlertsTopic, {
        deadLetterQueue: eventBridgeTargetDlq,
        retryAttempts: 2
      })]
    });
    const sesFeedbackDeliveryStatusRole = new iam.Role(this, "SesFeedbackDeliveryStatusRole", {
      assumedBy: new iam.ServicePrincipal("sns.amazonaws.com")
    });
    sesFeedbackDeliveryStatusRole.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: ["*"]
    }));
    const inventoryReportEventsTopic = new sns.Topic(this, "InventoryReportEventsTopic", {
      topicName: "supermarket-inventory-report-events",
      displayName: "Supermarket Inventory Report SES Events",
      // SNS writes sampled delivery records to its own CloudWatch log group,
      // letting us distinguish "SES published" from "Lambda processed".
      loggingConfigs: [{
        protocol: sns.LoggingProtocol.LAMBDA,
        successFeedbackRole: sesFeedbackDeliveryStatusRole,
        failureFeedbackRole: sesFeedbackDeliveryStatusRole,
        successFeedbackSampleRate: 100
      }]
    });
    const inventoryReportConfigurationSet = new ses.CfnConfigurationSet(this, "InventoryReportConfigurationSet", {
      name: "supermarket-inventory-daily-report"
    });
    const inventoryReportSesEventDestination = new ses.CfnConfigurationSetEventDestination(this, "InventoryReportSesEventDestination", {
      configurationSetName: inventoryReportConfigurationSet.ref,
      eventDestination: {
        enabled: true,
        matchingEventTypes: ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "RENDERING_FAILURE"],
        snsDestination: {
          topicArn: inventoryReportEventsTopic.topicArn
        }
      }
    });
    const inventoryReportEventsTopicPolicy = new sns.TopicPolicy(this, "InventoryReportEventsTopicPolicy", {
      topics: [inventoryReportEventsTopic]
    });
    inventoryReportEventsTopicPolicy.document.addStatements(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
      actions: ["sns:Publish"],
      resources: [inventoryReportEventsTopic.topicArn],
      conditions: {
        StringEquals: {
          "AWS:SourceAccount": this.account
        },
        ArnLike: {
          "AWS:SourceArn": `arn:aws:ses:${this.region}:${this.account}:configuration-set/${inventoryReportConfigurationSet.ref}`
        }
      }
    }));
    // SES validates its SNS publish permission while creating the event destination.
    inventoryReportSesEventDestination.addResourceDependency(
      inventoryReportEventsTopicPolicy.node.defaultChild as sns.CfnTopicPolicy
    );

    const sharedEnvironment = {
      DYNAMODB_TABLE_NAME: table.tableName ?? dynamoTableName.valueAsString,
      AUDIT_LOG_TABLE_NAME: auditLogTable.tableName ?? "supermarket-audit-log",
      COGNITO_USER_POOL_ID: userPool.userPoolId,
      COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      S3_BUCKET_NAME: productImagesBucket.bucketName,
      S3_PUBLIC_BASE_URL: productImagesPublicBaseUrl,
      SQS_NOTIFICATIONS_QUEUE_URL: notificationsQueue.queueUrl,
      SQS_AUDIT_QUEUE_URL: auditQueue.queueUrl,
      SQS_PAYMENT_EVENTS_QUEUE_URL: paymentEventsQueue.queueUrl,
      SQS_EMAIL_JOBS_QUEUE_URL: emailJobsQueue.queueUrl,
      SQS_STOREFRONT_ORDERS_QUEUE_URL: storefrontOrdersQueue.queueUrl,
      SQS_IMAGE_UPLOADS_QUEUE_URL: imageUploadsQueue.queueUrl,
      SQS_NOTIFICATIONS_DLQ_URL: notificationsDlq.queueUrl,
      SQS_STOREFRONT_ORDERS_DLQ_URL: storefrontOrdersDlq.queueUrl,
      SQS_PAYMENT_EVENTS_DLQ_URL: paymentEventsDlq.queueUrl,
      SQS_EMAIL_JOBS_DLQ_URL: emailJobsDlq.queueUrl,
      SQS_IMAGE_UPLOADS_DLQ_URL: imageUploadsDlq.queueUrl,
      SQS_EVENTBRIDGE_TARGET_DLQ_URL: eventBridgeTargetDlq.queueUrl,
      SQS_EMAIL_EVENTBRIDGE_DELIVERY_DLQ_URL: emailEventBridgeDeliveryDlq.queueUrl,
      EVENTBRIDGE_BUS_NAME: platformEventBus.eventBusName,
      EVENTBRIDGE_DEFAULT_BUS_NAME: platformEventBus.eventBusName,
      EVENTBRIDGE_COMMERCE_BUS_NAME: commerceEventBus.eventBusName,
      EVENTBRIDGE_PAYMENT_BUS_NAME: paymentEventBus.eventBusName,
      EVENTBRIDGE_PLATFORM_BUS_NAME: platformEventBus.eventBusName,
      EVENTBRIDGE_COMMERCE_ARCHIVE_ARN: commerceArchive.attrArn,
      EVENTBRIDGE_PAYMENT_ARCHIVE_ARN: paymentArchive.attrArn,
      EVENTBRIDGE_PLATFORM_ARCHIVE_ARN: platformArchive.attrArn,
      INVENTORY_ALERT_OUTBOX_ENABLED: inventoryOutboxEnabled.valueAsString,
      EMAIL_EVENT_PUBLISH_MAX_ATTEMPTS: "5",
      EMAIL_EVENT_PUBLISH_RETRY_BASE_SECONDS: "60",
      EMAIL_EVENT_PUBLISH_RETRY_MAX_SECONDS: "900",
      EMAIL_EVENT_PUBLISH_LEASE_SECONDS: "120",
      CHECKOUT_TX_RACE_LOGGING: "false",
      SNS_ADMIN_ALERTS_TOPIC_ARN: adminAlertsTopic.topicArn,
      SES_FROM_EMAIL: sesFromEmail.valueAsString,
      SES_AUTH_FROM_EMAIL: sesAuthFromEmail.valueAsString,
      SES_ORDERS_FROM_EMAIL: sesOrdersFromEmail.valueAsString,
      SES_REPLY_TO_EMAIL: sesReplyToEmail.valueAsString,
      STOREFRONT_PUBLIC_URL: storefrontPublicUrl.valueAsString,
      SES_INVENTORY_REPORT_CONFIGURATION_SET_NAME: inventoryReportConfigurationSet.ref,
      ADMIN_REPORT_EMAIL: adminReportEmail.valueAsString,
      VNPAY_TMN_CODE: vnpayTmnCodeValue,
      VNPAY_HASH_SECRET: vnpayHashSecretValue,
      VNPAY_PAYMENT_URL: vnpayPaymentUrlValue,
      VNPAY_TRANSACTION_URL: vnpayTransactionUrl.valueAsString,
      VNPAY_MERCHANT_IP: vnpayMerchantIp.valueAsString,
      VNPAY_RETURN_URL: vnpayReturnUrl.valueAsString,
      VNPAY_IPN_URL: vnpayIpnUrl.valueAsString
    };

    const attachSharedPolicies = (fn: lambda.Function) => {
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:UpdateItem",
          "dynamodb:TransactWriteItems"
        ],
        resources: [
          table.attrArn,
          `${table.attrArn}/index/*`
        ]
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ses:SendBulkEmail",
          "ses:SendBulkTemplatedEmail",
          "ses:GetAccount",
          "ses:GetEmailIdentity"
        ],
        resources: ["*"]
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:DeleteMessageBatch",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility",
          "sqs:ChangeMessageVisibilityBatch"
        ],
        resources: [
          notificationsDlq.queueArn,
          storefrontOrdersDlq.queueArn,
          paymentEventsDlq.queueArn,
          emailJobsDlq.queueArn,
          imageUploadsDlq.queueArn,
          eventBridgeTargetDlq.queueArn,
          emailEventBridgeDeliveryDlq.queueArn
        ]
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["events:PutEvents"],
        resources: [
          commerceEventBus.eventBusArn,
          paymentEventBus.eventBusArn,
          platformEventBus.eventBusArn
        ]
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["events:StartReplay", "events:DescribeReplay"],
        resources: [
          commerceArchive.attrArn,
          paymentArchive.attrArn,
          platformArchive.attrArn,
          `arn:aws:events:${this.region}:${this.account}:replay/*`
        ]
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["sns:Publish"],
        resources: [adminAlertsTopic.topicArn]
      }));

      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ],
        resources: [
          productImagesBucket.arnForObjects("public/*"),
          productImagesBucket.arnForObjects("private/*")
        ]
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [productImagesBucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": [
              "public/*",
              "private/*"
            ]
          }
        }
      }));
      notificationsQueue.grantSendMessages(fn);
      auditQueue.grantSendMessages(fn);
      storefrontOrdersQueue.grantSendMessages(fn);
      paymentEventsQueue.grantSendMessages(fn);
      emailJobsQueue.grantSendMessages(fn);
      imageUploadsQueue.grantSendMessages(fn);
    };

    const createApplicationLambda = (
      id: string,
      functionName: string,
      handler: string,
      timeoutSeconds = 10,
      memorySize = 256
    ) => {
      const fn = new lambda.Function(this, id, {
        functionName,
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.X86_64,
        handler,
        timeout: Duration.seconds(timeoutSeconds),
        memorySize,
        code: sharedLambdaCode,
        environment: {
          ...sharedEnvironment,
          LAMBDA_FUNCTION_CONTEXT: functionName
        }
      });

      attachSharedPolicies(fn);
      return fn;
    };

    const httpApiFunction = createApplicationLambda(
      "SupermarketHttpApiFunction",
      "supermarket-http-api-aws",
      "src/entrypoints/lambda/http/admin.handler",
      25,
      256
    );
    httpApiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:GetItem",
        "dynamodb:Query"
      ],
      resources: [
        auditLogTable.attrArn,
        `${auditLogTable.attrArn}/index/*`
      ]
    }));
    const auditLogWorkerDlq = new sqs.Queue(this, "AuditLogWorkerDlq", {
      queueName: "supermarket-audit-log-worker-dlq.fifo",
      fifo: true,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true
    });
    const auditLogMainQueue = new sqs.Queue(this, "AuditLogMainQueue", {
      queueName: "supermarket-audit-log-main.fifo",
      fifo: true,
      visibilityTimeout: Duration.minutes(3),
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: auditLogWorkerDlq, maxReceiveCount: 5 }
    });
    this.auditLogMainQueue = auditLogMainQueue;
    // Keep the URL export until the old Stream publisher stack is replaced by the Pipe.
    // The deployed publisher still imports this value during the API-first deployment.
    this.exportValue(auditLogMainQueue.queueUrl);
    httpApiFunction.addEnvironment("SQS_AUDIT_LOG_QUEUE_URL", auditLogMainQueue.queueUrl);
    httpApiFunction.addEnvironment("SQS_AUDIT_LOG_WORKER_DLQ_URL", auditLogWorkerDlq.queueUrl);
    auditLogMainQueue.grantSendMessages(httpApiFunction);
    auditLogWorkerDlq.grantConsumeMessages(httpApiFunction);
    const auditLogWorkerFunction = new lambda.Function(this, "AuditLogWorkerFunction", {
      functionName: "supermarket-audit-log-worker",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      handler: "src/entrypoints/lambda/queue/audit-log-worker.handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      code: sharedLambdaCode,
      environment: { AUDIT_LOG_TABLE_NAME: auditLogTable.tableName ?? "supermarket-audit-log" }
    });
    auditLogWorkerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [auditLogTable.attrArn]
    }));
    auditLogWorkerFunction.addEventSource(new lambdaEventSources.SqsEventSource(auditLogMainQueue, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));
    httpApiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cognito-idp:ListUsers"],
      resources: [userPool.userPoolArn]
    }));
    const orderWorkerFunction = createApplicationLambda(
      "SupermarketOrderWorkerFunction",
      "supermarket-order-worker-aws",
      "src/entrypoints/lambda/queue/order-worker.handler",
      20,
      512
    );
    const notificationWorkerFunction = createApplicationLambda(
      "SupermarketNotificationWorkerFunction",
      "supermarket-notification-worker-aws",
      "src/entrypoints/lambda/queue/notification-worker.handler",
      20,
      512
    );
    const paymentWorkerFunction = createApplicationLambda(
      "SupermarketPaymentWorkerFunction",
      "supermarket-payment-worker-aws",
      "src/entrypoints/lambda/queue/payment-worker.handler",
      20,
      512
    );
    const emailWorkerFunction = createApplicationLambda(
      "SupermarketEmailWorkerFunction",
      "supermarket-email-worker-aws",
      "src/entrypoints/lambda/queue/email-worker.handler",
      60,
      1024
    );
    emailWorkerFunction.addEnvironment(
      "EMAIL_WORKER_TEST_MODE",
      emailWorkerTestMode.valueAsString
    );
    emailWorkerFunction.addEnvironment("DYNAMODB_IDEMPOTENCY_TABLE_NAME", idempotencyTable.tableName);
    idempotencyTable.grantReadWriteData(emailWorkerFunction);
    for (const workerFunction of [
      orderWorkerFunction,
      notificationWorkerFunction,
      paymentWorkerFunction
    ]) {
      workerFunction.addEnvironment("DYNAMODB_IDEMPOTENCY_TABLE_NAME", idempotencyTable.tableName);
      idempotencyTable.grantReadWriteData(workerFunction);
    }
    const emailRouteTrackerFunction = createApplicationLambda(
      "SupermarketEmailRouteTrackerFunction",
      "supermarket-email-route-tracker-aws",
      "src/entrypoints/lambda/jobs/email-route-tracker.handler",
      10,
      256
    );
    const emailRoutingWatchdogFunction = createApplicationLambda(
      "SupermarketEmailRoutingWatchdogFunction",
      "supermarket-email-routing-watchdog-aws",
      "src/entrypoints/lambda/jobs/email-routing-watchdog.handler",
      30,
      256
    );
    emailRoutingWatchdogFunction.addEnvironment("EMAIL_ROUTING_ACK_TIMEOUT_SECONDS", "300");
    const emailPublishRecoveryFunction = createApplicationLambda(
      "SupermarketEmailPublishRecoveryFunction",
      "supermarket-email-publish-recovery-aws",
      "src/entrypoints/lambda/jobs/email-publish-recovery.handler",
      30,
      256
    );
    // Dedicated relay: no HTTP/SES/payment privileges or provider secrets.
    const inventoryOutboxRelay = new lambda.Function(this, "InventoryAlertOutboxRelayFunction", {
      functionName: "supermarket-inventory-alert-outbox-relay", runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64, code: sharedLambdaCode,
      handler: "src/entrypoints/lambda/jobs/inventory-alert-relay.handler",
      timeout: Duration.seconds(30), memorySize: 256,
      environment: { DYNAMODB_TABLE_NAME: table.ref, EVENTBRIDGE_PLATFORM_BUS_NAME: platformEventBus.eventBusName }
    });
    inventoryOutboxRelay.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query"], resources: [table.attrArn + "/index/EntityUpdatedAtIndex"]
    }));
    inventoryOutboxRelay.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:UpdateItem"], resources: [table.attrArn]
    }));
    platformEventBus.grantPutEventsTo(inventoryOutboxRelay);
    new events.Rule(this, "InventoryAlertOutboxRelaySchedule", {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(inventoryOutboxRelay, { retryAttempts: 2 })]
    });
    new cloudwatch.Alarm(this, "InventoryAlertOutboxRelayErrors", {
      metric: inventoryOutboxRelay.metricErrors(), threshold: 1, evaluationPeriods: 1,
      alarmDescription: "Inventory alert outbox relay failed; inspect pending and FAILED records."
    }).addAlarmAction(new cloudwatchActions.SnsAction(adminAlertsTopic));
    new cloudwatch.Alarm(this, "InventoryAlertOutboxFailedEvents", {
      metric: new cloudwatch.Metric({ namespace: "Supermarket/InventoryOutbox", metricName: "Failed",
        dimensionsMap: { Service: "inventory-alert-relay" }, statistic: "Sum", period: Duration.minutes(5) }),
      threshold: 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Inventory outbox attempts exhausted; inspect FAILED events before requeue."
    }).addAlarmAction(new cloudwatchActions.SnsAction(adminAlertsTopic));

    new lambda.EventInvokeConfig(this, "EmailRouteTrackerInvokeConfig", {
      function: emailRouteTrackerFunction,
      maxEventAge: Duration.hours(1),
      retryAttempts: 2,
      onFailure: new lambdaDestinations.SqsDestination(emailRouteTrackerDlq)
    });
    new lambda.EventInvokeConfig(this, "EmailRoutingWatchdogInvokeConfig", {
      function: emailRoutingWatchdogFunction,
      maxEventAge: Duration.hours(1),
      retryAttempts: 2,
      onFailure: new lambdaDestinations.SqsDestination(emailRoutingWatchdogDlq)
    });
    new lambda.EventInvokeConfig(this, "EmailPublishRecoveryInvokeConfig", {
      function: emailPublishRecoveryFunction,
      maxEventAge: Duration.hours(1),
      retryAttempts: 2,
      onFailure: new lambdaDestinations.SqsDestination(emailPublishRecoveryDlq)
    });
    const weeklyAdminReportFunction = createApplicationLambda(
      "SupermarketWeeklyAdminReportFunction",
      "supermarket-weekly-admin-report-aws",
      "src/entrypoints/lambda/jobs/weekly-admin-report.handler",
      30,
      512
    );
    const dailyInventoryReportFunction = createApplicationLambda(
      "SupermarketDailyInventoryReportFunction",
      "supermarket-daily-inventory-report-aws",
      "src/entrypoints/lambda/jobs/daily-inventory-report.handler",
      30,
      512
    );
    const sesInventoryEventFunction = createApplicationLambda(
      "SupermarketSesInventoryEventFunction",
      "supermarket-ses-inventory-event-aws",
      "src/entrypoints/lambda/jobs/ses-inventory-event.handler",
      20,
      256
    );
    sesInventoryEventFunction.addEnvironment("SES_EVENTS_TOPIC_ARN", inventoryReportEventsTopic.topicArn);
    const sesFeedbackDlq = createSesFeedbackDlq(this);
    // SNS delivery failures and Lambda execution failures are separate stages.
    inventoryReportEventsTopic.addSubscription(new subscriptions.LambdaSubscription(sesInventoryEventFunction, {
      deadLetterQueue: sesFeedbackDlq
    }));
    new lambda.EventInvokeConfig(this, "SesFeedbackInvokeConfig", {
      function: sesInventoryEventFunction,
      maxEventAge: Duration.hours(6),
      retryAttempts: 2,
      onFailure: new lambdaDestinations.SqsDestination(sesFeedbackDlq)
    });
    new CfnOutput(this, "SesFeedbackConfigurationSetName", { value: inventoryReportConfigurationSet.ref });
    new CfnOutput(this, "SesFeedbackTopicArn", { value: inventoryReportEventsTopic.topicArn });
    new CfnOutput(this, "SesFeedbackDlqUrl", { value: sesFeedbackDlq.queueUrl });
    // The daily digest is deliberately best-effort; a failed run is summarized by the next day instead of retrying immediately.
    new lambda.EventInvokeConfig(this, "DailyInventoryReportInvokeConfig", {
      function: dailyInventoryReportFunction,
      maxEventAge: Duration.hours(1),
      retryAttempts: 0
    });
    const orderWorkflowStepFunction = createApplicationLambda(
      "SupermarketOrderWorkflowStepFunction",
      "supermarket-order-workflow-step-aws",
      "src/entrypoints/lambda/workflow/order-workflow-step.handler",
      30,
      512
    );
    const paymentWorkflowStepFunction = createApplicationLambda(
      "SupermarketPaymentWorkflowStepFunction",
      "supermarket-payment-workflow-step-aws",
      "src/entrypoints/lambda/workflow/payment-workflow-step.handler",
      30,
      512
    );
    const imageWorkflowStepFunction = createApplicationLambda(
      "SupermarketImageWorkflowStepFunction",
      "supermarket-image-workflow-step-aws",
      "src/entrypoints/lambda/workflow/image-workflow-step.handler",
      20,
      256
    );
    const buildWeeklyReportFunction = createApplicationLambda(
      "SupermarketBuildWeeklyReportFunction",
      "supermarket-build-weekly-report-aws",
      "src/entrypoints/lambda/workflow/build-weekly-report.handler",
      30,
      512
    );
    const sendMailWorkflowStepFunction = createApplicationLambda(
      "SupermarketSendMailWorkflowStepFunction",
      "supermarket-send-mail-workflow-step-aws",
      "src/entrypoints/lambda/workflow/send-mail-workflow-step.handler",
      20,
      256
    );
    const imageUploadWorkerFunction = createApplicationLambda(
      "SupermarketImageUploadWorkerFunction",
      "supermarket-image-upload-worker-aws",
      "src/entrypoints/lambda/queue/image-upload-worker.handler",
      20,
      256
    );
    imageUploadWorkerFunction.addEnvironment("DYNAMODB_IDEMPOTENCY_TABLE_NAME", idempotencyTable.tableName);
    idempotencyTable.grantReadWriteData(imageUploadWorkerFunction);
    const auditEventWorkerFunction = createApplicationLambda(
      "SupermarketAuditEventWorkerFunction",
      "supermarket-audit-event-worker-aws",
      "src/entrypoints/lambda/jobs/audit-event-worker.handler",
      15,
      256
    );
    const releaseExpiredOrdersFunction = createApplicationLambda(
      "SupermarketReleaseExpiredOrdersFunction",
      "supermarket-release-expired-orders-aws",
      "src/entrypoints/lambda/jobs/release-expired-orders.handler",
      20,
      256
    );
    const reconcilePendingRefundsFunction = createApplicationLambda(
      "SupermarketReconcilePendingRefundsFunction",
      "supermarket-reconcile-pending-refunds-aws",
      "src/entrypoints/lambda/jobs/reconcile-pending-refunds.handler",
      60,
      512
    );
    const reconcilePaymentEventsFunction = createApplicationLambda(
      "SupermarketReconcilePaymentEventsFunction",
      "supermarket-reconcile-payment-events-aws",
      "src/entrypoints/lambda/jobs/reconcile-payment-events.handler",
      60,
      512
    );
    const dataCleanupFunction = createApplicationLambda(
      "SupermarketDataCleanupFunction",
      "supermarket-data-cleanup-aws",
      "src/entrypoints/lambda/jobs/data-cleanup.handler",
      120,
      512
    );
    const saleCampaignWorkerFunction = createApplicationLambda(
      "SupermarketSaleCampaignWorkerFunction",
      "supermarket-sale-campaign-worker-aws",
      "src/entrypoints/lambda/jobs/sale-campaign-worker.handler",
      20,
      256
    );
    const saleSchedulerRole = new iam.Role(this, "SaleSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to activate and end sale campaigns"
    });
    saleSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [saleCampaignWorkerFunction.functionArn]
    }));
    httpApiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule"],
      resources: [
        saleSchedulerGroup.attrArn,
        `arn:aws:scheduler:${this.region}:${this.account}:schedule/${saleSchedulerGroup.name}/*`
      ]
    }));
    httpApiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [saleSchedulerRole.roleArn]
    }));
    httpApiFunction.addEnvironment("SALE_SCHEDULER_ROLE_ARN", saleSchedulerRole.roleArn);
    httpApiFunction.addEnvironment("SALE_SCHEDULER_GROUP_NAME", saleSchedulerGroup.ref);
    httpApiFunction.addEnvironment("SALE_SCHEDULER_TARGET_ARN", saleCampaignWorkerFunction.functionArn);
    new lambda.EventInvokeConfig(this, "DataCleanupInvokeConfig", {
      function: dataCleanupFunction,
      maxEventAge: Duration.hours(1),
      retryAttempts: 0
    });

    const orderWorkflowTask = new tasks.LambdaInvoke(this, "OrderWorkflowTask", {
      lambdaFunction: orderWorkflowStepFunction,
      payload: sfn.TaskInput.fromObject({
        detail: sfn.JsonPath.objectAt("$.detail")
      }),
      resultPath: "$.orderResult",
      payloadResponseOnly: true
    });

    const paymentWorkflowTask = new tasks.LambdaInvoke(this, "PaymentWorkflowTask", {
      lambdaFunction: paymentWorkflowStepFunction,
      payload: sfn.TaskInput.fromObject({
        detail: sfn.JsonPath.objectAt("$.detail"),
        orderResult: sfn.JsonPath.objectAt("$.orderResult")
      }),
      resultPath: "$.paymentResult",
      payloadResponseOnly: true
    });

    const imageWorkflowTask = new tasks.LambdaInvoke(this, "ImageWorkflowTask", {
      lambdaFunction: imageWorkflowStepFunction,
      payloadResponseOnly: true
    });

    const buildWeeklyReportTask = new tasks.LambdaInvoke(this, "BuildWeeklyReportTask", {
      lambdaFunction: buildWeeklyReportFunction,
      payloadResponseOnly: true
    });

    const sendWeeklyMailTask = new tasks.LambdaInvoke(this, "SendWeeklyMailTask", {
      lambdaFunction: sendMailWorkflowStepFunction,
      payload: sfn.TaskInput.fromObject({
        mailType: sfn.JsonPath.stringAt("$.mailType"),
        summary: sfn.JsonPath.objectAt("$.summary")
      }),
      payloadResponseOnly: true
    });

    const orderOutcomeChoice = new sfn.Choice(this, "OrderWorkflowOutcome");
    const orderPaymentWorkflow = new sfn.StateMachine(this, "OrderPaymentWorkflow", {
      stateMachineName: "supermarket-order-payment-workflow",
      definitionBody: sfn.DefinitionBody.fromChainable(
        orderWorkflowTask
          .addRetry({ maxAttempts: 2, interval: Duration.seconds(2) })
          .addCatch(new sfn.Fail(this, "OrderWorkflowFailed"), { resultPath: "$.error" })
          .next(orderOutcomeChoice
            .when(sfn.Condition.stringEquals("$.orderResult.outcome", "success"), paymentWorkflowTask)
            .otherwise(new sfn.Succeed(this, "OrderWorkflowCompletedWithoutPayment")))
      ),
      timeout: Duration.minutes(5)
    });

    const imageUploadWorkflow = new sfn.StateMachine(this, "ImageUploadWorkflow", {
      stateMachineName: "supermarket-image-upload-workflow",
      definitionBody: sfn.DefinitionBody.fromChainable(
        imageWorkflowTask
          .addRetry({ maxAttempts: 2, interval: Duration.seconds(2) })
          .next(new sfn.Succeed(this, "ImageWorkflowCompleted"))
      ),
      timeout: Duration.minutes(2)
    });

    const weeklyReportMailWorkflow = new sfn.StateMachine(this, "WeeklyReportMailWorkflow", {
      stateMachineName: "supermarket-weekly-report-mail-workflow",
      definitionBody: sfn.DefinitionBody.fromChainable(
        buildWeeklyReportTask
          .addRetry({ maxAttempts: 2, interval: Duration.seconds(2) })
          .next(sendWeeklyMailTask)
          .next(new sfn.Succeed(this, "WeeklyReportMailWorkflowCompleted"))
      ),
      timeout: Duration.minutes(5)
    });

    const createPipeRole = (id: string, sourceQueue: sqs.Queue, targetArn: string, extraStatements: iam.PolicyStatement[] = []) => {
      const role = new iam.Role(this, id, {
        assumedBy: new iam.ServicePrincipal("pipes.amazonaws.com")
      });

      role.addToPolicy(new iam.PolicyStatement({
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility"
        ],
        resources: [sourceQueue.queueArn]
      }));

      role.addToPolicy(new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [targetArn]
      }));

      for (const statement of extraStatements) {
        role.addToPolicy(statement);
      }

      return role;
    };

    const orderWorkerPipeRole = createPipeRole(
      "StorefrontOrdersPipeRole",
      storefrontOrdersQueue,
      orderWorkerFunction.functionArn
    );
    const notificationPipeRole = createPipeRole(
      "NotificationsPipeRole",
      notificationsQueue,
      notificationWorkerFunction.functionArn
    );
    const paymentPipeRole = createPipeRole(
      "PaymentEventsPipeRole",
      paymentEventsQueue,
      paymentWorkerFunction.functionArn
    );
    const emailJobsPipeRole = createPipeRole(
      "EmailJobsPipeRole",
      emailJobsQueue,
      emailWorkerFunction.functionArn
    );
    const imageUploadsPipeRole = new iam.Role(this, "ImageUploadsPipeRole", {
      assumedBy: new iam.ServicePrincipal("pipes.amazonaws.com")
    });
    imageUploadsPipeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility"
      ],
      resources: [imageUploadsQueue.queueArn]
    }));
    imageUploadsPipeRole.addToPolicy(new iam.PolicyStatement({
      actions: ["states:StartExecution"],
      resources: [imageUploadWorkflow.stateMachineArn]
    }));
    new pipes.CfnPipe(this, "StorefrontOrdersPipe", {
      name: "supermarket-storefront-orders-pipe",
      roleArn: orderWorkerPipeRole.roleArn,
      source: storefrontOrdersQueue.queueArn,
      target: orderWorkerFunction.functionArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 10
        }
      },
      targetParameters: {
        lambdaFunctionParameters: {
          invocationType: "REQUEST_RESPONSE"
        }
      }
    });

    new pipes.CfnPipe(this, "NotificationsPipe", {
      name: "supermarket-notifications-pipe",
      roleArn: notificationPipeRole.roleArn,
      source: notificationsQueue.queueArn,
      target: notificationWorkerFunction.functionArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 10
        }
      },
      targetParameters: {
        lambdaFunctionParameters: {
          invocationType: "REQUEST_RESPONSE"
        }
      }
    });

    new pipes.CfnPipe(this, "PaymentEventsPipe", {
      name: "supermarket-payment-events-pipe",
      roleArn: paymentPipeRole.roleArn,
      source: paymentEventsQueue.queueArn,
      target: paymentWorkerFunction.functionArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 10
        }
      },
      targetParameters: {
        lambdaFunctionParameters: {
          invocationType: "REQUEST_RESPONSE"
        }
      }
    });

    new pipes.CfnPipe(this, "EmailJobsPipe", {
      name: "supermarket-email-jobs-pipe",
      roleArn: emailJobsPipeRole.roleArn,
      source: emailJobsQueue.queueArn,
      target: emailWorkerFunction.functionArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 5
        }
      },
      targetParameters: {
        lambdaFunctionParameters: {
          invocationType: "REQUEST_RESPONSE"
        }
      }
    });

    new pipes.CfnPipe(this, "ImageUploadsPipe", {
      name: "supermarket-image-uploads-pipe",
      roleArn: imageUploadsPipeRole.roleArn,
      source: imageUploadsQueue.queueArn,
      target: imageUploadWorkflow.stateMachineArn,
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 10
        }
      },
      targetParameters: {
        stepFunctionStateMachineParameters: {
          invocationType: "FIRE_AND_FORGET"
        }
      }
    });

    productImagesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.SqsDestination(imageUploadsQueue)
    );

    new events.Rule(this, "CommerceOrderRequestedRule", {
      eventBus: commerceEventBus,
      ruleName: "supermarket-commerce-order-requested-rule",
      eventPattern: {
        source: ["supermarket.commerce"],
        detailType: ["storefront.order.requested"]
      },
      targets: [new eventsTargets.SfnStateMachine(orderPaymentWorkflow, {
        deadLetterQueue: eventBridgeTargetDlq,
        retryAttempts: 2
      })]
    });

    new events.Rule(this, "CommerceLifecycleAuditRule", {
      eventBus: commerceEventBus,
      ruleName: "supermarket-commerce-lifecycle-audit-rule",
      eventPattern: {
        source: ["supermarket.commerce"]
      },
      targets: [new eventsTargets.LambdaFunction(auditEventWorkerFunction, {
        deadLetterQueue: eventBridgeTargetDlq,
        retryAttempts: 2
      })]
    });

    new events.Rule(this, "PaymentLifecycleQueueRule", {
      eventBus: paymentEventBus,
      ruleName: "supermarket-payment-lifecycle-queue-rule",
      eventPattern: {
        source: ["supermarket.payment"],
        detailType: ["payments.vnpay.completed", "payments.vnpay.failed"]
      },
      targets: [new eventsTargets.SqsQueue(paymentEventsQueue, {
        deadLetterQueue: eventBridgeTargetDlq
      })]
    });

    new events.Rule(this, "PaymentLifecycleAuditRule", {
      eventBus: paymentEventBus,
      ruleName: "supermarket-payment-lifecycle-audit-rule",
      eventPattern: {
        source: ["supermarket.payment"]
      },
      targets: [new eventsTargets.LambdaFunction(auditEventWorkerFunction, {
        deadLetterQueue: eventBridgeTargetDlq,
        retryAttempts: 2
      })]
    });

    new events.Rule(this, "PlatformNotificationsRule", {
      eventBus: platformEventBus,
      ruleName: "supermarket-platform-notifications-rule",
      eventPattern: {
        source: ["supermarket.platform"],
        detailType: ["notifications.pending"]
      },
      targets: [new eventsTargets.SqsQueue(notificationsQueue, {
        deadLetterQueue: eventBridgeTargetDlq
      })]
    });

    new events.Rule(this, "InventoryAdminAlertsRule", {
      eventBus: platformEventBus,
      ruleName: "supermarket-inventory-admin-alerts-rule",
      eventPattern: {
        source: ["supermarket.inventory"],
        detailType: ["inventory.stock.alert"],
        detail: {
          alertLevel: ["low_stock", "out_of_stock"]
        }
      },
      targets: [new eventsTargets.SqsQueue(notificationsQueue, {
        deadLetterQueue: eventBridgeTargetDlq
      })]
    });

    new events.Rule(this, "PlatformAuditRule", {
      eventBus: platformEventBus,
      ruleName: "supermarket-platform-audit-rule",
      eventPattern: {
        source: ["supermarket.platform"],
        detailType: ["audit.log.created"]
      },
      targets: [new eventsTargets.LambdaFunction(auditEventWorkerFunction, {
        deadLetterQueue: eventBridgeTargetDlq,
        retryAttempts: 2
      })]
    });

    const weeklyAdminRevenueReportSchedulerRole = new iam.Role(this, "WeeklyAdminRevenueReportSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to start the weekly admin revenue report workflow"
    });
    weeklyAdminRevenueReportSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["states:StartExecution"],
      resources: [weeklyReportMailWorkflow.stateMachineArn]
    }));
    weeklyAdminRevenueReportSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [eventBridgeTargetDlq.queueArn]
    }));

    new scheduler.CfnSchedule(this, "WeeklyAdminRevenueReportSchedule", {
      name: "supermarket-weekly-admin-revenue-report",
      description: "Triggers the weekly admin revenue report workflow every Monday at 02:45 UTC.",
      groupName: "default",
      scheduleExpression: "cron(45 2 ? * MON *)",
      flexibleTimeWindow: {
        mode: "OFF"
      },
      target: {
        arn: weeklyReportMailWorkflow.stateMachineArn,
        roleArn: weeklyAdminRevenueReportSchedulerRole.roleArn,
        deadLetterConfig: {
          arn: eventBridgeTargetDlq.queueArn
        },
        retryPolicy: {
          maximumEventAgeInSeconds: 3600,
          maximumRetryAttempts: 2
        },
        input: JSON.stringify({
          source: "scheduler.weekly-admin-revenue-report"
        })
      }
    });

    const dailyInventoryReportSchedulerRole = new iam.Role(this, "DailyInventoryReportSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to invoke the daily inventory digest Lambda"
    });
    dailyInventoryReportSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [dailyInventoryReportFunction.functionArn]
    }));
    dailyInventoryReportSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [eventBridgeTargetDlq.queueArn]
    }));

    new scheduler.CfnSchedule(this, "DailyInventoryReportSchedule", {
      name: "supermarket-daily-inventory-report",
      description: "Invokes the inventory alert check at 22:00 in Vietnam; the worker sends on alternating calendar days.",
      groupName: "default",
      scheduleExpression: "cron(0 22 * * ? *)",
      scheduleExpressionTimezone: "Asia/Ho_Chi_Minh",
      flexibleTimeWindow: {
        mode: "OFF"
      },
      target: {
        arn: dailyInventoryReportFunction.functionArn,
        roleArn: dailyInventoryReportSchedulerRole.roleArn,
        deadLetterConfig: {
          arn: eventBridgeTargetDlq.queueArn
        },
        retryPolicy: {
          maximumEventAgeInSeconds: 60,
          maximumRetryAttempts: 0
        },
        input: JSON.stringify({
          source: "scheduler.daily-inventory-report"
        })
      }
    });

    const releaseExpiredOrdersSchedulerRole = new iam.Role(this, "ReleaseExpiredOrdersSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to release expired awaiting-payment orders"
    });
    const reconcilePendingRefundsSchedulerRole = new iam.Role(this, "ReconcilePendingRefundsSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to reconcile pending VNPay refunds"
    });
    const reconcilePaymentEventsSchedulerRole = new iam.Role(this, "ReconcilePaymentEventsSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to recover payment events after an interrupted hand-off"
    });

    const emailRoutingWatchdogSchedulerRole = new iam.Role(this, "EmailRoutingWatchdogSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to invoke the email routing watchdog"
    });
    emailRoutingWatchdogSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [emailRoutingWatchdogFunction.functionArn]
    }));
    emailRoutingWatchdogSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [emailRoutingWatchdogDlq.queueArn]
    }));

    new scheduler.CfnSchedule(this, "EmailRoutingWatchdogSchedule", {
      name: "supermarket-email-routing-watchdog",
      description: "Detects email events accepted by the bus but not acknowledged by the routing rule within five minutes.",
      groupName: "default",
      scheduleExpression: "rate(1 minute)",
      flexibleTimeWindow: {
        mode: "OFF"
      },
      target: {
        arn: emailRoutingWatchdogFunction.functionArn,
        roleArn: emailRoutingWatchdogSchedulerRole.roleArn,
        deadLetterConfig: {
          arn: emailRoutingWatchdogDlq.queueArn
        },
        retryPolicy: {
          maximumEventAgeInSeconds: 300,
          maximumRetryAttempts: 2
        },
        input: JSON.stringify({
          source: "scheduler.email-routing-watchdog"
        })
      }
    });

    const emailPublishRecoverySchedulerRole = new iam.Role(this, "EmailPublishRecoverySchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to invoke the email publish recovery worker"
    });
    emailPublishRecoverySchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [emailPublishRecoveryFunction.functionArn]
    }));
    emailPublishRecoverySchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [emailPublishRecoveryDlq.queueArn]
    }));

    new scheduler.CfnSchedule(this, "EmailPublishRecoverySchedule", {
      name: "supermarket-email-publish-recovery",
      description: "Retries due EventBridge email publishes with persisted exponential backoff state.",
      groupName: "default",
      scheduleExpression: "rate(1 minute)",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: emailPublishRecoveryFunction.functionArn,
        roleArn: emailPublishRecoverySchedulerRole.roleArn,
        deadLetterConfig: { arn: emailPublishRecoveryDlq.queueArn },
        retryPolicy: {
          maximumEventAgeInSeconds: 300,
          maximumRetryAttempts: 2
        },
        input: JSON.stringify({ source: "scheduler.email-publish-recovery" })
      }
    });

    new events.Rule(this, "PlatformSaleCampaignEmailRule", {
      eventBus: platformEventBus,
      ruleName: "supermarket-platform-sale-campaign-email-rule",
      eventPattern: {
        source: ["supermarket.email"],
        detailType: ["email.sale_campaign.requested", "email.order_confirmation.requested"]
      },
      targets: [
        new eventsTargets.SqsQueue(emailJobsQueue, {
          deadLetterQueue: emailEventBridgeDeliveryDlq,
          retryAttempts: 2
        }),
        // Acknowledges that this exact rule matched the event. Without this
        // second target, a stale PUBLISHED record cannot be distinguished from
        // target delivery or worker backlog using per-event data alone.
        new eventsTargets.LambdaFunction(emailRouteTrackerFunction, {
          deadLetterQueue: emailRouteTrackerDlq,
          retryAttempts: 2,
          maxEventAge: Duration.hours(1)
        })
      ]
    });

    new events.Rule(this, "PlatformAccountWelcomeEmailRule", {
      eventBus: platformEventBus,
      ruleName: "supermarket-platform-account-welcome-email-rule",
      eventPattern: {
        source: ["supermarket.email"],
        detailType: ["email.account_welcome.requested"]
      },
      targets: [
        new eventsTargets.SqsQueue(emailJobsQueue, {
          deadLetterQueue: emailEventBridgeDeliveryDlq,
          retryAttempts: 2
        })
      ]
    });

    const emailEventBridgeFailureTestRule = new events.Rule(this, "EmailEventBridgeFailureTestRule", {
      eventBus: platformEventBus,
      ruleName: "supermarket-email-eventbridge-failure-test-rule",
      enabled: false,
      eventPattern: {
        source: ["supermarket.email.test"],
        detailType: ["email.eventbridge.delivery-failure.test"]
      },
      targets: [
        new eventsTargets.SqsQueue(emailEventBridgeFailureTestTargetQueue, {
          // Use the real email delivery DLQ so Admin UI exercises the same
          // controlled replay path as production failures. NO_PERMISSIONS is
          // permanent and may bypass retries, but the policy is intentionally
          // identical to production for retryable failures.
          deadLetterQueue: emailEventBridgeDeliveryDlq,
          retryAttempts: 2
        }),
        // The isolated test event also goes through the real acknowledgement
        // handler. This proves that a Rule can be RULE_MATCHED while another
        // target (the SQS delivery) independently fails into its DLQ.
        new eventsTargets.LambdaFunction(emailRouteTrackerFunction, {
          deadLetterQueue: emailRouteTrackerDlq,
          retryAttempts: 2,
          maxEventAge: Duration.hours(1)
        })
      ]
    });
    // Explicit Deny wins over the Allow CDK adds for the target. The test
    // rule therefore fails delivery immediately and proves its own DLQ path.
    emailEventBridgeFailureTestTargetQueue.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      principals: [new iam.ServicePrincipal("events.amazonaws.com")],
      actions: ["sqs:SendMessage"],
      resources: [emailEventBridgeFailureTestTargetQueue.queueArn],
      conditions: { ArnEquals: { "aws:SourceArn": emailEventBridgeFailureTestRule.ruleArn } }
    }));

    new events.Rule(this, "EmailEventBridgeSuccessTestRule", {
      eventBus: platformEventBus,
      ruleName: "supermarket-email-eventbridge-success-test-rule",
      enabled: false,
      eventPattern: {
        source: ["supermarket.email.test"],
        detailType: [
          "email.eventbridge.delivery-success.test",
          "email.eventbridge.delivery-failure.test"
        ]
      },
      targets: [
        new eventsTargets.SqsQueue(emailEventBridgeSuccessTestQueue),
        // Archive Replay of an event missed by a disabled/non-matching Rule
        // must restore both delivery and the per-event tracking state.
        new eventsTargets.LambdaFunction(emailRouteTrackerFunction, {
          deadLetterQueue: emailRouteTrackerDlq,
          retryAttempts: 2,
          maxEventAge: Duration.hours(1)
        })
      ]
    });
    releaseExpiredOrdersSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [releaseExpiredOrdersFunction.functionArn]
    }));
    releaseExpiredOrdersSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [eventBridgeTargetDlq.queueArn]
    }));

    new scheduler.CfnSchedule(this, "ReleaseExpiredOrdersSchedule", {
      name: "supermarket-release-expired-orders",
      description: "Releases inventory held by orders whose payment window has expired.",
      groupName: "default",
      scheduleExpression: "rate(1 minute)",
      flexibleTimeWindow: {
        mode: "OFF"
      },
      target: {
        arn: releaseExpiredOrdersFunction.functionArn,
        roleArn: releaseExpiredOrdersSchedulerRole.roleArn,
        deadLetterConfig: {
          arn: eventBridgeTargetDlq.queueArn
        },
        retryPolicy: {
          maximumEventAgeInSeconds: 300,
          maximumRetryAttempts: 2
        },
        input: JSON.stringify({
          source: "scheduler.release-expired-orders"
        })
      }
    });

    reconcilePendingRefundsSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [reconcilePendingRefundsFunction.functionArn]
    }));
    reconcilePendingRefundsSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [eventBridgeTargetDlq.queueArn]
    }));
    new scheduler.CfnSchedule(this, "ReconcilePendingRefundsSchedule", {
      name: "supermarket-reconcile-pending-refunds",
      description: "Reconciles pending VNPay refunds even when the customer closes the browser.",
      groupName: "default",
      scheduleExpression: "rate(5 minutes)",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: reconcilePendingRefundsFunction.functionArn,
        roleArn: reconcilePendingRefundsSchedulerRole.roleArn,
        deadLetterConfig: { arn: eventBridgeTargetDlq.queueArn },
        retryPolicy: { maximumEventAgeInSeconds: 900, maximumRetryAttempts: 2 },
        input: JSON.stringify({ source: "scheduler.reconcile-pending-refunds" })
      }
    });

    reconcilePaymentEventsSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [reconcilePaymentEventsFunction.functionArn]
    }));
    reconcilePaymentEventsSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [eventBridgeTargetDlq.queueArn]
    }));
    new scheduler.CfnSchedule(this, "ReconcilePaymentEventsSchedule", {
      name: "supermarket-reconcile-payment-events",
      description: "Publishes payment events that were finalized before EventBridge hand-off completed.",
      groupName: "default",
      scheduleExpression: "rate(1 minute)",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: reconcilePaymentEventsFunction.functionArn,
        roleArn: reconcilePaymentEventsSchedulerRole.roleArn,
        deadLetterConfig: { arn: eventBridgeTargetDlq.queueArn },
        retryPolicy: { maximumEventAgeInSeconds: 300, maximumRetryAttempts: 2 },
        input: JSON.stringify({ source: "scheduler.reconcile-payment-events" })
      }
    });

    const dataCleanupSchedulerRole = new iam.Role(this, "DataCleanupSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to invoke the scheduled data cleanup Lambda"
    });
    dataCleanupSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [dataCleanupFunction.functionArn]
    }));
    dataCleanupSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [eventBridgeTargetDlq.queueArn]
    }));

    new scheduler.CfnSchedule(this, "DataCleanupSchedule", {
      name: "supermarket-data-cleanup",
      description: "Checks cleanup eligibility at midnight Vietnam time and deletes short-lived operational data after three days.",
      groupName: "default",
      scheduleExpression: "cron(0 0 * * ? *)",
      scheduleExpressionTimezone: "Asia/Ho_Chi_Minh",
      flexibleTimeWindow: {
        mode: "OFF"
      },
      target: {
        arn: dataCleanupFunction.functionArn,
        roleArn: dataCleanupSchedulerRole.roleArn,
        deadLetterConfig: {
          arn: eventBridgeTargetDlq.queueArn
        },
        retryPolicy: {
          maximumEventAgeInSeconds: 60,
          maximumRetryAttempts: 0
        },
        input: JSON.stringify({
          source: "scheduler.data-cleanup"
        })
      }
    });

    // AWS Budgets data is delayed, so $70 is a deliberately early protective threshold.
    // The CostGuard function itself and the Cognito trigger are deliberately excluded from
    // the $100 Lambda throttle list: the former is needed for audit/recovery and the latter
    // avoids permanently breaking account sign-in.
    const costGuardStateParameterName = "/supermarket/cost-guard/state";
    const allApplicationLambdaNames = [
      httpApiFunction.functionName,
      orderWorkerFunction.functionName,
      notificationWorkerFunction.functionName,
      paymentWorkerFunction.functionName,
      weeklyAdminReportFunction.functionName,
      dailyInventoryReportFunction.functionName,
      sesInventoryEventFunction.functionName,
      orderWorkflowStepFunction.functionName,
      paymentWorkflowStepFunction.functionName,
      imageWorkflowStepFunction.functionName,
      buildWeeklyReportFunction.functionName,
      sendMailWorkflowStepFunction.functionName,
      imageUploadWorkerFunction.functionName,
      auditEventWorkerFunction.functionName,
      releaseExpiredOrdersFunction.functionName,
      reconcilePendingRefundsFunction.functionName,
      reconcilePaymentEventsFunction.functionName,
      dataCleanupFunction.functionName,
      saleCampaignWorkerFunction.functionName
    ];
    const allPipes = [
      "supermarket-storefront-orders-pipe",
      "supermarket-notifications-pipe",
      "supermarket-payment-events-pipe",
      "supermarket-image-uploads-pipe"
    ];
    const allRules = [
      { name: "supermarket-commerce-order-requested-rule", eventBusName: commerceEventBus.eventBusName },
      { name: "supermarket-commerce-lifecycle-audit-rule", eventBusName: commerceEventBus.eventBusName },
      { name: "supermarket-payment-lifecycle-queue-rule", eventBusName: paymentEventBus.eventBusName },
      { name: "supermarket-payment-lifecycle-audit-rule", eventBusName: paymentEventBus.eventBusName },
      { name: "supermarket-platform-notifications-rule", eventBusName: platformEventBus.eventBusName },
      { name: "supermarket-inventory-admin-alerts-rule", eventBusName: platformEventBus.eventBusName },
      { name: "supermarket-platform-audit-rule", eventBusName: platformEventBus.eventBusName }
    ];
    const staticSchedules = [
      { name: "supermarket-weekly-admin-revenue-report", groupName: "default" },
      { name: "supermarket-daily-inventory-report", groupName: "default" },
      { name: "supermarket-release-expired-orders", groupName: "default" },
      { name: "supermarket-data-cleanup", groupName: "default" }
    ];
    const partialSchedules = staticSchedules.filter((schedule) => [
      "supermarket-weekly-admin-revenue-report",
      "supermarket-daily-inventory-report",
      "supermarket-data-cleanup"
    ].includes(schedule.name));
    const partialLambdas = [
      weeklyAdminReportFunction.functionName,
      dailyInventoryReportFunction.functionName,
      imageWorkflowStepFunction.functionName,
      buildWeeklyReportFunction.functionName,
      sendMailWorkflowStepFunction.functionName,
      imageUploadWorkerFunction.functionName,
      auditEventWorkerFunction.functionName,
      dataCleanupFunction.functionName,
      saleCampaignWorkerFunction.functionName
    ];
    const partialRules = allRules.filter((rule) => rule.name.endsWith("-audit-rule"));

    const costGuardBudgetTopic = new sns.Topic(this, "CostGuardBudgetTopic", {
      topicName: "supermarket-cost-guard-budget-events",
      displayName: "Supermarket CostGuard budget events"
    });
    costGuardBudgetTopic.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
      actions: ["sns:Publish"],
      resources: [costGuardBudgetTopic.topicArn],
      conditions: { StringEquals: { "AWS:SourceAccount": this.account } }
    }));

    const costGuardFunction = new lambda.Function(this, "CostGuardFunction", {
      functionName: "supermarket-cost-guard",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "cost_guard.handler",
      timeout: Duration.minutes(5),
      memorySize: 256,
      code: lambda.Code.fromAsset(path.resolve(__dirname, "../lambda")),
      environment: {
        ALERT_EMAIL: adminReportEmail.valueAsString,
        SES_FROM_EMAIL: sesFromEmail.valueAsString,
        SES_REPLY_TO_EMAIL: sesReplyToEmail.valueAsString,
        STATE_PARAMETER_NAME: costGuardStateParameterName,
        SALE_SCHEDULE_GROUP: saleSchedulerGroup.ref,
        ALL_APPLICATION_LAMBDAS: JSON.stringify(allApplicationLambdaNames),
        PARTIAL_LAMBDAS: JSON.stringify(partialLambdas),
        ALL_PIPES: JSON.stringify(allPipes),
        PARTIAL_PIPES: JSON.stringify([
          "supermarket-notifications-pipe",
          "supermarket-image-uploads-pipe"
        ]),
        ALL_RULES: JSON.stringify(allRules),
        PARTIAL_RULES: JSON.stringify(partialRules),
        STATIC_SCHEDULES: JSON.stringify(staticSchedules),
        PARTIAL_SCHEDULES: JSON.stringify(partialSchedules),
        STATE_MACHINES: JSON.stringify([
          orderPaymentWorkflow.stateMachineArn,
          imageUploadWorkflow.stateMachineArn,
          weeklyReportMailWorkflow.stateMachineArn
        ])
      }
    });
    costGuardFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "lambda:PutFunctionConcurrency",
        "events:DisableRule",
        "pipes:UpdatePipe",
        "scheduler:GetSchedule",
        "scheduler:ListSchedules",
        "scheduler:UpdateSchedule",
        "states:ListExecutions",
        "states:StopExecution",
        "ssm:PutParameter",
        "ses:SendEmail"
      ],
      resources: ["*"]
    }));
    costGuardBudgetTopic.addSubscription(new subscriptions.LambdaSubscription(costGuardFunction));

    new budgets.CfnBudget(this, "MonthlyCostGuardBudget", {
      budget: {
        budgetName: "supermarket-monthly-cost-guard-usd",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: 100, unit: "USD" },
        costTypes: {
          includeCredit: true,
          includeDiscount: true,
          includeOtherSubscription: true,
          includeRecurring: true,
          includeRefund: false,
          includeSubscription: true,
          includeSupport: true,
          includeTax: true,
          includeUpfront: true,
          useAmortized: false,
          useBlended: false
        }
      },
      notificationsWithSubscribers: [5, 10, 15, 20, 50, 70, 100].map((threshold) => ({
        notification: {
          comparisonOperator: "GREATER_THAN",
          notificationType: "ACTUAL",
          threshold,
          thresholdType: "ABSOLUTE_VALUE"
        },
        subscribers: [{
          address: costGuardBudgetTopic.topicArn,
          subscriptionType: "SNS"
        }]
      }))
    });

    const createDlqAlarm = (id: string, queue: sqs.Queue, queueName: string) => {
      return new cloudwatch.Alarm(this, id, {
        alarmName: `${queueName}-messages-visible`,
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
          statistic: "Maximum"
        }),
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `DLQ ${queueName} có message cần kiểm tra`
      });
    };

    createDlqAlarm("NotificationsDlqAlarm", notificationsDlq, "supermarket-notifications-dlq");
    createDlqAlarm("SesFeedbackDlqAlarm", sesFeedbackDlq, "supermarket-ses-feedback-dlq");
    createDlqAlarm("EmailJobsDlqAlarm", emailJobsDlq, "supermarket-email-jobs-dlq");
    createDlqAlarm("EmailEventBridgeDeliveryDlqAlarm", emailEventBridgeDeliveryDlq, "supermarket-email-eventbridge-delivery-dlq");
    createDlqAlarm("EmailRouteTrackerDlqAlarm", emailRouteTrackerDlq, "supermarket-email-route-tracker-dlq");
    createDlqAlarm("EmailRoutingWatchdogDlqAlarm", emailRoutingWatchdogDlq, "supermarket-email-routing-watchdog-dlq");
    createDlqAlarm("EmailPublishRecoveryDlqAlarm", emailPublishRecoveryDlq, "supermarket-email-publish-recovery-dlq");
    createDlqAlarm("StorefrontOrdersDlqAlarm", storefrontOrdersDlq, "supermarket-storefront-orders-dlq");
    createDlqAlarm("AuditLogWorkerDlqAlarm", auditLogWorkerDlq, "supermarket-audit-log-worker-dlq.fifo")
      .addAlarmAction(new cloudwatchActions.SnsAction(adminAlertsTopic));
    new cloudwatch.Alarm(this, "AuditLogMainQueueAgeAlarm", {
      alarmName: "supermarket-audit-log-main-age",
      metric: auditLogMainQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5) }),
      threshold: Duration.hours(1).toSeconds(),
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Audit worker backlog older than one hour"
    }).addAlarmAction(new cloudwatchActions.SnsAction(adminAlertsTopic));
    createDlqAlarm("PaymentEventsDlqAlarm", paymentEventsDlq, "supermarket-payment-events-dlq");
    createDlqAlarm("ImageUploadsDlqAlarm", imageUploadsDlq, "supermarket-image-uploads-dlq");
    createDlqAlarm("EventBridgeTargetDlqAlarm", eventBridgeTargetDlq, "supermarket-eventbridge-target-dlq");

    const api = createHttpApi(this, {
      config: props,
      handler: httpApiFunction,
      userPool
    });

    new CfnOutput(this, "TableName", {
      value: table.tableName ?? dynamoTableName.valueAsString
    });

    new CfnOutput(this, "FunctionName", {
      value: httpApiFunction.functionName
    });

    new CfnOutput(this, "PublicApiFunctionName", {
      value: httpApiFunction.functionName
    });

    new CfnOutput(this, "OrderApiFunctionName", {
      value: httpApiFunction.functionName
    });

    new CfnOutput(this, "PaymentApiFunctionName", {
      value: httpApiFunction.functionName
    });

    new CfnOutput(this, "OrderWorkerFunctionName", {
      value: orderWorkerFunction.functionName
    });

    new CfnOutput(this, "NotificationWorkerFunctionName", {
      value: notificationWorkerFunction.functionName
    });

    new CfnOutput(this, "PaymentWorkerFunctionName", {
      value: paymentWorkerFunction.functionName
    });

    new CfnOutput(this, "AuditEventWorkerFunctionName", {
      value: auditEventWorkerFunction.functionName
    });

    new CfnOutput(this, "ReleaseExpiredOrdersFunctionName", {
      value: releaseExpiredOrdersFunction.functionName
    });

    new CfnOutput(this, "CommerceEventBusName", {
      value: commerceEventBus.eventBusName
    });

    new CfnOutput(this, "PaymentEventBusName", {
      value: paymentEventBus.eventBusName
    });

    new CfnOutput(this, "PlatformEventBusName", {
      value: platformEventBus.eventBusName
    });

    new CfnOutput(this, "CommerceArchiveArn", {
      value: commerceArchive.attrArn
    });

    new CfnOutput(this, "PaymentArchiveArn", {
      value: paymentArchive.attrArn
    });

    new CfnOutput(this, "PlatformArchiveArn", {
      value: platformArchive.attrArn
    });

    new CfnOutput(this, "ApiGatewayUrl", {
      value: api.url
    });

    new CfnOutput(this, "ApiCustomDomainUrl", {
      value: props.apiCustomDomainName ? `https://${props.apiCustomDomainName}` : ""
    });

    new CfnOutput(this, "ProductImagesBucketName", {
      value: productImagesBucket.bucketName
    });

    new CfnOutput(this, "ProductImagesDistributionDomainName", {
      value: productImagesDistribution.distributionDomainName
    });

    new CfnOutput(this, "ProductImagesCustomDomainNames", {
      value: productImagesDomainNames.join(",")
    });

    new CfnOutput(this, "ProductImagesPublicBaseUrl", {
      value: productImagesPublicBaseUrl
    });

    new CfnOutput(this, "NotificationsQueueUrl", {
      value: notificationsQueue.queueUrl
    });

    new CfnOutput(this, "AuditQueueUrl", {
      value: auditQueue.queueUrl
    });

    new CfnOutput(this, "AuditLogTableName", {
      value: auditLogTable.tableName ?? "supermarket-audit-log"
    });

    new CfnOutput(this, "AuditLogMainQueueUrl", {
      value: auditLogMainQueue.queueUrl
    });

    new CfnOutput(this, "AuditLogWorkerDlqUrl", {
      value: auditLogWorkerDlq.queueUrl
    });

    new CfnOutput(this, "StorefrontOrdersQueueUrl", {
      value: storefrontOrdersQueue.queueUrl
    });

    new CfnOutput(this, "StorefrontOrdersDlqUrl", {
      value: storefrontOrdersDlq.queueUrl
    });

    new CfnOutput(this, "PaymentEventsQueueUrl", {
      value: paymentEventsQueue.queueUrl
    });

    new CfnOutput(this, "PaymentEventsDlqUrl", {
      value: paymentEventsDlq.queueUrl
    });

    new CfnOutput(this, "EmailJobsQueueUrl", {
      value: emailJobsQueue.queueUrl
    });

    new CfnOutput(this, "EmailJobsDlqUrl", {
      value: emailJobsDlq.queueUrl
    });

    new CfnOutput(this, "EmailEventBridgeDeliveryDlqUrl", {
      value: emailEventBridgeDeliveryDlq.queueUrl
    });

    new CfnOutput(this, "EmailRouteTrackerFunctionName", {
      value: emailRouteTrackerFunction.functionName
    });

    new CfnOutput(this, "EmailRouteTrackerDlqUrl", {
      value: emailRouteTrackerDlq.queueUrl
    });

    new CfnOutput(this, "EmailRoutingWatchdogFunctionName", {
      value: emailRoutingWatchdogFunction.functionName
    });

    new CfnOutput(this, "EmailRoutingWatchdogDlqUrl", {
      value: emailRoutingWatchdogDlq.queueUrl
    });

    new CfnOutput(this, "EmailPublishRecoveryFunctionName", {
      value: emailPublishRecoveryFunction.functionName
    });

    new CfnOutput(this, "EmailPublishRecoveryDlqUrl", {
      value: emailPublishRecoveryDlq.queueUrl
    });

    new CfnOutput(this, "EmailEventBridgeFailureTestRuleName", {
      value: emailEventBridgeFailureTestRule.ruleName
    });

    new CfnOutput(this, "EmailEventBridgeSuccessTestQueueUrl", {
      value: emailEventBridgeSuccessTestQueue.queueUrl
    });

    new CfnOutput(this, "AdminAlertsTopicArn", {
      value: adminAlertsTopic.topicArn
    });

    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId
    });

    new CfnOutput(this, "CustomerGroupName", {
      value: customerGroup.groupName ?? "customer"
    });

    new CfnOutput(this, "AdminGroupName", {
      value: "admin"
    });

    new CfnOutput(this, "CognitoHostedUiDomain", {
      value: userPoolDomain.baseUrl()
    });
  }
}
