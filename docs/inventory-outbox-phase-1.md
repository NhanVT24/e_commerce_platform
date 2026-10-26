# Hardening Phase 1: transactional outbox cho inventory alert

Ngày 2026-10-26. Đã triển khai và kiểm chứng local; chưa deploy hoặc xác nhận behavior trên AWS.
Đây là Phase 1 của backend hardening, khác với các phase Clean Architecture trước đây.

## Vấn đề và thay đổi

Trước đây `UpdateProduct`/`IncrementProductField` ghi database rồi gọi publisher.
Nếu process chết giữa hai bước, Product đã đổi nhưng alert có thể mất. Retry cùng
expectedVersion có thể nhận CONFLICT vì lần ghi trước thực sự đã thành công.

Khi bật `INVENTORY_ALERT_OUTBOX_ENABLED=true`, Product, category index và event
outbox được ghi trong cùng DynamoDB transaction. Response không chờ gửi alert.
Relay đọc event bền vững và publish lại khi cần; consumer dedup bằng business ID.
Outbox giải quyết khoảng trống commit/publish, chưa cung cấp idempotent HTTP request.

Phạm vi là hai flow admin update/increment Product. Không migrate toàn bộ event
payment/order/email trong phase này. Domain Product tiếp tục giữ stock policy và
trả alert transition; entity không biết DynamoDB, EventBridge hay outbox record.

## Flow và vị trí code

```text
PATCH Product / increment counter
  -> controller -> ShoppingService -> application use case
  -> Product entity tính next state và stockAlertSince(current)
  -> ProductWriteRepository / ProductCounterRepository (port)
  -> Dynamo adapter: transaction [Product + category index + OUTBOX nếu có transition]
  <- response Product như cũ; không chờ notification

EventBridge schedule mỗi phút
  -> inventory-alert-relay Lambda
  -> RelayInventoryAlerts -> InventoryAlertOutbox port
  -> Dynamo adapter: query due -> conditional claim với owner/lease
  -> EventBridge PutEvents -> conditional mark PUBLISHED
  -> rule/queue inventory hiện có -> NotificationUseCases
  -> transaction [notification + durable receipt]
  -> thử từng external effect -> ghi completion/UNKNOWN vào receipt
```

| Thành phần | File trong `apps/api/src` | Trách nhiệm |
| --- | --- | --- |
| Producers | `modules/shopping/application/update-product/update-product.ts`, `increment-product-field/increment-product-field.ts` | Tính nghiệp vụ trước commit, chuyển event draft vào repository |
| Write ports | `modules/shopping/application/ports/product-write-repository.ts`, `product-counter-repository.ts` | Yêu cầu atomic write, giữ ownership/version/index guarantees |
| Outbox port | `modules/shopping/application/ports/inventory-alert-outbox.ts` | Contract query, claim, retry, completion và publisher |
| Relay use case | `modules/shopping/application/relay-inventory-alerts.ts` | Điều phối claim/publish/retry, không import AWS SDK |
| Dynamo store | `modules/shopping/infrastructure/persistence/inventory-alert-outbox.ts` | Dựng transaction item, due query, conditional lease và marker |
| Composition | `modules/shopping/inventory-alert-relay.composition.ts` | Nối Dynamo/EventBridge implementations vào use case |
| Entrypoint | `entrypoints/lambda/jobs/inventory-alert-relay.ts` | Gọi relay, ghi log và metric |
| Consumer port | `modules/notifications/application/ports/inventory-notifications.ts` | Contract tạo một lần và ghi kết quả effects |
| Consumer implementation | `modules/notifications/infrastructure/inventory-notifications.ts` | Atomic notification/receipt và conditional completion |
| Consumer nghiệp vụ | `modules/notifications/application/notifications.ts` | Nhận event có ID, gọi port và xử lý per-effect outcome |
| Recovery CLI | `scripts/requeue-inventory-alert.ts` | Đọc metadata; chỉ requeue FAILED khi có `--apply` |

Application import type từ port/domain và import runtime entity khi gọi behavior.
Infrastructure import contract phía application. Composition root import cả use case
lẫn implementation rồi truyền object bằng constructor. Interface không chạy hay
chuyển tiếp request ở runtime; lời gọi thực tế đi vào implementation được truyền vào.

## Identity và lưu trữ

- Business ID: `inventory.stock.alert:<productId>:<committedVersion>`. Relay giữ nguyên
  ID, payload và `createdAt` khi retry; EventBridge/SQS transport ID có thể thay đổi.
