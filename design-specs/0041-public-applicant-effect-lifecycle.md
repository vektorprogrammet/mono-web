# Design spec 0041 - public applicant effect lifecycle

> **Summary:** A public applicant submits one application. The backend commits the application and ordered effect requests in one transaction. One supervised worker delivers each request through explicit provider ports. A failed or interrupted delivery stays available for a later retry.

## Metadata

| Field                    | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Goal                     | Complete the public applicant lifecycle before the identity cutover                   |
| Status                   | Frozen revision 0041.1 after committed-artifact review                                |
| Depends on               | Design spec 0039, design spec 0040, commit `c2e354cbcfba1d5ee3082a139f36750e9754f488` |
| Actor                    | Public applicant and backend process owner                                            |
| Remote provider evidence | Hold until the operator authorizes credentials and remote execution                   |

Revision 0041.1 adds the upgrade, transport-security, cancellation, timeout, and queue-fairness conditions discovered by review of commit `f52bd2383c792b105d1dec633aaaaa90054f3c7a`. It does not change the user journey.

## User journey

1. A public applicant opens the application form during one open admission period.
2. The applicant submits one valid application.
3. The backend commits the applicant, application, receipt, audit row, and three ordered effect requests atomically.
4. The response shows one opaque application ID and no private applicant data.
5. The backend worker delivers the notification, subscription, and audit requests in order.
6. A new applicant notification contains one server-generated activation token.
7. An existing active applicant notification contains no activation token.
8. A provider uses `effectId` as the idempotency key.
9. If delivery fails, the request enters `Failed` with no live claim.
10. The worker retries the failed request without a duplicate provider effect.
11. If the process stops during delivery, the claim returns to the queue.

## Goal

Complete the post-commit part of the public application journey. Keep identity activation and login in the later identity cutover.

## Constraints

- The application transaction remains the only authority for the application and its effect requests.
- The HTTP response does not wait for a provider.
- The server generates the activation token. The public request cannot select this token.
- The applicant table stores only the activation digest.
- A pending notification request can contain the token until successful delivery.
- Successful delivery removes the private request payload from the outbox row.
- Provider ports accept one request and one idempotency key.
- The worker belongs to the backend process scope.
- Shutdown interrupts the worker before the database runtime closes.
- The local implementation does not claim delivery by Gmail, SMTP, Slack, or another remote provider.
- No request handler creates a database pool, runtime, or worker.
- A non-loopback provider endpoint uses HTTPS and contains no URL credentials.
- Every provider request has a bounded timeout and observes worker interruption.
- Pre-0041 pending payloads that cannot supply a raw activation token are quarantined visibly. They are not retried or reported as delivered.

## Values

1. Preserve the accepted application when a provider is unavailable.
2. Make duplicate provider effects unrepresentable through one stable `effectId`.
3. Keep a traceable edge from the application transaction to every provider request.
4. Keep private activation data out of responses and evidence.
5. Stop with visible pending work instead of reporting false delivery.

## Required behavior

### Activation token

- The server creates at least 256 bits of random token data.
- The applicant row stores the SHA-256 digest of the token.
- The notification request contains the raw token only for an inactive applicant.
- A later identity capability consumes the token. This spec does not add login or session behavior.

### Durable outbox

- `Pending` and `Failed` rows are claimable.
- A claim changes one row to `Processing` and increments `attempts`.
- Payload decode and identity validation occur inside the claim transaction. Invalid payloads roll the claim back.
- A successful provider call changes the row to `Delivered`.
- Successful completion clears `claim_id`, `claimed_at`, `last_failure_tag`, and the private payload.
- A typed provider failure changes the row to `Failed`.
- Failure clears `claim_id` and `claimed_at` and stores the failure tag.
- Startup returns stale `Processing` rows to `Pending`.
- Worker interruption returns its current claim to `Pending`.
- Retry ordering gives untouched commands a turn before another attempt of an older failed command.
- The worker sleeps after a failed attempt.
- `Quarantined` rows are not claimable and keep a visible failure tag.

### Provider ports

The worker uses these ports:

| Port                   | Input                                                        | Required effect                             |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| Applicant notification | Email, application ID, optional activation token, `effectId` | Send one activation or confirmation message |
| Admission subscription | Email, department ID, applicant ID, `effectId`               | Create one department subscription          |
| Application audit      | Application ID, applicant ID, action, `effectId`             | Append one audit delivery record            |

Each port must treat a repeated `effectId` as the same request.
The HTTP provider adapter sends `effectId` as the idempotency key. Recording evidence must distinguish a repeated delivery attempt from a provider-side apply.

### Process lifecycle

- The process creates one worker after database readiness succeeds.
- The worker uses one bounded poll interval.
- The worker owns one unique claim prefix.
- The process interrupts and joins the worker before runtime disposal.
- The worker never creates another database Layer.

## Definition of done

1. A local database test submits an application and observes three ordered requests.
2. The test proves that the outbox contains a raw token and the applicant row contains only its digest.
3. The test injects one provider failure and observes `Failed` with no claim.
4. The next delivery succeeds once with the same `effectId`.
5. A stale `Processing` claim returns to `Pending` on worker startup.
6. Worker interruption leaves no row in `Processing` for that worker.
7. Successful delivery clears the private outbox payload.
8. An upgrade test quarantines an incompatible pre-0041 command and clears its private payload.
9. An invalid persisted payload rolls its claim back without incrementing `attempts`.
10. A permanently failing older command does not block the next command.
11. Provider timeout and interruption abort the underlying HTTP request.
12. A process test observes one worker start and one worker stop.
13. The existing public applicant browser journey still passes in authorized remote CI.
14. Root type checks, lint, build, and tests pass on the committed revision.

## Falsifiers

This contract is false if any condition occurs:

- The application commits without all three effect requests.
- Provider failure leaves a row in `Processing`.
- A successful row retains the activation token.
- A retry uses a different `effectId`.
- A request handler creates a worker or database Layer.
- Runtime disposal starts before the worker stops.
- Local evidence reports a remote provider delivery.
- The public response or evidence contains the activation token, email, phone, or name.
- An invalid or legacy payload leaves a row in `Processing`.
- A failed command monopolizes the global queue.
- A remote endpoint receives a provider token or activation token over cleartext HTTP.
- An interrupted or timed-out provider request continues in the background.

## Non-goals

- Login, session creation, role assignment, and profile access.
- Production data import.
- Remote provider deployment or credential mutation.
- Admission staff review, interview scheduling, or final decisions.
