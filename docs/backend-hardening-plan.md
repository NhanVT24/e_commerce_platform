# Plan nâng cấp backend để học và kiểm chứng production behavior

Ngày: 2026-10-26. Phase 1 đã triển khai ở local; các phase còn lại là kế hoạch.
Xem [báo cáo Phase 1, flow, kiểm chứng và runbook](inventory-outbox-phase-1.md).
Feature flag mặc định tắt; chưa deploy hoặc kiểm chứng staging/AWS.

## Mục tiêu và thứ tự

Hoàn thiện từng flow có thể đo và tái hiện lỗi: độ tin cậy -> concurrency/recovery
-> access patterns -> vận hành. TypeScript được siết theo từng slice; PostgreSQL
là bài lab riêng sau khi flow chính ổn định.

| Phase | Kết quả cần có | Vì sao cần |
| --- | --- | --- |
| 0 | Baseline contracts, failure matrix và số đo | Có căn cứ so sánh, tránh sửa kiến trúc nhưng không chứng minh behavior |
| 1 | Product write + inventory-alert outbox + consumer dedup | Khắc phục khoảng trống database commit thành công nhưng publish thất bại |
| 2 | Concurrency, lease ownership và recovery được kiểm chứng | Đảm bảo retry/replay không bán vượt tồn hoặc nhân đôi tác động tài chính |
| 3 | Owner queries và revenue read model có access patterns rõ | Tránh kết quả thiếu do page cap, giảm scan/latency/cost có số đo |
| 4 | Trace/metrics, alarms và staging drills | Có thể tìm và phục hồi một flow lỗi bằng ID |
| 5 | TypeScript strict theo module | Compiler bắt các lỗi nullable/union/contract sớm; làm song song từng slice |
| 6 | PostgreSQL adapter lab | Hiểu transaction/isolation/indexes và kiểm chứng port boundary |

## Phase 0: baseline

Phạm vi: Product update/increment và checkout/payment/refund dùng làm flow học.

- Chạy verification và DynamoDB Local engine tests; ghi rõ môi trường local,
  mocked transport, database engine và AWS staging.
- Lập bảng: input, principal/actor, state trước/sau, durable write, external call,
  lỗi nào retry được, lỗi nào UNKNOWN và điều kiện hoàn thành.
- Ghi lại contract API, event payload và invariants: ownership/version conditions,
  stock không âm, idempotency identity và unknown financial outcome.
- Thiết lập dataset, concurrency level và metrics đo trước/sau: p50/p95 latency,
  conflict rate, database calls/consumed capacity, backlog và error rate.
- Chốt semantics response: khi transaction đã commit và event đã được lưu bền,
  response Product không chờ alert được gửi xong.

Hoàn thành khi có baseline tái hiện được và failure matrix cho slice đầu tiên.
Không đặt mục tiêu latency tuyệt đối trước khi có số đo.

## Phase 1: durable inventory alert cho Product

### Hiện trạng trước khi triển khai Phase 1

`shopping/application/update-product/update-product.ts` và
`increment-product-field/increment-product-field.ts` gọi repository ghi trước,
rồi chờ `InventoryAlertPublisher.publish`. Nếu process chết sau commit hoặc
publisher lỗi, Product đã thay đổi nhưng event chưa chắc được gửi.

Retry cùng expectedVersion có thể nhận CONFLICT sau một lần commit đã thành
công. Outbox xử lý độ bền event, không tự giải quyết toàn bộ ambiguous HTTP
response/idempotent request semantics.

### Thiết kế đề xuất

1. Entity tính trạng thái mới và alert transition trước write; không tự publish.
2. Application truyền business event draft vào Product write/counter port.
   Contract yêu cầu Product, dependent indexes và event commit cùng transaction.
   Không tạo một lệnh saveOutbox độc lập sau khi saveProduct đã commit.
3. Dynamo adapter dựng OUTBOX item và ghi trong cùng transaction hiện tại,
   giữ version/ownership conditions, category indexes và audit behavior.
4. Dùng business event identity ổn định, ví dụ
   `inventory.stock.alert:<productId>:<committedVersion>`; không dùng EventBridge
   event ID hoặc SQS message ID làm identity dedup của nghiệp vụ.
