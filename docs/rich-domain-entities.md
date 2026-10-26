# Rich domain model sau feedback về entity

Ngày: 2026-10-22. Các thay đổi trong tài liệu này tiếp nối đợt migration Clean
Architecture ngày 2026-10-21; kiểm chứng local, chưa deploy AWS.

Cập nhật 2026-10-26: constructor của entity/value object chỉ nhận, copy hoặc
chuẩn hóa dữ liệu; các invariant cần thiết được kiểm tra rõ ràng bằng assert,
factory hoặc method nghiệp vụ trước khi phát sinh side effect.

## Quy tắc tổ chức

- Entity giữ identity, business state và hành vi gắn với state đó.
- Value object giữ giá trị và invariant nhưng không cần identity riêng, ví dụ
  OrderItems, ProfileChange, SignUpEmail và UploadScope.
- Những chính sách đi qua nhiều entity, như retention, pricing hoặc retry schedule,
  thuộc domain policy/value object. Không ép mọi rule vào Product hoặc tạo base
  entity, inheritance hierarchy chung cho toàn backend.
- Application vẫn nhận command, gọi repository/provider, điều phối transaction
  boundary, retry, compensation và notifications. Entity không tự gọi database,
  NestJS, AWS SDK hoặc đọc env.

## Inventory triển khai

Paths bắt đầu từ `apps/api/src/modules/`.

| Capability | Class và vị trí | Hành vi đã chuyển |
| --- | --- | --- |
| Product | `shopping/domain/product.ts`: Product | Create defaults, editable stock, tăng/giảm counter, stock status, owner/version, inventory transition và alert transition |
| Order | `storefront/domain/order.ts`: Order | Ownership, trạng thái checkout/legacy completion, payment correlation, refund window, refund claim và response snapshot |
| Cart | `storefront/domain/order-items.ts`: OrderItems | Normalize product ID, merge duplicate lines, giới hạn số lượng |
| Payment | `vnpay/domain/payment-session.ts`: Payment | Amount match, callback outcome, terminal state, dispatch event và failed-order release intent |
| Payment draft | `vnpay/domain/payment-draft.ts`: PaymentDraft | Aggregate quantities, kiểm tra stock, tính line amount, amount limit và expiration |
| Campaign | `sales/domain/sale-campaign.ts`: Campaign | Creation time, editable state, remove product và scheduled transition intent |
| Pricing | `sales/domain/sale-price.ts`: SalePricing | Chọn campaign, tính giá và discount; giữ tie-break và rounding hiện tại |
| User | `customers/authorization/domain/user-account.ts`: UserAccount | Normalize account state, sign-in/token eligibility, không tự block và role identity |
| Profile | `customers/authorization/domain/user-profile.ts`: UserProfile, ProfileChange | Avatar ownership, partial-update validation, snapshot và address copy isolation |
| Sign-up email | `customers/authorization/domain/sign-up-email.ts`: SignUpEmail | Email shape, allowed/blocked domain/email policies |
| Email delivery | `email-deliveries/domain/email-delivery.ts`: EmailDelivery | Chọn safe retry recipients, loại unknown/accepted và bỏ nội dung riêng tư khỏi public meta |
| Email campaign | `email-deliveries/domain/email-campaign.ts`: EmailCampaign | Batch 50 và escape plain text thành HTML |
| Email recipient | `email-deliveries/domain/email-recipient.ts`: EmailRecipient | Feedback transition predecessors và affected-recipient attribution |
| Email route | `email-deliveries/domain/email-route.ts`: EmailRoute | Publish-attempt budget và persisted-payload eligibility |
| Retry schedule | `email-deliveries/domain/retry-schedule.ts`: RetrySchedule | Exponential backoff, cap và jitter với clock/random được truyền vào |
| Notification | `notifications/domain/notification.ts`: Notification | Admin audience, unread và system-only creation policy |
| Upload scope | `uploads/domain/upload-scope.ts`: UploadScope | Actor-owned image prefixes và private report key boundary |
| Inventory report | `inventory-reports/domain/inventory-report.ts`: InventoryReport | Ngày Việt Nam, lịch hai ngày, report identity và phân loại stock |
| Revenue report | `storefront/domain/revenue-report.ts`: RevenueReport | Date window, eligible states, tổng hợp và top products |
| Cleanup | `data-cleanup/domain/cleanup-policy.ts`: CleanupPolicy | Retention windows và eligibility của các nhóm dữ liệu |