- Outbox key: `PK=INVENTORY_ALERT_OUTBOX#<eventId>`, `SK=DETAIL`.
- State: `PENDING -> PROCESSING -> PUBLISHED`; lỗi có thể về PENDING hoặc FAILED.
- Dùng lại GSI **EntityUpdatedAtIndex**, không thêm index mới. Record đang chờ dùng
  `entityType=INVENTORY_ALERT_OUTBOX_PENDING`, `updatedAt=nextAttemptAt` để query due.
  Khi đang PROCESSING, due time là lease expiry. `lastChangedAt` giữ thời điểm ghi
  thực tế vì `updatedAt` của loại record này mang nghĩa thời điểm có thể xử lý tiếp.
- Query tối đa 100 candidates/tick, 25/page, tối đa 10 pages. Không Scan toàn bảng.
  GSI eventually consistent có thể khiến event xuất hiện ở tick sau; claim luôn
  conditional trên base table để bảo vệ correctness.
- Claim dùng expected attempt, lease owner UUID và expiry. Worker cũ không được
  complete/retry sau khi hết lease hoặc khi owner khác đã claim.
- Lease 120 giây; relay budget 20 giây, Lambda timeout 30 giây. Publish timeout 5 giây.
  Tối đa 8 publish attempts, exponential backoff từ 10 giây, cap 900 giây; lịch mỗi
  phút khiến thời điểm retry thực tế được làm tròn tới một tick sau đó.
- Chỉ PUBLISHED có `auditExpiresAt` sau 30 ngày, dùng TTL attribute sẵn có. TTL không
  phải timer retry và không xóa pending/failed events.
- Consumer receipt theo SHA256 của `[eventId, normalizedRecipient]`; transaction tạo
  receipt cùng notification có ID ổn định. Receipt không TTL, nên redelivery sau
  khi người dùng xóa notification cũng không tạo lại. Đổi recipient là identity mới.
  Retention receipt cần được quản lý về lâu dài để kiểm soát dung lượng/cost.

## Failure semantics

| Tình huống | Kết quả |
| --- | --- |
| Version/ownership conflict | Cả Product/index/outbox không commit; không có ghost event |
| Process chết sau commit, trước publish | Event còn trong database để relay xử lý |
| Hai relay cùng thấy event | Chỉ một claim hợp lệ; stale worker không sửa completion |
| Publish thành công, mất marker/response | Có thể publish lại cùng business ID; consumer dedup |
| Publish lỗi nhiều lần | Backoff; hết budget chuyển FAILED để điều tra/requeue |
| Worker chết sau claim | Sau lease expiry, worker khác có thể claim lại |
| Payload outbox sai nhưng có header hợp lệ | Claim quarantine FAILED và Lambda báo lỗi |
| Header record hỏng do sửa thủ công | Tick báo lỗi; cần sửa/quarantine record trước khi relay tiến tiếp |
| Consumer redelivery hoặc concurrent delivery | Một database notification/receipt cho mỗi identity |
| Consumer chết sau createOnce | Notification đã tồn tại; receipt IN_PROGRESS, không takeover external effects |
| SNS/audit/pending-event lỗi hoặc response không rõ | Ghi UNKNOWN; không tự gửi lại effect |
| Ghi completion receipt lỗi | Queue retry thấy receipt và không lặp effects; receipt có thể vẫn IN_PROGRESS |

Database notification dedup **không** phải exactly-once SNS/email/audit. External
effect có thể thiếu khi process chết trước call, hoặc đã chạy nhưng response mất.
SUCCEEDED chỉ nghĩa downstream API đã xác nhận tiếp nhận, không chứng minh email/SNS
đã đến người nhận. UNKNOWN/IN_PROGRESS cần review/reconciliation; phase này chưa có
worker tự phục hồi từng effect hoặc UI review. Retry ở tầng SDK/provider vẫn có thể
gây duplicate; không tuyên bố external effects exactly-once.

Không bảo đảm thứ tự alert của cùng Product khi có retry; event chứa productVersion
để đọc lịch sử. Consumer tương thích event cũ thiếu eventId theo đường legacy;
dedup bền vững mới chỉ áp dụng cho event có business ID.

## Rollout và rollback

1. Build/package và deploy consumer, relay, schedule, IAM, alarms với CDK parameter
   `InventoryAlertOutboxEnabled=false` mặc định. Writer lúc này vẫn dùng direct path.
2. Kiểm tra rule `supermarket.inventory`/`inventory.stock.alert`, queue/DLQ và quyền
   worker notification hiện có. Kiểm tra admin recipient và cấu hình SNS/platform.
3. Trên staging bật parameter thành `true`, chạy update/increment qua stock transition.
   Theo dõi Product version, outbox, receipt, notification và log bằng cùng eventId.