5. Relay xử lý pending events qua due index, claim có owner token/lease, publish,
   rồi mark published có conditional ownership. Backoff và retry budget được chốt.
6. Dùng EventBridge routing/notification queue hiện có. Streams có thể bổ sung
   để giảm latency; outbox record + due-query recovery vẫn cho phép tìm event
   chưa hoàn thành sau một outage kéo dài.
7. Consumer dùng event identity ổn định để tạo system notification một lần ở
   database, qua conditional write/transaction. Không chỉ check receipt rồi tạo
   notification bằng hai thao tác riêng có race.
8. Audit/SNS effects có completion semantics riêng. Database notification dedup
   không đồng nghĩa SNS/email exactly-once; không blind retry khi provider outcome
   ambiguous nếu chưa có idempotency/reconciliation policy tương ứng.

### Phạm vi code dự kiến

- `shopping/domain/product.ts`: tiếp tục trả business alert transition.
- Product write/counter ports và hai use cases: thêm atomic event hand-off,
  ngừng direct publish sau commit cho hai flow được migrate.
- Dynamo write/counter adapters: thêm OUTBOX transaction item.
- Application relay use case và output ports, Dynamo/EventBridge implementations,
  Lambda entrypoint và composition wiring.
- `notifications/application/notifications.ts` và notification persistence:
  truyền event identity, conditional create/dedup và per-effect behavior.
- DynamoDB key/index definitions, infra Lambda/Scheduler/IAM và event routing:
  chỉ bổ sung resource cần cho slice; giữ resource IDs hiện có.

Outbox lưu metadata vận hành như status, attempt, nextAttemptAt, lease owner,
publishedAt. TTL chỉ dùng dọn bản ghi đã đủ retention; không dùng TTL làm cơ chế
retry hoặc xóa pending events chưa được xử lý.

### Tests bắt buộc

- Product write thất bại -> không tồn tại event outbox tương ứng.
- Product commit thành công -> event vẫn tồn tại khi request/worker bị dừng.
- Publish thành công rồi marker thất bại -> retry cùng identity; không nhân đôi
  database notification.
- Hai relay cùng claim -> ownership được bảo vệ; worker cũ không hoàn tất claim
  đã thuộc worker khác.
- Worker outage rồi chạy lại -> query/recovery xử lý hết pending event hợp lệ.
- Version/ownership conflict không tạo event cho mutation thất bại.
- Event schema cũ đang nằm trong queue vẫn được xử lý có chủ đích trong rollout.

### Rollout và rollback

Deploy relay/consumer tương thích trước; bật writer mới theo configuration ở
outer layer. Mỗi mutation chỉ dùng một đường phát event; không bật đồng thời
direct publish và outbox publish cho cùng write. Migrate update/increment như
một slice thống nhất.

Rollback producer không được xóa pending outbox hoặc dừng drain/recovery trước
khi backlog được xử lý. Thay đổi API response timing phải được ghi rõ.

## Phase 2: concurrency và recovery

- Test 100 requests mua một sản phẩm với stock=10; đếm durable winners, final
  stock, paid/sold state và effects theo business identity.
- Test hai request cùng request ID và hai request ID khác nhau; duplicate không
  được coi như một purchase mới.
- Chèn lỗi ở trước commit, sau commit, sau publish, trước ACK và sau ACK.
- Test IPN trùng, IPN đến sau expiry, refund query/provider timeout và replay.
- Rà `entrypoints/lambda/shared/sqs-idempotency.ts`: owner/fencing token phải được
  so sánh khi renew/complete/fail sau lease takeover; lease hết hạn không chứng
  minh external side effect chưa xảy ra.
- Giữ UNKNOWN/reconciliation/manual review cho kết quả tiền không chắc chắn;
  chỉ retry tự động ở các điểm có semantics an toàn.
- Tính transaction operation budget khi mở rộng outbox sang order nhiều items.

Hoàn thành khi có failure-injection suite chứng minh invariant trên DynamoDB
engine và một staging drill; không dùng mocked tests để khẳng định AWS behavior.

