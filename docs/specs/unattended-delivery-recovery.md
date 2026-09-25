# Unattended delivery recovery

## Scope

The native external Bun process owns password-reset mail and receipt outbox workers.
Internal ingress does not start either worker. Existing workers keep their current behavior.
No production access, provider credentials, deployment, or generic queue framework belongs to this slice.

## Current gaps and reuse

- `apps/backend/src/main.ts` supervises recruitment and other workers, but not reset or receipt delivery.
- `password-recovery/drain-main.ts` performs one explicit reset attempt. It does not provide unattended recovery.
- `packages/database/src/password-recovery.ts` owns claims, three-attempt limits, quarantine, verification checks, and security audit.
- Reset delivery currently reconstructs each payload. A durable first-payload fingerprint must prevent drift before network I/O.
- `receipt/drain-main.ts` performs bounded operator recovery for one receipt.
- `packages/database/src/receipt/outbox.ts` owns receipt claims, ownership fences, stale recovery, and delivery outcomes.
- `receipt/delivery.ts` already freezes notification envelopes. File and audit effects retain their existing interpreters.

## Configuration and lifecycle

`PASSWORD_RESET_DELIVERY_MODE` and `RECEIPT_DELIVERY_MODE` require `disabled` or `http`.
Enabled workers require complete existing provider configuration and valid positive poll intervals.
Disabled workers do not claim durable work. Receipt request-time delivery remains separate from its background worker.
Enabled reset delivery requires `MAIL_SENDER`, `MAIL_DELIVERY_URL`, `MAIL_DELIVERY_TOKEN`, and `MAIL_DELIVERY_TIMEOUT_MS`.
Enabled receipt delivery requires all existing `RECEIPT_DELIVERY_*` provider fields and explicit filesystem roots.
Each worker runs one bounded attempt per tick. Database or programming failure stops the root process with a nonzero exit.
SIGINT and SIGTERM stop HTTP acceptance, interrupt workers, and release the shared runtime and database pool.

## Recovery contract

A real password-reset request or receipt business command commits durable work before provider I/O.
An explicit temporary reset-provider failure remains retryable for at most three attempts.
An ambiguous reset outcome, stale reset claim, invalid verification, or permanent rejection remains quarantined.
Reset restart does not bypass expiry, current account authority, claim ownership, or quarantine.
Receipt stale claims return to the existing retry path. Late owners cannot complete replacement claims.
Receipt retries preserve the effect identity and first delivery envelope.
Reset retries reconstruct each payload from live verification and account data, then compare its SHA256 fingerprint.
Changed reset payloads quarantine without another provider request. Reset outboxes never store tokens, addresses, or rendered messages.
Every reset attempt still checks expiry and current authority. Delivery success does not create another business fact.
Previously attempted reset rows without a fingerprint quarantine on upgrade; their original payload cannot be established.
No claim of exactly-once delivery follows from this implementation. Providers must deduplicate stable delivery identities.

## Runtime acceptance

Use a disposable PostgreSQL cluster, loopback providers, and the actual Bun `main.ts` process.
For each domain, issue a real business request, observe a provider failure, stop the process, and restart it.
Recovery must succeed without another user request, operator drain, or SQL mutation of outcome rows.
Observe durable attempts, immutable payload identity, unchanged business facts, stale-claim fences, interruption cleanup, and root-worker failure.
Fixtures create only prerequisites. Fault injection does not fabricate the triggering business operation.
Evidence identifies the committed source and records sanitized observations, not tokens, cookies, reset links, or receipt payloads.

## Ownership

This slice owns backend lifecycle/configuration, reset/receipt delivery, required config callers, and a focused verification runner.
The parent owns shared status, architecture, changelog, root README, and root package scripts.
The recruitment slice owns its separate golden journey. Its existing worker is not changed here.
