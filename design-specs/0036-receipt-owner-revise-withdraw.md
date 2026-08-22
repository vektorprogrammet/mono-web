# Design spec 0036 — Receipt owner revise and withdraw

> **Summary:** An authenticated active assistant manages one owned `Pending` Receipt through the canonical SDK. They can revise its description, exact amount, date, and optionally replace its private file; or withdraw it without deleting its durable identity. The native Effect/PostgreSQL Receipt authority enforces ownership, optimistic revision, terminal-state law, command replay, and ordered file effects. One real browser journey observes the accepted transitions and stale, foreign-owner, invalid, and terminal rejections without Symfony, provider, or production access.

## Metadata

| Field | Value |
|---|---|
| Goal | Complete native owner management for a Pending Receipt |
| Status | Frozen and accepted for local implementation; no production cutover authority |
| Depends on | Design spec 0035 at `b3c604b`; ADR 0004; ADR 0005; design specs 0033 and 0034 |
| Actor | Authenticated, active assistant who owns the Receipt |
| Environment | Loopback HTTP, disposable PostgreSQL, disposable private filesystem root |

## User journey

1. The assistant opens **Mine Utlegg** with a valid authenticated session and sees an owned `Pending` Receipt.
2. They open its edit control. The form starts with the persisted description, exact NOK amount, receipt date, and current revision.
3. They change the description, amount, or date and may select a replacement PDF, PNG, or JPEG of at most 10 MiB.
4. The dashboard sends a caller-generated stable `commandId`, stable `receiptId`, and `expectedRevision` through the canonical Receipt SDK. The wire amount remains integer `amountOre`.
5. The HTTP adapter derives the authenticated actor. It never accepts owner, department, account, active-state, or approval authority from the browser.
6. `ReceiptAuthority` executes `RevisePendingReceipt` in one PostgreSQL transaction. An accepted revision preserves owner, department, original submission time, visual ID, and Receipt identity, then increments revision exactly once.
7. If a replacement file was supplied, the ordered outbox promotes the new immutable file before deleting the superseded file. A promotion failure preserves the currently committed file and remains recoverable.
8. The refreshed owner projection and browser show the revised Receipt and its incremented revision.
9. The assistant can instead withdraw the current `Pending` Receipt with a new stable `commandId` and its current revision.
10. `WithdrawPendingReceipt` changes the durable state to terminal `Withdrawn`, increments revision exactly once, retains the Receipt row and audit history, and schedules deletion of its private file.
11. The refreshed browser shows `Withdrawn` and offers no revise or withdraw control. No route can reopen it.

## Canonical capability contract

The SDK extends the semantic Receipt capability with:

- `revise(receiptId, expectedRevision, input, replacementFile?) -> ReceiptCommandObservation`;
- `withdraw(receiptId, expectedRevision, commandId) -> ReceiptCommandObservation`;
- stable string `ReceiptId` and `CommandId`;
- positive safe integer `amountOre`, currency fixed to `NOK`;
- owner projections expose the current non-negative integer `revision`;
- typed rejections preserve unauthenticated, inactive, wrong-owner, not-found, stale-revision, invalid-transition, decode, replay-conflict, file, and persistence failures without exposing secrets, SQL, account values, or file bytes.

The native endpoints are `POST /api/receipts/:receiptId/revise` using multipart data and `POST /api/receipts/:receiptId/withdraw` using JSON. Generic update, delete, reopen, and status-setter endpoints are forbidden. Untouched approval and refund/reject legacy operations remain separate until their own accepted journey replaces them.

## Accepted transition laws

| Command | Required current state | Result | Revision | File behavior |
|---|---|---|---|---|
| Revise without replacement | Owned `Pending`, exact current revision | `Pending` with revised fields | `+1` | Existing identity preserved |
| Revise with replacement | Owned `Pending`, exact current revision | `Pending` with revised fields and new file identity | `+1` | Promote replacement, then delete old file |
| Withdraw | Owned `Pending`, exact current revision | terminal `Withdrawn` | `+1` | Delete current file through ordered outbox |

A replay with the same `commandId` and canonical command digest returns the original observation without another revision, audit row, command receipt, outbox row, promotion, or deletion. The same `commandId` with different command bytes is rejected.

## Meaningful rejections

The browser journey must observe and the API must type at least:

- missing or expired authentication;
- inactive actor;
- Receipt not found;
- foreign-owner Receipt;
- stale `expectedRevision` after another accepted command;
- revise or withdraw after `Withdrawn`, `Refunded`, or `Rejected`;
- invalid date, description, amount, replacement type, or replacement size;
- replayed `commandId` with different command bytes;
- durable PostgreSQL failure.

Every rejection leaves the Receipt, revision, audit, outbox, and committed file identity unchanged. A rejected replacement is removed from staging or retained only as explicitly evidenced recoverable staging state.

## Local boundary configuration

Reuse design spec 0035's explicit loopback host and port, PostgreSQL URL, private staging and committed roots, file-size limit, token-to-actor mapping, clock, and stable ID generators. No Cloudflare, Hyperdrive, R2, Symfony mutation, legacy database mutation, production data read, deployment, or route cutover is authorized.

## Evidence and definition of done

One deterministic local runner starts disposable PostgreSQL, the private filesystem adapter, native API, and dashboard, then drives Chromium through the real owner interface. Secret-free evidence must establish:

- an accepted revision without replacement and exactly one revision increment;
- an accepted replacement with promotion-before-delete ordering and current-file preservation on injected promotion failure;
- an accepted withdrawal that retains the durable Receipt as `Withdrawn` and removes owner mutation controls;
- same-command replay identity with no duplicate durable rows or file effects;
- visible stale-revision, foreign-owner, invalid-input, and terminal-transition rejections;
- owner projection and rendered values after refresh;
- database counts, audit actions, outbox order/status, and file lifecycle identities without bytes;
- cleanup of the disposable database and filesystem roots.

The journey is falsified if it uses legacy CRUD, performs hard deletion, accepts browser-supplied authority, allows terminal reopening, ignores optimistic concurrency, deletes the current file before replacement promotion, bypasses the canonical SDK, mocks PostgreSQL or file bytes, renders fixture state, leaks credentials or business/file content, leaves duplicate effects, or cannot clean up. Focused package checks and repository root `check-types`, `lint`, `build`, and `test` must pass on the committed artifact, except unrelated pre-existing failures must be recorded with exact evidence.
