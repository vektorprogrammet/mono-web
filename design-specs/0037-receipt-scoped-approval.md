# Design spec 0037 — Scoped Receipt approval

> **Summary:** An authenticated active economy approver sees only Receipts authorized by their department or global approval scope, then refunds or rejects a `Pending` Receipt through the canonical SDK. The native Effect/PostgreSQL Receipt authority enforces scope, optimistic revision, terminal-state law, replay, and ordered notification/audit effects. One real browser journey proves accepted refund and rejection plus cross-department, stale, concurrent, unauthenticated, and terminal rejections without Symfony, provider, or production access.

## Metadata

| Field | Value |
|---|---|
| Goal | Complete native scoped economy resolution for Pending Receipts |
| Status | Frozen and accepted for local implementation; no production cutover authority |
| Depends on | Design specs 0035 and 0036 at `e1dd14a`; ADR 0004; ADR 0005; design specs 0033 and 0034 |
| Actors | Authenticated active department approver or global economy approver |
| Environment | Loopback HTTP, disposable PostgreSQL, disposable private filesystem root |

## User journey

1. A department approver opens **Utlegg** with a valid authenticated session.
2. The dashboard lists the native approver projection. Department scope returns only Receipts whose immutable `departmentId` equals the token-derived scope. Global scope returns Receipts across departments. `None` scope is denied.
3. Each row shows stable Receipt and visual IDs, owner person ID, department ID, description, exact NOK amount, receipt date, current state, and revision. Account ciphertext and private file identity are never exposed.
4. A `Pending` row offers exactly two semantic actions: **Refunder** and **Avvis**. No generic status setter or reopen action exists.
5. The browser submits a caller-generated stable `commandId`, stable `receiptId`, and `expectedRevision` through the canonical SDK. It supplies no actor, department, scope, owner, payment-account, or status field.
6. The HTTP adapter derives the active actor and approval scope exclusively from the authenticated token.
7. `ReceiptAuthority` executes `RefundReceipt` or `RejectReceipt` in one PostgreSQL transaction. It rechecks scope, exact current revision, and `Pending` state before committing.
8. Refund changes state to terminal `Refunded`, sets the authoritative refund instant, increments revision once, and emits ordered `NotifyReceiptRefunded` then `WriteReceiptAudit` requests.
9. Reject changes state to terminal `Rejected`, keeps `refundDate` null, increments revision once, and emits ordered `NotifyReceiptRejected` then `WriteReceiptAudit` requests.
10. The browser refreshes the native projection, shows the terminal state and incremented revision, and removes both resolution controls. Neither state can reopen.

## Canonical capability contract

The SDK adds an explicit approver capability:

- `receipts.listForApproval(filter?) -> ReceiptPage`;
- `receipts.refund(receiptId, expectedRevision, commandId) -> ReceiptCommandObservation`;
- `receipts.reject(receiptId, expectedRevision, commandId) -> ReceiptCommandObservation`.

The native endpoints are:

- `GET /api/admin/receipts` with an optional canonical status filter;
- `POST /api/admin/receipts/:receiptId/refund` with strict JSON `{ commandId, expectedRevision }`;
- `POST /api/admin/receipts/:receiptId/reject` with strict JSON `{ commandId, expectedRevision }`.

Stable string IDs, positive integer `amountOre`, `NOK`, current revision, and canonical status vocabulary are reused from the owner capability. Generic update, delete, reopen, or client-selected status endpoints are forbidden. Legacy numeric Receipt CRUD remains separate and must not call these routes.

## Authorization laws

| Token-derived scope | Visible and resolvable Receipts |
|---|---|
| `Department(departmentId)` | Exactly matching immutable Receipt department |
| `Global` | Every Receipt |
| `None` | None; request rejected |
| Inactive actor | None; request rejected |

A caller-supplied department or scope value has no authority and is rejected as excess input. Direct resolution of an out-of-scope Receipt returns the same typed scope denial regardless of whether it was absent from the list.

## Transition and replay laws

| Command | Required current state | Result | Revision | Durable effects |
|---|---|---|---|---|
| Refund | In-scope `Pending`, exact revision | terminal `Refunded`, refund instant set | `+1` | refund notification, audit |
| Reject | In-scope `Pending`, exact revision | terminal `Rejected`, refund instant null | `+1` | rejection notification, audit |

A replay with the same `commandId` and canonical command digest returns the original observation without another revision, audit row, command receipt, outbox request, or notification. Reusing the command ID with different command bytes is rejected. Concurrent refund and reject commands at the same expected revision produce exactly one accepted terminal transition and one stale or invalid-transition rejection.

## Meaningful rejections

The browser journey must observe and the API must type at least:

- missing or expired authentication;
- inactive actor;
- `None` approval scope;
- cross-department direct resolution;
- Receipt not found;
- stale `expectedRevision` after another accepted resolution;
- refund or reject after `Refunded`, `Rejected`, or `Withdrawn`;
- malformed or excess JSON;
- replayed command ID with different command bytes;
- durable PostgreSQL failure.

Every rejected command leaves the Receipt, revision, refund instant, command receipts, audit, outbox, and private file identity unchanged.

## Local boundary configuration

Reuse the explicit local configuration from specs 0035 and 0036. The token map must include an owner, two department approvers with different departments, and a global approver. Notifications and audit effects remain recording-only local interpreters. No email, provider, Cloudflare, Hyperdrive, R2, Symfony mutation, legacy database mutation, production data read, deployment, or route cutover is authorized.

## Evidence and definition of done

One deterministic local runner starts disposable PostgreSQL, private filesystem storage, native API, and dashboard, then drives Chromium through the real economy interface. Secret-free evidence must establish:

- department projection excludes other departments and includes its own;
- global projection includes both departments;
- accepted refund and accepted rejection each increment exactly once and render terminal state after refresh;
- cross-department direct resolution is visibly denied;
- same-command replay returns the original observation with no duplicate durable rows or effects;
- concurrent refund/reject has exactly one winner;
- terminal controls disappear and reopening is impossible;
- database state, revisions, refund-date invariant, audit actions, ordered outbox state, and duplicate-effect count;
- private file identities remain unchanged by resolution;
- cleanup removes the disposable database and private roots.

The journey is falsified if it uses legacy admin CRUD, accepts browser-supplied authority or status, exposes account/file identities, lists out-of-scope rows, reopens a terminal Receipt, permits two concurrent winners, bypasses the canonical SDK, mocks PostgreSQL, renders fixture state, leaks credentials or business/file content, emits real notifications, leaves duplicate effects, or cannot clean up. Focused package checks and repository root `check-types`, `lint`, `build`, and `test` must pass on the committed artifact, except unrelated pre-existing failures must be recorded with exact evidence.