4. Diễn tập mất marker, relay outage, publish failure và consumer redelivery trước
   khi bật production. Kiểm chứng này chưa được chạy trên AWS trong lần triển khai code.

Mỗi writer chỉ dùng direct **hoặc** outbox; không gửi cả hai cho cùng mutation.
Rollback writer bằng parameter=false, nhưng giữ relay/consumer chạy để drain backlog
cũ. Không xóa pending records, receipt hay tắt relay khi vẫn còn event cần xử lý.
Trong direct mode, khoảng trống commit/publish cũ vẫn tồn tại.

Relay có alarm Lambda Errors và metric `Supermarket/InventoryOutbox/Failed`, đều
gửi đến adminAlertsTopic hiện có. Tick log có evaluated/claimed/published/retry/
failed/lostLease. `Failed` đếm event chuyển FAILED trong tick; không phải tổng backlog.
Chưa có backlog-age alarm, dashboard hay tự động recovery UNKNOWN; phần đó thuộc
observability/recovery tiếp theo. Lambda mỗi phút tạo một khoản chi phí nền ngay
cả khi flag=false; due query rỗng vẫn tiêu thụ read capacity tối thiểu.

## Recovery có kiểm soát

Đọc outbox qua key hoặc query EntityUpdatedAtIndex theo entityType terminal
`INVENTORY_ALERT_OUTBOX_FAILED`. Đọc receipt theo eventId/recipient hash hoặc query
entityType `INVENTORY_ALERT_RECEIPT`, lọc effectsState với pagination đầy đủ. Không
Scan production để điều tra một event đã biết ID.

CLI dưới đây không được thực thi với AWS trong lần phát triển này. Cấu hình đúng
environment/credentials/table trước khi chạy; mặc định chỉ đọc metadata:

```sh
npm exec -w @supermarket/api -- tsx src/scripts/requeue-inventory-alert.ts --table TABLE_NAME --event-id "inventory.stock.alert:PRODUCT_ID:VERSION"
```

Sau khi xác minh nguyên nhân publish lỗi và kiểm tra receipt/external effects,
thêm `--apply` để chuyển **FAILED** về PENDING. CLI giữ event ID/payload, reset
attempt budget; từ chối PENDING/PROCESSING/PUBLISHED. Không reset receipt hay tự
gửi lại SNS/audit. Payload hỏng cần sửa có review trước requeue; CLI không sửa payload.
Receipt UNKNOWN/IN_PROGRESS phải đối chiếu log/downstream bằng eventId trước bất kỳ
quyết định gửi bù nào. Không xóa receipt để ép retry.

## Kiểm chứng và giới hạn bằng chứng

Kết quả local ngày 2026-10-26:

| Kiểm tra | Kết quả |
| --- | --- |
| Backend verify | 261 tests pass; source/test typecheck pass |
| Architecture | 109 core files, 14 modules, 47 entrypoints, 0 violations |
| DynamoDB Local integration | 12 tests pass, không skip; bảng test và container đã dọn |
| Test thêm trong phase này | 7 application/fault tests và 6 engine/HTTP tests |
| Lambda package | Build pass; ZIP có đúng một relay entrypoint |
| Infra typecheck và synth | Pass; giữ 350 resource IDs cũ, table/index definitions không đổi so với baseline `ea11827` |

- `npm run verify -w @supermarket/api`: architecture boundary, source/test types,
  regression, rich entities và application/fault tests; gồm 7 test outbox mới.
- `PHASE7_DYNAMODB_ENDPOINT` trỏ loopback vào DynamoDB Local, sau đó chạy
  `npm run test:integration -w @supermarket/api`. Suite tự tạo/xóa bảng test ngẫu nhiên,
  từ chối AWS endpoint; kiểm chứng real transaction/lease/dedup và HTTP composition.
- `npm run package:lambda -w @supermarket/api` và
  `npx tsc --noEmit -p infra/tsconfig.json`.
- `npm run test:infra:inventory-outbox -- BASELINE_REF`: synth offline, kiểm tra
  handler/flag/schedule/alarm/IAM, giữ resource IDs và table/index definition cũ.
  Bỏ BASELINE_REF thì chỉ chạy assertions cấu hình hiện tại. CI chạy kiểm tra này.

Transport EventBridge/SNS trong tests là doubles; DynamoDB Local không chứng minh
IAM, GSI propagation latency/capacity, queue redrive hoặc CloudWatch delivery trên AWS.
Không deploy hoặc gửi SNS/email thật trong lần kiểm chứng local này.
