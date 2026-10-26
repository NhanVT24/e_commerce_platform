# Backend workflow regression tests

Mục tiêu: phát hiện regression của các business workflow backend sau refactor.
Phạm vi này không bao gồm browser/frontend E2E hoặc xác nhận deployment AWS.

## Chạy kiểm tra

Từ thư mục gốc repository:

```powershell
# Các unit/application workflow tests bổ sung
npm run test:workflows -w @supermarket/api

# Toàn bộ architecture checks, source/test typecheck và local regression tests
npm run verify -w @supermarket/api
```

`test:workflows` đã được nối vào `verify`, nên GitHub Actions
`.github/workflows/backend-verify.yml` cũng chạy các tests mới qua lệnh hiện có.

Không chạy các script build/test đồng thời trong cùng checkout: chúng cùng
clean/build `apps/api/dist/src`.

## Workflow và bằng chứng kiểm tra

Các đường dẫn test dưới đây nằm trong `apps/api/tests/`.

| Workflow | Test files | Hành vi quan trọng |
| --- | --- | --- |
| Signup, confirmation, reset, token claims, profile | `business-workflows.test.ts`, `remaining-architecture.test.ts`, `http-boundaries.test.ts` | Duplicate identity; group → profile → welcome; không welcome sau lỗi; chặn account disabled/blocked/suspended; partial profile update; avatar ownership |
| Customer directory | `remaining-architecture.test.ts` | Verified/enabled customers, normalized email deduplication |
| Product CRUD/counters/owned products | `shopping-update-product.test.ts`, `shopping-product-mutations.test.ts`, `workflow-orchestration.test.ts` | Owner/admin, version, valid stock, immutable entity, alert transitions, không publish sau write failure, lọc owned products |
| Catalog/order reads | `storefront-reads.test.ts` | Public projection, pagination, pricing, không lộ order của người khác |
| Workflow checkout/payment URL | `workflow-orchestration.test.ts`, `storefront-payment.test.ts`, `payment-recovery.test.ts` | Stable request ID; hold → payment → attach; business failure khác storage failure; giấu payment của người khác; replay cùng order/session |
| Payment IPN/reconciliation/expiry | `storefront-payment.test.ts`, `payment-recovery.test.ts` | Signed payload, durable payment correlation, duplicate events, recovery checkpoints, unknown outcomes, không oversell/double release |
| Cancel/refund/reconcile | `storefront-order-lifecycle.test.ts`, `payment-recovery.test.ts` | Ownership, refund window, durable claim, stable identity, timeout giữ pending, conditional winner, không tự resend tiền |
| Notification/payment worker | `notification-workflows.test.ts`, `storefront-reads.test.ts` | Persist trước event; audience boundary; mark sent trước legacy completion; durable payment trước paid order/email; lỗi transaction phải throw; paid-after-release vào manual review |
| Sale campaign/Scheduler | `business-workflows.test.ts`, `remaining-architecture.test.ts` | Tạo hai schedules, missing product, conditional product removal, duplicate transition, compensation khi schedule lỗi |
| Email routing/publish recovery/watchdog | `email-workflows.test.ts`, `remaining-architecture.test.ts` | Acknowledgement, SLA cutoff, conditional claim/suspicion, lease, retry budget, missing payload, terminal failure, SNS outage |
| Welcome/order confirmation/bulk email delivery | `email-workflows.test.ts`, `remaining-architecture.test.ts` | Chọn đúng sender, processing trước send, provider failure/unknown, durable sender identity, không retry mù trong invocation, DLQ test hook phải opt in |
| Inventory report | `business-workflows.test.ts`, `remaining-architecture.test.ts` | Lịch Việt Nam, empty selection, report claim trước SES, acceptance trước alert flags, post-send flag failure không resend |
| Weekly revenue | `workflow-orchestration.test.ts`, `remaining-architecture.test.ts` | Date window, eligible orders, aggregation, generation → delivery, provider timeout không tự resend |
| Upload/private reports | `business-workflows.test.ts`, `remaining-architecture.test.ts`, `http-boundaries.test.ts` | Actor-owned prefixes, private key validation, không lộ public URL trong report grants/list |
| Cleanup | `workflow-orchestration.test.ts`, `remaining-architecture.test.ts` | Retention, distributed claim contract, backlog, delete failure không ghi completed |
| Audit queries/actor | `workflow-orchestration.test.ts`, `audit-log.test.ts`, `audit-actor-context.test.ts`, `http-boundaries.test.ts` | Deduplicated identity lookup, parent order enrichment, giữ cursor, không mutate source, lookup failure, trusted actor |
| Admin DLQ/archive replay | `business-workflows.test.ts`, `remaining-architecture.test.ts` | Dry run không publish/ack, missing destination, chỉ ack sau publish, release message chưa chọn/lỗi, ack failure phải lộ ra, archive time validation |

## Đọc kết quả đúng mức

- Domain/unit tests dùng class thật với dữ liệu xác định. Application tests thay
  database, mail, event bus và Scheduler bằng typed port doubles, không gửi email
  hay thực hiện payment/refund thật.
- `helpers/checkout-fixture.ts` là port double đơn giản, không mô phỏng transaction
  engine. Những assertion về thứ tự/expectedVersion chứng minh application contract,
  không tự chứng minh race safety trên DynamoDB.
- Các tests có compiled HTTP/Lambda handlers và fake SDK transport kiểm tra local
  wiring/contract; đây vẫn không phải AWS runtime E2E.
- `dynamodb.integration.test.mjs` kiểm tra transaction/conditional writes bằng
  DynamoDB Local thật. Suite này chỉ nhận loopback HTTP endpoint có port và tạo/xóa
  bảng tên ngẫu nhiên; không chạy với bảng production.
- Để chạy integration suite riêng, khởi động một DynamoDB Local instance cô lập,
  đặt `PHASE7_DYNAMODB_ENDPOINT` bằng endpoint loopback của nó rồi chạy
  `npm run test:integration -w @supermarket/api`.
- Suite bảo vệ các scenario đã liệt kê, không có nghĩa mọi branch đều được cover
  hoặc mọi workflow production đã được chứng minh. IAM, Cognito thật, EventBridge
  rules/Pipes, SQS redelivery, Step Functions, SES delivery, S3 và VNPay vẫn cần
  staging smoke/E2E riêng.

## Thêm test khi sửa workflow

1. Chọn business rule hoặc failure case có thể bị regression.
2. Dùng entity/use case thật; thay external I/O bằng port double.
3. Arrange dữ liệu riêng cho mỗi test, gọi public method, assert output/error và
   side effect có ý nghĩa. Kiểm tra cả những việc không được xảy ra khi thất bại.
4. Dùng clock/identity cố định; tránh network thật, sleep và shared mutable state.
5. Nếu thêm file, nối vào script test phù hợp để `verify` và CI thực sự chạy file.

## Kết quả local ngày 2026-10-22

- Bổ sung 82 tests trong 4 file workflow, dùng chung một checkout port fixture.
- `npm run verify -w @supermarket/api`: 249 tests pass, không fail/skip;
  source/test typecheck pass; architecture check 106 core files, 14 modules,
  46 entrypoints, 0 violations.
- `npm run test:integration -w @supermarket/api`: 5 DynamoDB Local engine tests
  pass, không fail/skip. Tổng cộng 254 tests local pass.
- DynamoDB Local chạy trong container tạm với `-inMemory -sharedDb`, port
  loopback; suite xóa bảng ngẫu nhiên sau test và container đã được dừng/xóa.
- Chưa chạy GitHub Actions từ xa hoặc AWS/VNPay staging E2E trong đợt này.
