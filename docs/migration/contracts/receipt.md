# Receipt Lifecycle Contract

Simple 3-state DAG. No cycles, no computed state.

## State space

```
Status = { pending, refunded, rejected }
```

String constants in `Receipt.php`: `STATUS_PENDING`, `STATUS_REFUNDED`, `STATUS_REJECTED`.

## Transitions

| Operation | Guard | Effect | Constraint |
|---|---|---|---|
| `CreateReceipt(user, amount, desc, photo, receiptDate)` | `user is authenticated, sum > 0, receiptDate provided` | `status = pending, submitDate = now(), visualId = auto-generated` | **Sum positive:** enforced by Symfony validation, not DB. **Submit date immutable:** set once. |
| `Approve(receipt)` | `status = pending` | `status = refunded, refundDate = now()` | **Terminal:** `refunded` is absorbing. |
| `Reject(receipt)` | `status = pending` | `status = rejected` | **Terminal:** `rejected` is absorbing. |

Authorization is handled outside the entity (API Platform security annotations, not entity-level checks).

## Fields

| Field | Type | Validation | Notes |
|-------|------|------------|-------|
| `sum` | decimal | `> 0` (Assert\GreaterThan) | Amount claimed |
| `description` | string | max 5000 chars (Assert\Length) | Expense description |
| `submitDate` | datetime | set once in constructor | When the receipt was submitted |
| `receiptDate` | datetime | NotBlank | When the expense occurred (separate from submit date) |
| `picturePath` | string? | nullable in ORM, no NotBlank assertion | Receipt photo path |
| `visualId` | string | unique | Hex display ID (see below) |
| `refundDate` | datetime? | set on approval | When the refund was processed |

**Visual ID:** Generated as `dechex(round(microtime(true) * 1000))` — timestamp-based, not random. Concurrent requests within the same millisecond could theoretically collide.

## Implementation notes

- No state guards in the entity — `setStatus()` is unrestricted. Neither the entity nor the API enforces transition rules. The dashboard should enforce in the UI (only show approve/reject for pending receipts), but the API should also add guards.
- `picturePath` is nullable at the ORM level despite photos being conceptually required. The dashboard should enforce photo upload on the create form.
- Display `visualId` to users instead of database IDs.
- API endpoints: `POST /api/receipts` (create), `PUT /api/receipts/{id}` (update), `PUT /api/admin/receipts/{id}/status` (admin status change). Note the non-admin path for creation vs admin path for approval.
