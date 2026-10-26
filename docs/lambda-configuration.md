# Lambda configuration and capabilities

The application Lambda factory requires an explicit profile from
`infra/stack/application-lambda-profiles.ts`. A profile selects environment
groups and AWS grants together. Runtime, code asset, function names, handlers
and construct IDs remain independent of the profile.

| Runtime | Configuration and access |
| --- | --- |
| HTTP API | Full application integrations, admin queue/replay operations, authentication and payment configuration |
| Order and notification/payment-event workers | DynamoDB, application events, alerts and email effects; no VNPay credentials or admin operations |
| Email delivery worker | DynamoDB and SES; idempotency table is granted separately |
| Email route tracker / SES feedback | DynamoDB; SES feedback also verifies the configured SNS topic |
| Email watchdog / publish recovery | DynamoDB and alerts; recovery can publish to application event buses |
| Checkout workflow | DynamoDB, payment configuration and failure notification effects |
| Payment lookup workflow / revenue builder | Read-only application DynamoDB access |
| Expiry / cleanup / sale campaign jobs | Application DynamoDB access |
| Refund / payment reconciliation | Payment configuration and their respective email/event effects |
| Image metadata workers | Public asset URL; upload queue idempotency has its own table grant |
| Audit event logger | No application environment or AWS integration grants |

The dedicated inventory outbox relay, audit log worker and Cognito functions
keep their existing explicit configuration outside this factory. Invocation,
failure destinations and idempotency grants remain attached where those
resources are wired in the stack.

Runtime consumers import the relevant `apps/api/src/config/*-config.ts` modules
instead of the full `env.ts` facade. Zod retains the existing types, bounds and
defaults. `RuntimeConfigService` reads and validates payment configuration only
when payment functionality is needed. HTTP, checkout workflow and scheduled
payment/refund reconciliation also validate it before serving work. Missing
provider credentials are still errors; unrelated workers do not need them.

The `.env` loader is for local development. A process with
`AWS_LAMBDA_FUNCTION_NAME` uses only its supplied environment. `env.ts` remains
the full application facade for compatibility with external tooling; importing
it intentionally requires payment configuration.

Several workers still bootstrap the shared Nest `AppModule`. This refactor
removes their dependency on unrelated required configuration and grants; it
does not claim separate feature containers or bundles.

## Validation

```sh
npm run verify -w @supermarket/api
npm run package:lambda -w @supermarket/api
npx tsc --noEmit -p infra/tsconfig.json
npm run test:infra:inventory-outbox
npm run test:infra:lambda-config
```

The Lambda config test synthesizes the stack offline and checks all 23
application profiles. It verifies payment-secret scope, admin permissions,
read-only roles and initialization using only each profile's environment in an
isolated process. Empty queue invocations and the HTTP bootstrap are exercised;
AWS client calls are blocked, so this is not an AWS end-to-end test. Payment
validation is separately checked to still reject missing credentials.

The environment budget includes UTF-8 key and value bytes after resolving
supported CloudFormation intrinsics with explicit fixtures, including dummy
SSM secret values. It fails above 4096 bytes or for an unsupported intrinsic.
The reported size is a regression fixture, not the deployed size: custom
parameter values, actual SSM values and generated resource names can differ.
SSM dynamic references resolve into Lambda environment values and still count
toward the limit. Adding a new integration requires reviewing the HTTP budget
as well as the worker profile.

No resource deployment is performed by these checks. Existing tables, queue
redrive behavior, idempotency and transaction conditions are not changed.
