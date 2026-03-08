# Receipt Lifecycle Contract

Simple 3-state DAG. No cycles, no computed state.

## State space

```
Status = { pending, refunded, rejected }
```

## Transitions

| Precondition | Operation | Postcondition |
|---|---|---|
| `user.isActiveTeamMember()` | `CreateReceipt(user, amount, desc, photo, date)` | `receipt.status = pending ∧ receipt.sum > 0 ∧ receipt.submitDate = now()` |
| `receipt.status = pending` | `Approve(receipt)` | `receipt.status = refunded ∧ receipt.refundDate = now()` |
| `receipt.status = pending` | `Reject(receipt)` | `receipt.status = rejected` |

## Invariants

1. **Sum positive:** `receipt.sum > 0`.
2. **Terminal states:** `refunded` and `rejected` are absorbing.
3. **Submit date immutable:** Set once in constructor.
4. **Visual ID unique:** `receipt.visualId` is a hex string, unique across all receipts.
5. **Photo required:** `receipt.picturePath ≠ null` (receipt photo as evidence).

## Implementation notes

- No state guards in the entity — `setStatus()` is unrestricted. The dashboard should enforce the transition rules in the UI (only show approve/reject for pending receipts).
- `visualId` is auto-generated (`bin2hex(random_bytes(4))`) — display this to users instead of database IDs.
