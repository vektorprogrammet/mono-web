# Receipt notification delivery

Contract: [0097](../../design-specs/0097-receipt-notification-delivery.md).

Native receipt commands commit their receipt fact, SQL audit and outbox atomically. The backend composition installs the acknowledged transport adapter. Missing delivery configuration leaves notification work failed and retryable; it never substitutes recording-only success. The existing SQL audit is verified separately, not sent as mail.

## Configuration and recipient ownership

The adapter's authoritative configuration decoder is [receiptDeliveryConfig](../../apps/backend/src/receipt/delivery.ts). Supply all of these together:

| Environment variable | Meaning |
|---|---|
| `RECEIPT_DELIVERY_URL` | Explicit HTTPS receiver; HTTP is accepted only for numeric loopback rehearsal addresses. Credentials, query strings and fragments in the URL are rejected. |
| `RECEIPT_DELIVERY_TOKEN` | Bearer credential for that receiver. |
| `RECEIPT_DELIVERY_TIMEOUT_MS` | Integer 1–30000, no inferred timeout. |
| `RECEIPT_DELIVERY_SENDER` | Configured economy sender/contact email. |
| `RECEIPT_DELIVERY_ECONOMY_RECIPIENTS` | JSON object mapping canonical department IDs to economy recipient emails. No team-name/email guessing. |

Submission notifications go to the configured department economy recipient; refund/rejection notifications go to the owner's canonical `person_contact_profiles.email`. Login email is not a fallback. Resolve contacts and configured recipient policy at the **first attempt**, then persist the envelope on the existing outbox under its active claim before network access. PostgreSQL prevents later envelope replacement. Retrying after a contact or policy change therefore preserves the original envelope.

Status/reference comes from the immutable command observation. Amount, description and receipt date are reconstructed from command history up to that command's audit revision; historical receipts without those native command fields use their canonical receipt facts at first preparation. Messages identify the receipt, amount, description and date. Rejection directs the owner to the configured economy contact. Refund wording says *marked refunded*, because the native system does not establish that a bank transfer occurred. Private bank-account ciphertext and file storage references are never included.

## Transport contract and retry

The receiver receives a JSON email envelope and an `Idempotency-Key` equal to its stable `deliveryId`/outbox effect ID. A 2xx response acknowledges acceptance. Redirects are rejected. Rejection, network error and timeout remain Failed; the operator may retry. Pending predecessor effects retain their existing receipt ordering.

The receiver **must durably deduplicate by delivery identity and reject conflicting payloads**. A timeout or process crash may happen after remote acceptance but before local completion. Retrying is at least once: this implementation does not promise exactly-once delivery, actual provider delivery, or human receipt. The local rehearsal receiver demonstrates the protocol with a synthetic sink; deploying a real receiver remains separate work.

The [bounded operator command](../../apps/backend/src/receipt/drain-main.ts) processes existing work without creating a business mutation:

```sh
bun run apps/backend/src/receipt/drain-main.ts <receipt-id>
```

Run from the repository root with `BACKEND_PG_URL`, explicit `RECEIPT_STAGING_ROOT` and `RECEIPT_COMMITTED_ROOT`, and the complete delivery configuration already supplied through the operator's protected environment. It validates receipt existence, recovers claims older than 60 seconds using the existing claim mechanism, and processes at most 256 effects. It stops on failure. `Complete` exits 0; `NotFound`, `Busy`, `Failed` or `Limit` exit 1. A concurrent drainer may report Busy while another completes. Retry only after observing the other worker or repairing the failing boundary. There is no automatic retry loop or second queue.

## Local verification

```sh
RECEIPT_DELIVERY_REHEARSAL=1 bun run packages/database/runtime/receipt-import-rehearsal.ts
```

This extends the existing owned PostgreSQL/API receipt rehearsal after its zero-effect historical import window. It exercises real native sign-in and commands, acknowledged loopback HTTP acceptance, missing configuration, forced rejection, ambiguous timeout, restart, stable recipient/content, immutable envelope rejection, stale claim recovery, concurrent drains, incorrect token, redirect refusal and revoked approval authority. It also retains the import/private-file/reconciliation/nonempty restore observations. The runner requires a clean committed source and writes revision-pinned evidence under its reported temporary artifact directory, then stops owned processes and removes owned database/storage/credential material.

No provider credentials, actual recipients, production configuration or real data are used. Native account recovery/migration, rejected-claim reopening and production cutover remain outside this contract.
