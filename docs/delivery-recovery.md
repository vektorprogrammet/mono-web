# Native delivery recovery

The external Bun backend owns password-reset mail, receipt outbox, and team application notification workers.
The internal ingress never starts these workers. Recruitment and other existing workers keep their separate configuration.

## Configuration

The password-reset and receipt mode variables are required, including for internal ingress and local development.
The [backend configuration](../apps/backend/src/config.ts), [mail parser](../apps/backend/src/mail/http.ts), and [receipt parser](../apps/backend/src/receipt/delivery.ts) define these values.

| Variable                                 | Values or requirement                                            |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `PASSWORD_RESET_DELIVERY_MODE`           | `disabled` or `http`                                             |
| `PASSWORD_RESET_DELIVERY_POLL_MS`        | Positive integer; default `1000` when enabled                    |
| `MAIL_SENDER`                            | Valid email address; required for enabled reset delivery         |
| `MAIL_DELIVERY_URL`                      | HTTPS endpoint, or HTTP on `127.0.0.1` for a local rehearsal     |
| `MAIL_DELIVERY_TOKEN`                    | Provider bearer token                                            |
| `MAIL_DELIVERY_TIMEOUT_MS`               | Integer from `1` through `30000`                                 |
| `RECEIPT_DELIVERY_MODE`                  | `disabled` or `http`                                             |
| `RECEIPT_DELIVERY_POLL_MS`               | Positive integer; default `1000` when enabled                    |
| `RECEIPT_DELIVERY_URL`                   | HTTPS endpoint, or HTTP on loopback for a local rehearsal        |
| `RECEIPT_DELIVERY_TOKEN`                 | Provider bearer token                                            |
| `RECEIPT_DELIVERY_TIMEOUT_MS`            | Integer from `1` through `30000`                                 |
| `RECEIPT_DELIVERY_SENDER`                | Valid email address                                              |
| `RECEIPT_DELIVERY_ECONOMY_RECIPIENTS`    | Nonempty JSON object from department IDs to email addresses      |
| `RECEIPT_STAGING_ROOT`                   | Explicit staging directory for the enabled receipt worker        |
| `RECEIPT_COMMITTED_ROOT`                 | Explicit committed-file directory for the enabled receipt worker |
| `TEAM_APPLICATION_DELIVERY_MODE`         | `disabled` (default) or `http`; `http` needs the mail variables  |
| `TEAM_APPLICATION_DELIVERY_POLL_MS`      | Positive integer; default `1000`                                 |
| `TEAM_APPLICATION_DELIVERY_STALE_MS`     | Positive integer lease expiry; default `60000`                   |
| `TEAM_APPLICATION_DELIVERY_RETRY_MAX_MS` | Positive integer bound of the retry delay; default `300000`      |
| `TEAM_APPLICATION_DELIVERY_MAX_ATTEMPTS` | Positive integer; the last attempt, default `48`                 |

Enabled workers reject incomplete provider configuration before the listener starts.
Endpoints cannot contain credentials, query strings, or fragments. Delivery does not follow redirects.
Secrets belong in the process environment, not command arguments or repository files.

`disabled` stops the background worker. It does not remove durable work.
Receipt requests still use their existing bounded post-commit delivery path when receipt provider configuration is present.
To prevent all receipt provider calls, disable the worker and omit the receipt provider configuration.
Reset delivery does not occur in the password-reset request itself.

## Start and stop

1. Configure the database, native identity boundary, and the required delivery modes.
2. For enabled receipt delivery, mount the same private storage roots for requests and workers.
3. Start the backend with the pinned Bun runtime:

   ```sh
   bun --no-env-file apps/backend/src/main.ts
   ```

4. To stop the backend, send SIGTERM or SIGINT to its process.

Startup runs the existing database migration path and health check before the workers start.
Each worker performs one delivery attempt per tick, then waits for its poll interval.
Receipt polling also recovers claims older than 60 seconds on each tick.
Reset polling quarantines claims older than 60 seconds.

Shutdown stops HTTP acceptance, interrupts workers, joins their completion, and disposes the shared runtime and database pool.
Reset interruption aborts the provider call and records a fenced ambiguous-outcome quarantine before pool disposal.
A database failure during this cleanup produces a nonzero exit.
A hard kill cannot run cleanup. The next process applies the existing stale-claim rules.

## Recovery rules

### Password-reset mail

A real reset request commits a verification reference and an outbox row before delivery.
The outbox stores no email address, reset token, or message body.
The canonical reset token remains in `auth.verification`.

The first attempt stores a SHA256 fingerprint of the rendered payload before provider I/O.
Each retry reconstructs the payload from live verification and account data.
A changed fingerprint quarantines the row with `verification-invalid`; it does not send a changed payload under the old delivery identity.
A sender, origin, template, or mailbox change can therefore require a new user request after quarantine.

Every attempt checks that the verification exists, remains unexpired, and belongs to an enabled account.
Successful delivery does not extend expiry or consume the verification.
Delivery cleanup does not delete a live reset token.

