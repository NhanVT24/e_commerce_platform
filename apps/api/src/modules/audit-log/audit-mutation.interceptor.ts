import crypto from "node:crypto";
import { Injectable, type NestInterceptor, type ExecutionContext, type CallHandler } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { Observable } from "rxjs";
import { PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { getRequestPrincipal } from "../../common/auth/request-principal.js";
import { rawDb } from "../../database/dynamodb/client.js";
import { databaseConfig } from "../../config/database-config.js";
import { auditContext, principalAuditContext, serviceAuditContext } from "./audit-context.js";

@Injectable()
export class AuditMutationInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next.handle();
    const principal = await getRequestPrincipal(request);
    // Generate the ID server-side; correlation headers are supplied by clients.
    const requestId = crypto.randomUUID();
    const route = request.routeOptions.url ?? request.url.split("?")[0]!;
    const needsOperation = route.startsWith("/api/admin/ops") || route.startsWith("/api/uploads") || route.startsWith("/api/admin/email-deliveries");
    const metadata = principal
      ? principalAuditContext(principal, requestId, `${request.method} ${route}`)
      : serviceAuditContext({
        actorId: "service:http-api",
        source: `${request.method} ${route}`,
        reason: "unauthenticated_mutation",
        requestId
      });
    return new Observable((subscriber) => {
      let subscription: { unsubscribe(): void } | undefined;
      void auditContext.run(metadata, async () => {
        // An operation ledger covers external side effects (S3 grants, queue
        // replay, Scheduler/email calls). It stores no request/response payload.
        const operation = { PK: `OPERATION#${requestId}`, SK: "DETAIL" };
        try {
          if (needsOperation) await rawDb.send(new PutItemCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME,
            Item: marshall({ ...operation, entityType: "OPERATION", status: "started", auditExpiresAt: Math.floor(Date.now() / 1000) + 90 * 86400, method: request.method, route,
              targetId: ["id", "emailId", "emailJobId", "archive"].map((field) => (request.params as Record<string, unknown>)?.[field]).find((value) => typeof value === "string") ?? "",
              ...metadata }), ConditionExpression: "attribute_not_exists(PK)" }));
          if (subscriber.closed) return;
          subscription = next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error: unknown) => {
              void finish("failed").then(() => subscriber.error(error), (auditError: unknown) => {
                console.error("[audit-operation] completion_failed", { requestId });
                subscriber.error(auditError);
              });
            },
            complete: () => { void finish("completed").then(() => subscriber.complete(), (error: unknown) => subscriber.error(error)); }
          });
        } catch (error) { subscriber.error(error); }
        async function finish(status: "completed" | "failed") {
          if (!needsOperation) return;
          await rawDb.send(new UpdateItemCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME, Key: marshall(operation),
            UpdateExpression: "SET #status = :status", ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":status": { S: status } } }));
        }
      });
      return () => subscription?.unsubscribe();
    });
  }
}