Health/learning không có business entity cần tạo. Audit query enrichment và admin
replay vẫn là application orchestration; SDK commands, atomic conditions, audit
projection và provider-specific delivery guarantees tiếp tục ở adapter.

## Constructor, factory và snapshot

```ts
const product = new Product({
  id: "product-1",
  ownerId: "user-1",
  name: "Product",
  stock: 20,
  soldCount: 0,
  status: "active",
  version: 3
});

const next = product.decreaseStock(15);
next.stock;        // 5
next.status;       // low_stock
product.stock;     // 20, snapshot gốc không bị sửa
next.version;      // 3, database mới tăng version khi commit thành công
```

`new Product(snapshot)` tạo instance có private state và prototype methods.
`snapshot as Product` chỉ ép compiler tin vào type, không gọi constructor và không
tạo method. `extends` không cần thiết để một instance dùng method của class.

Các mutation trả instance mới có chủ đích. Phải giữ kết quả:

```ts
const next = product.increaseStock(2);
```

Không dùng `product.increaseStock(2)` rồi tiếp tục lưu `product` cũ.

`Product.create(id, ownerId, details)` là factory cho sản phẩm mới: nó validate
stock, áp dụng defaults và gọi constructor. `new Product(snapshot)` dùng để hydrate
state đã lưu, giữ stored status để các flow hiện tại vẫn phát hiện/repair projection
lệch. Constructor không validate snapshot. `assertValidState()` chỉ kiểm tra
counter/version cần cho safe writes; create/mutation/delete paths và product
creation adapter gọi assert ở điểm cần thiết. Counter tăng qua endpoint increment
vẫn không bị áp thêm trần editable stock.

```ts
const product = new Product(snapshot); // copy dữ liệu, không parse schema
product.assertCanBeManagedBy(actor);
product.assertVersion(expectedVersion);
const next = product.update(changes); // assert invariant cần thiết trước mutation
```

Request schema kiểm tra dữ liệu vào; response schema kiểm tra cấu trúc dữ liệu
ra. Chúng không thay thế rule trừ kho, quyền sở hữu, refund state hoặc atomic
database conditions. Entity không chạy lại schema đầy đủ của request/response.

| Điểm dựng object | Kiểm tra cần thiết được gọi ở đâu |
| --- | --- |
| `new Product(snapshot)` | `assertValidState()` và các assert theo hành động; factory/mutation methods bảo vệ invariant trước write |
| `new SignUpEmail(email)` | `assertAllowedBy(policy)` trong PrepareSignUp và compatibility helper, trước unique/link calls |
| `new ProfileChange(subject, patch)` | `assertAllowed()` trong UpdateProfile/UserProfile.update, trước storage lookup hoặc persistence |
| `new OrderItems(items)` | Chỉ copy snapshot; `OrderItems.create(items)` kiểm tra/normalize cart mới. `assertValid()` dùng khi cần kiểm tra snapshot đã hydrate |
| `new PaymentDraft(items)` | `assertValidItems()` trong CreatePayment, kể cả khi checkout đã cung cấp amount override |

Nhờ vậy có thể hydrate dữ liệu để đọc/inspect mà không tự chạy validation trong
constructor, nhưng không thể dùng các mutation flows được hỗ trợ để ghi counter
âm, overflow hoặc bỏ qua avatar/sign-up/cart policy. Các method public tạo ra
thay đổi phải giữ những invariant liên quan; không dựa vào việc caller có đi qua
HTTP schema hay không.