| Outcome                                          | Recovery                                          |
| ------------------------------------------------ | ------------------------------------------------- |
| Provider acknowledgment                          | Mark `Delivered` under the current claim          |
| Temporary provider failure                       | Retry on a later tick, for at most three attempts |
| Third temporary failure                          | Quarantine                                        |
| Permanent rejection or timeout                   | Quarantine; no automatic resend                   |
| Interrupted or stale claim                       | Quarantine; no automatic resend                   |
| Invalid, expired, mismatched, or changed payload | Quarantine; no automatic resend                   |
| Database or programming failure                  | Stop the native process with a nonzero exit       |

Migration 68 adds the non-secret fingerprint.
Previously attempted, nonterminal rows without a trustworthy original fingerprint become quarantined.
Unattempted rows remain eligible. Existing delivered rows and canonical verifications remain unchanged.

### Receipt work

A receipt command commits business facts, its command receipt, audit, and outbox work in one transaction.
Provider failures do not repeat the command or create another business audit event.
The queue also contains file promotion, file deletion, and audit checks; the worker preserves these interpreters.

The first notification attempt freezes its envelope before network I/O.
Retries use the same effect identity and envelope, including after provider configuration or contact changes.
A receipt's earlier effects must complete before its later effects become eligible.
Among eligible receipts, lower attempt counts take priority. A failed receipt does not block every other receipt.

Failed receipt work remains retryable. Each tick remains bounded and waits even after failure.
A stale claim returns to the retry path. Late owners cannot complete or fail a replacement claim.
Storage failures remain failed work; the worker never skips required file promotion.
Storage operations can outlast a lease, so their existing digest and replay checks remain necessary.

Database errors and invalid durable envelopes stop the root worker.
Provider rejection, timeout, and transport errors remain retryable receipt outcomes.

### Team application notifications

A submission commits the application, its command receipt, both notification envelopes, and one queue item per notification in one transaction.
The envelope rows in `team_application_outbox` keep the identity, the private envelope, the policy state, and the outcome.
The queue items in `effect_queue`, Effect's `PersistedQueue` SQL store, name only the effect. The queue owns the lease, the attempt count, and the retry delay.
`team_application_delivery_state` reads both rows: `Pending`, `Processing` while an attempt holds the lease, `Failed` while a retry waits, or the outcome.

Each attempt decodes the stored envelope and sends it with the `effect_id` as the provider idempotency key; a retry sends the same request.
An attempt records its outcome only while it holds the lease: its attempt number must still be the item's.
A worker that stops refreshing its lease loses it after `TEAM_APPLICATION_DELIVERY_STALE_MS`. Another attempt then takes the item, and the late owner records nothing.

| Outcome                                            | Recovery                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Provider acknowledgment                            | `Delivered`; the envelope is cleared                                            |
| Temporary provider failure before the last attempt | `Failed`; retried after a doubling delay from one second                        |
| Temporary failure of the last attempt              | `Quarantined`; the envelope is cleared                                          |
| Permanent rejection or ambiguous outcome           | `Quarantined`; no automatic resend                                              |
| Process stopped during the last attempt            | `Quarantined` as `TeamApplicationDeliveryLeaseExpired`, without a provider call |
| Undecodable envelope                               | `Quarantined` without a provider call                                           |
| Application deleted                                | `Cancelled`; the envelope is cleared, also during an attempt                    |
| Interruption, such as shutdown                     | The attempt is released uncounted                                               |
| Database failure                                   | Stop the native process with a nonzero exit                                     |

The worker removes queue items that completed more than 30 days ago once an hour.
The outbox rows keep every outcome, so a command replay after the cleanup delivers nothing again.
Migration 0078 moved the claim outbox's rows onto the queue with their ids, statuses, and attempt counts; migration 0079 dropped its claim columns.

## Provider limits

The HTTP adapter treats a successful HTTP status as provider acknowledgment, not proof of mailbox delivery.
Both adapters send a stable `idempotency-key`. The provider must deduplicate it.
A lost acknowledgment or interrupted process can leave an uncertain external outcome.
This implementation does not guarantee exactly-once delivery.

Reset timeout and stale-claim quarantine deliberately differ from receipt retries.
The current mail adapter classifies HTTP 4xx as permanent rejection, timeout as ambiguous, and other transport failures as temporary.
Do not infer that a temporary network failure proves the provider received nothing.
No local loopback proof establishes a real provider's deduplication, inbox delivery, or operational availability.
Receipt notifications do not perform a payment.

## Local proof

Run the committed proof with the pinned Bun and Node versions on `PATH`:

```sh
bun --no-env-file tools/verification/unattended-delivery-recovery.ts
```

The proof creates its own PostgreSQL cluster, loopback provider, private files, and actual Bun backend processes.
Fixtures create prerequisites only. HTTP requests create reset and receipt outcomes.
The primary scenario performs no SQL outcome writes or operator drains between failure and successful restart.
Separate fault scenarios suspend a real owner or rename a private table to test stale ownership and root failure.

The runner requires a clean committed tree and compares source identity after the run.
It retains sanitized evidence outside the repository, including status, checks, process IDs, ports, and cleanup results.
It removes private database and file resources and verifies that its listener ports are available again.
See [STATE.md](../STATE.md) for the current acceptance scope.
