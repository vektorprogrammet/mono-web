# Rejected receipt correction

The frozen behavior is [0102](../../design-specs/0102-reopen-rejected-receipt.md).
The explicit `ReopenRejectedReceipt` decision is owned by
[`receipt/update.ts`](../../packages/domain/src/receipt/update.ts); the native
endpoint and generated SDK operation are `receipts.reopenReceipt`.

Experience it in the native dashboard: Utlegg → Avvist → Åpne for korrigering →
Bekreft gjenåpning. The owner reloads Mine utlegg, edits the same claim and saves.
The approver finds it under Venter and resolves it again. Success is announced
when the rejected-only row disappears; choose Venter to inspect the updated row.

Run the synthetic end-to-end gate from a clean committed checkout after building
`packages/sdk` and the root-mounted dashboard:

```sh
bun run --cwd packages/sdk build
DASHBOARD_MOUNT=/ bun run --cwd apps/dashboard build
RECEIPT_DELIVERY_REHEARSAL=1 RECEIPT_REOPEN_REHEARSAL=1 bun run packages/database/runtime/receipt-import-rehearsal.ts
```

This reuses the 0095 PostgreSQL/auth/import harness and 0097 acknowledged loopback
transport. It additionally runs the production dashboard with Chromium, captures
three fixed-name screenshots and returns 0102 observations nested in
`deliveryObservation.reopening` in the printed evidence path. PostgreSQL tools
must be on PATH and dashboard port 5174 free. No real provider configuration is
accepted. The runner removes its private database, storage and backup artifacts;
only sanitized evidence and the named screenshots remain.

Source tests, generated metadata checks, build results and real runtime evidence
are different gates. The transport's 202 response establishes local acceptance,
not human receipt or bank payment. Refunded and Withdrawn remain terminal; owner
self-reopening and paid-claim reopening are outside this contract.
