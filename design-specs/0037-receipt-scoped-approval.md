# Design spec 0037 — Scoped Receipt approval

> **Summary:** An authenticated active economy approver sees only Receipts authorized by their department or global approval scope, then refunds or rejects a `Pending` Receipt through the canonical SDK. The native Effect/PostgreSQL Receipt authority enforces scope, optimistic revision, terminal-state law, replay, and ordered notification/audit effects. One real browser journey proves accepted refund and rejection plus cross-department, stale, concurrent, unauthenticated, and terminal rejections without Symfony, provider, or production access.

## Metadata

| Field | Value |
|---|---|
| Goal | Complete native scoped economy resolution for Pending Receipts |
| Status | Frozen through amendment 0037.1. Amendment implementation and evidence are pending. No production cutover authority |
| Depends on | Design specs 0035 and 0036 at `e1dd14a`; ADR 0004; ADR 0005; design specs 0033 and 0034 |
| Actors | Authenticated active department approver or global economy approver |
| Environment | Loopback HTTP, disposable PostgreSQL, disposable private filesystem root |
| Amendment | `0037.1` corrects only the disposable identity, authority-fixture, transport, and evidence-harness contract |
| Amendment base | `20d30b82fe060df390ddf01b949e85ce936a4ff2` |
| Revision status | Implementation and evidence pending |

## Amendment 0037.1 — native Identity and finance evidence correction

The current runner uses bearer-token maps and a `jwt_token` cookie. Those values are not Better Auth sessions.

This amendment supersedes only the token-map and evidence-harness clauses. All other clauses in this specification remain authoritative.

The following laws remain unchanged:

- Receipt refund and rejection semantics.
- Scope denial and inactive-actor laws.
- Exact replay, changed replay, concurrency, revision, and terminal-state laws.
- Audit, outbox, notification-order, private-file, and cleanup laws.
- Product, provider, production, deployment, credential, and operator boundaries.

This amendment authorizes no product route or domain change. It authorizes no compatibility endpoint or status setter.

### Disposable personas and canonical authority

The run must seed exactly seven deterministic, disposable Better Auth personas. Each Better Auth user identifier must equal its canonical `PersonId`.

| Persona | Canonical Organization and Economy facts |
|---|---|
| `owner-a` | Active ordinary membership in department A, payment authority for department A, and no approval grant |
| `owner-b` | Active ordinary membership in department B, payment authority for department B, and no approval grant |
| `approver-a` | Active membership in department A and an active Department receipt-approval grant for department A |
| `approver-b` | Active membership in department B and an active Department receipt-approval grant for department B |
| `approver-global` | Active ordinary membership, an active Global receipt-approval grant, and no global-administrator grant |
| `approver-inactive` | Ended membership and a known Department receipt-approval grant that produces `InactiveActor` |
| `approver-none` | Active membership in department A and no receipt-approval grant, which produces `ReceiptScopeDenied` |

Identity proves only the person and session identity. Public-schema Organization and Economy facts provide all authorization.

The fixture must contain these exact counts:

| Fixture fact | Count |
|---|---:|
| Better Auth users | 7 |
| Credential accounts | 7 |
| Person profiles | 7 |
| Contact profiles | 7 |
| Departments | 2 |
| Teams | 2 |
| Organization memberships | 7 |
| Active memberships | 6 |
| Inactive memberships | 1 |
| Organization global-administrator grants | 0 |
| Payment authorities | 2 |
| Receipt-approval grants | 4 |

The seed must use the existing `identity:seed` entrypoint for identity migrations and credentials. One transaction must add canonical Organization and Economy facts.

The seed script must own the exact fixture bytes used for the evidence digest. The runner must not derive authority from environment tokens.

### Session and transport contract

The runner must generate one process-scoped `BETTER_AUTH_SECRET`. It must set `BETTER_AUTH_URL` to the dashboard origin.

The seed, backend, dashboard, and browser processes must receive both values. No process can use a persistent credential.

Each persona must authenticate through the rendered `/login` form. `/api/auth/sign-in/email` is the only permitted sign-in surface.

The proxy must forward every upstream `Set-Cookie` value with `Headers.getSetCookie()`. It must observe exactly one `better-auth.session_token` cookie per authenticated persona.

The evidence must not store a cookie value. `GET /api/me/session` must resolve each authenticated session to the expected `PersonId`.

All protected native Receipt requests must use the session cookie. They must not contain an `Authorization` header.

Only explicit unauthenticated probes can omit the session cookie. The native run must use no JWT, bearer token, or token map.

### Request ledger

A loopback recording proxy must record every upstream request. Each ledger entry must contain:

- the method, pathname, query, and response status.
- a sanitized body shape, or the semantic `commandId` and `expectedRevision`.
- `sessionCookieAuth`.
- `authorizationHeaderPresent`.
- the resolved session `PersonId`.
- the canonical authority-fixture label.

The ledger must not contain cookies, session values, passwords, multipart receipt bytes, payment ciphertext, or business and file content.

