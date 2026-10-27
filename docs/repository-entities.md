# Entity boundaries for persistence

Application use cases construct or mutate domain objects before sending business data to a repository. DynamoDB adapters map entity fields to records and expressions; they retain conditional writes, audit writes, index maintenance and multi-record transactions. Provider adapters may construct a domain object from provider-generated data, such as the VNPay payment link, before passing it to persistence.

## Write paths

| Path | Domain object passed to persistence | Rules owned by domain |
| --- | --- | --- |
| Checkout creation | `Order` | Cart normalization, quantities, total, initial state, hold deadline |
| Queued order finalization | `Order` | Validated cart, pricing and initial pending state |
| Checkout payment linkage/transitions | `Order` plus transition context | Payment identity, correlation, allowed states, inventory deltas |
| Cancellation/refund/completion | `Order` | Ownership, refund claim/outcome, completion prerequisites |
| Product create/update/counter/delete | `Product` plus write conditions/field mask | Stock/counter changes, status, ownership, version, editable fields |
| Sale campaign create/change/cancel | `Campaign` plus expected state/version | Creation timing, product removal, terminal state and schedule decisions |
| Payment create/confirmation | `Payment` | Initial pending state, amount, identity and callback outcome |
| Manual payment review | `PaymentReview` | Identity matching and reopening uncertainty for stronger evidence |
| Profile/account/permissions | `ProfileChange`, `UserAccount`, `UserPermissionChange` | Avatar/address ownership and validity, self-block prevention, supported permissions |
| Notification creation | `Notification` | Identity, required content and initial pending/unread state |
| Email delivery creation | `EmailDelivery` | Recipient normalization, duplicates/count, identities and pending state |
| Email route creation | `EmailRoute` | Batch bounds, payload snapshot and initial publishing state |
| Inventory report submission | `InventoryReportDelivery` | Valid counts, computed product count and initial state |

`ProfileChange` and `UserPermissionChange` are value objects, not replacement user snapshots. Persisting only the changed fields or using atomic set operations avoids overwriting unrelated concurrent updates.

Maintenance/seed product facades construct domain objects and call the same adapters as HTTP writes. Low-level product transaction builders are private implementation details.

## Order model

`OrderData` is the only interface describing order data. `Order` is a non-generic class with readable, immutable fields such as `id`, `status`, `items` and `totalAmount`. Repository `findById()` methods return `Order | null`; callers use its business methods directly. There are no separate `HeldOrder`, `RefundOrder`, creation-state interfaces or `Order.toSnapshot()` conversions. The persistence mapper handles the old `price` field versus the current `unitPrice` field.

The constructor restores stored data without recalculating committed prices. `Order.create()` creates and validates a new order; action methods return another `Order` while leaving the original unchanged.

## Checkout example

`CreateCheckout.execute()` first checks for an existing order with the same identity. A replay uses the existing items and committed prices. A new request reads a pricing projection, calls `Order.create()`, then calls `CheckoutOrders.create(order)`.

The adapter rereads products for record/index mapping and compares their versions with the quote used by the entity. A stale quote cannot silently persist a different price or inventory snapshot. The transaction checks those versions again, covering the race after the adapter read. A concurrent request that already created the same order is replayed after checking owner, items, linkage and expiry.

## Intentional non-entity contracts

- List/search/report queries can return read models. These projections are not mutable business aggregates.
- IDs, expected versions/owners, field masks, clocks and provider references remain explicit write context. They are required for conditional persistence and do not duplicate aggregate calculations.
- Outbox leases, checkpoints, deduplication receipts, audit ledgers, delivery markers and DynamoDB keys remain infrastructure concerns. Their atomic conditions must not be replaced by an in-memory check.
- Constructors support rehydration of stored data. Creation factories and action methods enforce the rules for new writes; plain JSON data must be reconstructed as an entity before calling its methods.

## Validation

`npm run verify -w @supermarket/api` runs type checks, architecture checks and local domain/application/HTTP/SDK-transport tests. SDK transport doubles verify transaction construction and modeled conditional failures; they do not prove behavior of the DynamoDB engine or deployed AWS resources. The isolated engine suite is `npm run test:integration -w @supermarket/api` with `PHASE7_DYNAMODB_ENDPOINT` set to a loopback DynamoDB Local endpoint.