## Phase 3: DynamoDB access patterns

### Owner products

Hiện `managed-product-reads.ts` lấy tối đa 100 x 20 pages rồi lọc owner. Đây là
giới hạn cả completeness, không chỉ performance.

- Chốt owner + sort/filter access patterns và yêu cầu độ mới dữ liệu.
- Thiết kế owner GSI/projection hoặc index records phù hợp; so sánh chi phí,
  hot partitions, pagination và eventual consistency.
- Dùng cursor gắn với query/actor; ownership/authorization vẫn phải được enforce.
- Backfill có checkpoint/throttle, kiểm tra coverage, dual-read comparison trong
  rollout; không thêm index chỉ dựa vào tên field.

### Revenue report

Hiện dùng Scan + item queries. Chốt trước eligible order states và định nghĩa
doanh thu: report hiện tại gồm paid/done/pending, không tự đổi nghĩa khi tối ưu.

- Thiết kế time-index query hoặc daily revenue read model tùy access pattern.
- Nếu dùng projection, áp dụng event identity/version để duplicate không cộng
  tiền hai lần; có rebuild/reconciliation path.
- So sánh output cũ/mới trên dataset cố định, bao gồm refunds và ngày boundary.

Hoàn thành khi kết quả đầy đủ và có báo cáo latency/RCU/WCU/database calls trước
và sau, gồm chi phí ghi/index/backfill, không chỉ latency một request.

## Phase 4: observability và staging

- Truyền correlation/business IDs qua HTTP -> outbox -> event -> queue -> worker.
  Trace context bổ sung correlation, không thay business identity.
- Structured logs không ghi JWT, signed URLs, email body hoặc thông tin riêng tư
  không cần thiết.
- Theo dõi outbox oldest-pending age, retries, queue age, DLQ count, optimistic
  conflicts, UNKNOWN payments/refunds và p95 latency.
- Chọn thresholds từ baseline; tạo runbook: inspect -> reconcile/replay an toàn
  -> xác nhận durable state -> xử lý incident.
- Kiểm tra IAM tối thiểu và rollback trong staging. Replay không tự động được
  coi là an toàn với mọi external side effect.

Hoàn thành khi tìm được một đơn/event bị lỗi từ ID và chứng minh được cách phục
hồi theo runbook; có alert chủ động cho backlog, không chỉ log lỗi.

## Phase 5: TypeScript theo từng slice

`apps/api/tsconfig.json` hiện có strict=false. Thiết lập strict-check config riêng
cho slice đầu như shopping core; xử lý cả dependency closure, không che lỗi bằng
any/as hoặc exclusion tùy tiện. Ưu tiên nullable states, discriminated unions,
typed ports và error narrowing.

Khi slice ổn, đưa gate vào CI và mở rộng dần. Có thể làm song song Phase 1–4;
không bật strict toàn backend rồi sửa hàng loạt không liên quan trong một PR.

## Phase 6: PostgreSQL adapter lab

Làm trên branch/local environment riêng. Chọn Product write/counter ports, viết
SQL adapter có migration/constraints/conditional update hoặc locking phù hợp.
Chạy cùng contract tests và concurrency scenarios với DynamoDB adapter.

Mục tiêu là giải thích được isolation, index/query plan, rollback/deadlock retry,
idempotency và nơi port còn lộ persistence representation. Generic legacy response
trong một số port là trade-off hiện có; bài lab cần ghi rõ giới hạn đó, không hứa
chỉ đổi adapter là toàn bộ API tự tương thích.

Không cần migrate dữ liệu production để hoàn thành bài học.

## Cách học trong mỗi phase

Trước code: tự vẽ flow, failure points và nêu giả thuyết. Khi làm: tái hiện một
lỗi, thêm test có ý nghĩa, triển khai một slice, đo lại. Khi review: giải thích
decision, alternative, trade-off, bằng chứng và giới hạn. Mỗi phase kết thúc bằng
một demo có failure case và tài liệu ngắn để trình bày với mentor.

## Tài liệu chính thức

- [AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [DynamoDB GSI](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)
- [DynamoDB query pagination](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html)
- [OpenTelemetry context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html)
- [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