Every protected Receipt entry must have `sessionCookieAuth=true` and `authorizationHeaderPresent=false`. Only unauthenticated probes can have `sessionCookieAuth=false`.

Each refund or reject body must contain exactly `commandId` and `expectedRevision`. It must contain no authority, owner, payment-account, or status field.

The filtered Receipt-operation sequence must be exact. Only the concurrent refund and reject pair can appear in either order.

The run must record zero requests to:

- a Symfony origin or Symfony route.
- a fixture API.
- `POST /api/login`.
- any route that uses `jwt_token`.
- `PUT /api/admin/receipts/:id/status`.
- any generic `PUT`, `PATCH`, or `DELETE` Receipt mutation.

The run must not assert the raw order of authentication and profile traffic. Dashboard loaders can add session and profile reads.

### Frozen status matrix

The runner must prove this exact HTTP status matrix:

| Operation and condition | Status |
|---|---:|
| Approval list with a missing or invalid session | 401 |
| Approval list for the inactive actor | 403 |
| Approval list for the no-scope actor | 403 |
| Approval list for a Department or Global approver | 200 |
| Refund or reject for the inactive actor | 403 |
| Refund or reject with malformed JSON, excess JSON, or query parameters | 422 |
| Refund or reject for a foreign department | 403 |
| Refund or reject of an absent Receipt by a Department approver | 403 |
| Refund or reject of an absent Receipt by the Global approver | 404 |
| Accepted refund or rejection | 200 |
| Identical command replay | 200 |
| Changed command replay | 409 |
| Stale or terminal command | 409 |
| Concurrent refund and reject | Unordered pair with exactly one 200 and one 409 |
| Approval list during a forced PostgreSQL failure | 503 |
| Approval list after PostgreSQL recovery | 200 |

### Accepted semantic replacement

This native journey uses only scoped refund and reject commands. These commands are the accepted semantic replacement for legacy `PUT .../status`.

The legacy-route step represents covered, retired legacy inventory. The native journey must not execute legacy-route traffic.

The journey reference must equal `intent://journey:parity:finance_operations:v1`. Its accepted step identifiers must equal exactly:

- `finance-operations-api-operation`.
- `finance-operations-command-write`.
- `finance-operations-legacy-route`.
- `finance-operations-mono-route`.

The browser evidence and runner constants must contain the same journey reference and exact step set. No additional journey or step is permitted.

This amendment does not change `accepted-intent.json`. A separate immutable accepted-intent revision and its generated projections remain pending.

### Durable evidence and one receipt

Owners must create and read four `Pending` Receipts through cookie-authenticated native routes. Approvers must list and resolve them through the canonical SDK.

Each accepted command must be followed by a fresh approval-list read. The dashboard must show the terminal state after that read.

The completed run must prove these exact durable facts:

- 4 `economy_receipts` rows.
- 8 accepted `economy_receipt_command_receipts` rows.
- 8 matching `economy_receipt_audit` rows.
- 20 delivered `economy_receipt_outbox` rows.
- 0 pending outbox rows.
- 0 duplicate effects for a `(commandId, ordinal)` pair.
- All four Receipts have revision 1.
- Only a `Refunded` Receipt has a refund date.
- Each `Rejected` Receipt has a null refund date.
- Rejected commands and the stale loser create no Receipt, audit, command-receipt, or outbox row.
- Submission effects occur as `PromoteReceiptFile`, `NotifyEconomyReceiptSubmitted`, then `WriteReceiptAudit`.
- Resolution effects occur as the matching notification, then `WriteReceiptAudit`.
- Four private files are committed, zero files remain staged, and all file identities are unchanged.

The audit actor must equal the applicable owner `PersonId` for each submission. The Global approver must own every accepted resolution audit.

The runner must prove seven successful `/api/me/session` bindings. It must also prove that no environment token supplied authority.

The runner must complete all browser, step-equality, ledger, PostgreSQL, private-file, and cleanup checks before it writes evidence.

After those checks succeed, it must call `emitNativeRuntimeEvidenceReceipts` exactly once. The browser specification must write only temporary browser evidence.

The call must produce one native receipt with this fixed input:

| Field | Exact value |
|---|---|
| `fixtureId` | `native-receipt-approval-0037` |
| Journey | `intent://journey:parity:finance_operations:v1` with the exact four step identifiers above |
| Source paths | `apps/dashboard/e2e/run-real-receipt-approval.mjs`, `apps/dashboard/e2e/receipt-approval.spec.ts`, `apps/dashboard/e2e/native-receipt-approval-seed.mjs` |
| Fixture bytes | Exact bytes of `apps/dashboard/e2e/native-receipt-approval-seed.mjs` |
| Artifact bytes | Sanitized Playwright JSON reporter output |
| Generated path | `evidence/functional-parity/runtime/native-receipt-approval-0037.json` |

The implementation and evidence for amendment 0037.1 remain pending. An operator must separately authorize every external effect.

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
