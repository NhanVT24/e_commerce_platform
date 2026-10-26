import crypto from "node:crypto";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { getRequestPrincipal } from "../../common/auth/request-principal.js";
import { AppExceptionFilter } from "../../common/filters/app-exception.filter.js";
import { createNestLogger } from "../../common/logging/nest-logger.js";
import { httpConfig } from "../../config/http-config.js";
import { AppModule } from "./app.module.js";
import { readPaymentConfig } from "../../config/payment-config.js";
import { isCustomerOrderMutation } from "./storefront-request-policy.js";

export async function createNestApp(): Promise<NestFastifyApplication> {
  // HTTP exposes payment endpoints; fail before accepting traffic if credentials are missing.
  readPaymentConfig();
  const adapter = new FastifyAdapter({ logger: {
    // Signed callback URLs are read capabilities; never put them in access logs.
    serializers: {
      req: (request) => ({ method: request.method, route: request.routeOptions?.url ?? "<unmatched>", id: request.id })
    }
  } });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    logger: createNestLogger()
  });
  app.useLogger(createNestLogger());
  app.flushLogs();

  const storefrontOrigin = httpConfig.STOREFRONT_PUBLIC_URL ? new URL(httpConfig.STOREFRONT_PUBLIC_URL).origin : undefined;
  const allowedProductionOrigins = new Set<string>();
  if (storefrontOrigin) {
    const storefrontUrl = new URL(storefrontOrigin);
    allowedProductionOrigins.add(storefrontOrigin);
    const alternateHost = storefrontUrl.hostname.startsWith("www.")
      ? storefrontUrl.hostname.slice(4)
      : `www.${storefrontUrl.hostname}`;
    allowedProductionOrigins.add(`${storefrontUrl.protocol}//${alternateHost}`);
  }

  app.enableCors({
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-Id", "X-Request-Id"],
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      const allowedDevOrigin =
        /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ||
        /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin);

      callback(null, allowedDevOrigin || allowedProductionOrigins.has(origin));
    }
  });

  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: false
  }));
  app.useGlobalFilters(new AppExceptionFilter());
  app.setGlobalPrefix("");

  const fastify = app.getHttpAdapter().getInstance();

  fastify.decorateRequest("correlationId", "");

  fastify.addHook("onRequest", async (request, reply) => {
    const correlationIdHeader = request.headers["x-correlation-id"] ?? request.headers["x-request-id"];
    const suppliedId = String(Array.isArray(correlationIdHeader) ? correlationIdHeader[0] : correlationIdHeader ?? "");
    const correlationId = /^[a-zA-Z0-9._:-]{1,128}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
    (request as { correlationId?: string }).correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);

    request.log.info({
      correlationId,
      lambdaName: (request.raw as { requestContext?: { lambdaName?: string } })?.requestContext?.lambdaName ?? "http-api",
      method: request.method,
      route: request.routeOptions.url ?? "<unmatched>",
    }, "incoming api request");
  });

  fastify.addHook("preHandler", async (request, reply) => {
    const method = request.method.toUpperCase();
    const isReadOnlyMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const url = String(request.url || "");
    const isPublicStorefrontRead = isReadOnlyMethod && url.startsWith("/api/storefront/");
    const isPublicProductsRead = isReadOnlyMethod && url.startsWith("/api/products");
    const isSalesRequest = url.startsWith("/api/sales");
    // Customer email/consent is personal data. Unlike most reads, this route
    // must reach the admin guard below.
    const isAdminCustomerRequest = url.startsWith("/api/admin/customers");
    const isAdminAuthorizationRequest = url.startsWith("/api/admin/authorizations");
    // Delivery history and producer failure details contain recipient and
    // infrastructure metadata, so admin GETs must not use the public-read path.
    const isAdminEmailDeliveryRequest = url.startsWith("/api/admin/email-deliveries");
    const isAdminPaymentReviewRequest = url.startsWith("/api/admin/ops/payment-reviews");
    const isNotificationsMeRead = isReadOnlyMethod && url.startsWith("/api/notifications/me");
    const isNotificationReadMutation = method === "PATCH" && /^\/api\/notifications\/[^/]+\/read(?:\?|$)/.test(url);
    const isNotificationDeleteMutation = method === "DELETE" && /^\/api\/notifications\/[^/]+(?:\?|$)/.test(url);
    const isNotificationDeleteAllMutation = method === "DELETE" && /^\/api\/notifications(?:\?|$)/.test(url);
    const isStorefrontOrderMutation = isCustomerOrderMutation(method, url);
    const isStorefrontCheckoutPrepareMutation = method === "POST" && url === "/api/storefront/checkout/prepare";
    const isStorefrontCheckoutPaymentSessionMutation = method === "POST" && url === "/api/storefront/checkout/payment-session";
    const isStorefrontCheckoutCancelMutation = method === "POST" && url === "/api/storefront/checkout/cancel";
    const isAvatarUploadPresignMutation = method === "POST" && url === "/api/uploads/avatar/presign";
    const isProfileMutation = method === "PATCH" && url === "/api/profile/me";
    const isVnpayFailureTestMutation = method === "POST" && url === "/api/payments/vnpay/test/fail";
    const isShoppingProductMutation = !isReadOnlyMethod && url.startsWith("/api/shopping-items");
    const isPublicVnpayRequest =
      url === "/api/payments/vnpay" ||
      url.startsWith("/api/payments/vnpay/") ||
      url.startsWith("/api/payments/vnpay?");

    if ((!isSalesRequest && !isAdminCustomerRequest && !isAdminAuthorizationRequest && !isAdminEmailDeliveryRequest && !isAdminPaymentReviewRequest && isReadOnlyMethod) || isPublicStorefrontRead || isPublicProductsRead || isPublicVnpayRequest || isNotificationsMeRead) {
      return;
    }

    if (isStorefrontOrderMutation) {
      const principal = await getRequestPrincipal(request);
      if (principal && (principal.role === "customer" || principal.role === "admin")) {
        return;
      }

      reply.status(403).send({
        statusCode: 403,
        message: "Chỉ tài khoản customer hoặc admin mới được đặt hàng."
      });
      return;
    }

    if (isStorefrontCheckoutPrepareMutation) {
      const principal = await getRequestPrincipal(request);
      if (principal && (principal.role === "customer" || principal.role === "admin")) {
        return;
      }

      reply.status(403).send({
        statusCode: 403,
        message: "Chỉ tài khoản customer hoặc admin mới được bắt đầu checkout."
      });
      return;
    }

    if (isStorefrontCheckoutPaymentSessionMutation) {
      const principal = await getRequestPrincipal(request);
      if (principal && (principal.role === "customer" || principal.role === "admin")) {
        return;
      }

      reply.status(403).send({
        statusCode: 403,
        message: "only customer or admin can create checkout payment session."
      });
      return;
    }

    if (isStorefrontCheckoutCancelMutation) {
      const principal = await getRequestPrincipal(request);
      if (principal && (principal.role === "customer" || principal.role === "admin")) {
        return;
      }

      reply.status(403).send({
        statusCode: 403,
        message: "Chỉ tài khoản customer hoặc admin mới được hủy lượt checkout."
      });
      return;
    }

    if (isAvatarUploadPresignMutation || isProfileMutation) {
      const principal = await getRequestPrincipal(request);
      if (principal) {
        return;
      }

      reply.status(403).send({
        statusCode: 403,
        message: "You need to sign in before uploading an avatar."
      });
      return;
    }

    if (isVnpayFailureTestMutation) {
      const principal = await getRequestPrincipal(request);
      if (principal && (principal.role === "customer" || principal.role === "admin")) {
        return;
      }

      reply.status(403).send({
        statusCode: 403,
        message: "Chỉ tài khoản customer hoặc admin mới được chạy test thanh toán thất bại."
      });
      return;
    }

    if (isNotificationReadMutation || isNotificationDeleteMutation || isNotificationDeleteAllMutation) {
      const principal = await getRequestPrincipal(request);
      if (principal) {
        return;
      }

      reply.status(403).send({
        statusCode: 403,
        message: "Bạn cần đăng nhập để cập nhật trạng thái thông báo."
      });
      return;
    }

    // Product ownership and the exact delegated permission are enforced in
    // ShoppingController/ShoppingService. This global gate only requires a
    // verified principal so non-admin creators can reach that policy layer.
    if (isShoppingProductMutation) {
      const principal = await getRequestPrincipal(request);
      if (principal) return;
      reply.status(403).send({ statusCode: 403, message: "A signed-in account is required." });
      return;
    }

    if ((await getRequestPrincipal(request))?.role === "admin") {
      return;
    }

    reply.status(403).send({
      statusCode: 403,
      message: "Chỉ tài khoản admin mới được tạo, sửa hoặc xóa dữ liệu."
    });
  });

  fastify.addHook("onResponse", async (request, reply) => {
    request.log.info({
      correlationId: (request as { correlationId?: string }).correlationId ?? "",
      lambdaName: (request.raw as { requestContext?: { lambdaName?: string } })?.requestContext?.lambdaName ?? "http-api",
      method: request.method,
      route: request.routeOptions.url ?? "<unmatched>",
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 100) / 100
    }, "api response sent");
  });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  app.enableShutdownHooks();

  return app;
}

export async function startNestApp() {
  const app = await createNestApp();
  await app.listen({ port: httpConfig.PORT, host: "0.0.0.0" });
  return app;
}