Database record, command, event và HTTP response vẫn có thể là interface/type.
Chúng là dữ liệu truyền qua boundary, không phải entity cần prototype method.
Product repository trả Product instance; các port khác có thể trả business
snapshot và use case hydrate bằng constructor trước khi áp dụng hành vi.

Không spread/serialize trực tiếp entity có private state:

```ts
const snapshot = product.toSnapshot();
const restored = new Product(snapshot);
```

Mapper `shopping/infrastructure/persistence/product.mapper.ts` tạo Product thật;
counter repository không còn spread Product rồi làm mất prototype. Các fake
repositories trong tests cũng trả instance thật.

## Flow cập nhật Product

```text
HTTP/Zod + authenticated principal
  -> ShoppingService chuyển principal thành actor
  -> UpdateProduct
     -> ProductWriteRepository.findById -> mapper -> new Product(snapshot)
     -> current.assertCanBeManagedBy(actor)
     -> current.assertVersion(expectedVersion)
     -> next = current.update(changes)
     -> repository.update(changes, next.stockStatus, expectedVersion, owner)
        -> conditional DynamoDB transaction + category index + audit middleware
     -> saved.product.stockAlertSince(current)
     -> publisher.publish(alert) khi có transition
  -> legacy HTTP representation
```

Entity không tự save hoặc publish. Một instance đúng nghiệp vụ không thể ngăn
hai request đọc cùng version; database conditional writes mới giải quyết race đó.

## Những semantics cần giữ

1. Administrative `adjustCounter` giữ clamp-to-zero như trước. Method mới
   `decreaseStock` từ chối trừ quá số hàng hiện có. `changeInventory` của
   checkout/cancel/refund từ chối âm kho, âm soldCount, overflow hoặc vi phạm
   reserved stock; không clamp và không che overselling.
2. Product và category index, version/ownership conditions cùng audit vẫn được
   xử lý trong các transaction hiện tại. Entity không thay thế atomic write.
3. Refund claim được chuẩn bị trong domain trước durable claim, dùng cùng thời
   điểm eligibility. Kết quả provider không chắc chắn vẫn pending/unknown; không
   tự phát sinh request ID mới hoặc gửi refund lại.
4. Email unknown/accepted không trở thành safe retry. Publish-before-marker,
   conditional leases, recipient feedback và partial outcomes vẫn giữ semantics.
5. Partial profile updates vẫn ghi các field được yêu cầu, không đọc rồi ghi lại
   toàn bộ profile gây mất cập nhật đồng thời. ProfileChange copy dữ liệu trước I/O.
6. HTTP routes, DynamoDB schema/GSI và event payloads giữ nguyên. ProductCreator
   là internal port có thay đổi: nhận Product instance cùng timestamps thay cho
   một payload gồm id/owner/details/status tách rời.

Các function cũ như deriveStockStatus, incrementCounter, resolveSalePrice,
isRefundEligible, feedbackTransition được giữ làm compatibility wrapper và gọi
class domain. Không có hai implementation business rule chạy song song.

## Verification

`test:domain` đã được thêm vào `npm run verify`. Có 12 tests mới kiểm tra real
instances, snapshot isolation, stock/concurrency preparation, order/refund,
payment, campaign, account/profile, email, notification/upload và report state.
Các regression shopping, storefront/payment, audit, HTTP boundaries và remaining
application behavior tiếp tục chạy; DynamoDB Local integration chạy riêng.

Kết quả local: source/test typecheck pass; architecture check có 106 core files,
14 modules, 46 entrypoints và 0 violations. `npm run verify -w @supermarket/api`
pass 167 tests. Thêm 5 DynamoDB Local engine tests pass, tổng 172 tests không skip.
Container database test đã dừng và bảng tên ngẫu nhiên đã được xóa. Đây không
phải kết quả AWS staging hoặc production.

Các số liệu trên là snapshot của đợt 2026-10-22. Đợt 2026-10-26 bổ sung regression
cho passive constructor, assert trước mutation/delete, kiểm tra payment items khi
skip stock validation và từ chối invalid product creation trước database write.
