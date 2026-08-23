# Design spec 0041 - public applicant effect lifecycle

> **Summary:** A public applicant submits one application. The backend commits the application and ordered effect requests in one transaction. One supervised worker delivers each request through explicit provider ports. A failed or interrupted delivery stays available for a later retry.

## Metadata

| Field                    | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Goal                     | Complete the public applicant lifecycle before the identity cutover                   |
| Status                   | Frozen revision 0041.2 after committed-artifact review                                |
| Depends on               | Design spec 0039, design spec 0040, commit `c2e354cbcfba1d5ee3082a139f36750e9754f488` |
| Actor                    | Public applicant and backend process owner                                            |
| Remote provider evidence | Hold until the operator authorizes credentials and remote execution                   |

Revision 0041.2 adds immutable per-application activation authority, command/audit linkage, structural effect ordering, fail-safe quarantine, redirect denial, and upgrade ordering after review of commits `f52bd2383c792b105d1dec633aaaaa90054f3c7a` through `a090f6e`. It does not change the user journey.

Commits before the final approved revision are local review artifacts, not deployable migration checkpoints. No authorized external database may record the earlier four-line form of migration 6 from `913a855`; that form destroyed information needed by the application snapshot. The first deployable schema must apply the final migration 6 before migration 7. An external database reporting the superseded migration source is unsupported and must stop for explicit disposition because the deleted token cannot be reconstructed honestly.

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
- Each application snapshots the activation digest that authorizes its notification request. A later admission-period submission cannot invalidate an older pending request.
- A pending notification request can contain the token until successful delivery.
- Successful delivery removes the private request payload from the outbox row.
- Provider ports accept one request and one idempotency key.
- The worker belongs to the backend process scope.
- Shutdown interrupts the worker before the database runtime closes.
- The local implementation does not claim delivery by Gmail, SMTP, Slack, or another remote provider.
- No request handler creates a database pool, runtime, or worker.
- A non-loopback provider endpoint uses HTTPS and contains no URL credentials. Provider calls do not follow redirects.
- Every provider request has a bounded timeout and observes worker interruption.
- Pre-0041 or corrupted pending payloads that cannot prove their application transaction, effect order, or private activation authority are quarantined visibly with the payload cleared. They are not retried or reported as delivered.

## Values

1. Preserve the accepted application when a provider is unavailable.
2. Make duplicate provider effects unrepresentable through one stable `effectId`.
3. Keep a traceable edge from the application transaction to every provider request.
4. Make command receipt, audit, application, applicant, outbox identity, and ordinal-to-effect-kind edges explicit and consistent.
5. Keep private activation data out of responses and evidence.
6. Stop with visible pending work instead of reporting false delivery.

## Required behavior

### Activation token

- The server creates at least 256 bits of random token data.
- The applicant row stores the current SHA-256 activation digest.
- Each application row stores the immutable SHA-256 digest for its own activation notification, or null for a confirmation.
- The notification request contains the raw token only for an inactive applicant.
- A later identity capability consumes the token. This spec does not add login or session behavior.

### Durable outbox

- `Pending` and `Failed` rows are claimable.
- A claim changes one row to `Processing` and increments `attempts`.
- Payload decode, command/audit linkage, ordinal-to-effect-kind ordering, and immutable application-authority validation occur inside the claim transaction. Invalid rows become `Quarantined`, keep a visible failure tag, clear their private payload, and do not stop the global worker.
- A successful provider call changes the row to `Delivered`.
- Successful completion clears `claim_id`, `claimed_at`, `last_failure_tag`, and the private payload.
- Every `Delivered` row has an empty payload, including rows upgraded from earlier schema revisions.
- A typed provider failure changes the row to `Failed`.
- Failure clears `claim_id` and `claimed_at` and stores the failure tag.
- Startup returns stale `Processing` rows to `Pending`.
- Worker interruption returns its current claim to `Pending`.
- Retry ordering gives untouched commands a turn before another attempt of an older failed command.
- The worker sleeps after a failed attempt.
- `Quarantined` rows are not claimable, keep a visible failure tag, and cannot block unrelated commands.

### Provider ports

The worker uses these ports:

| Port                   | Input                                                        | Required effect                             |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| Applicant notification | Email, application ID, optional activation token, `effectId` | Send one activation or confirmation message |
| Admission subscription | Email, department ID, applicant ID, `effectId`               | Create one department subscription          |
| Application audit      | Application ID, applicant ID, action, `effectId`             | Append one audit delivery record            |

Each port must treat a repeated `effectId` as the same request.
The HTTP provider adapter sends `effectId` as the idempotency key, rejects redirects, and applies one bounded timeout. Recording evidence must distinguish a repeated delivery attempt from a provider-side apply.

### Process lifecycle

- The process requires an explicit application-effect mode.
- `http` mode creates one worker after database readiness succeeds and requires the provider endpoint and token.
- `disabled` mode is limited to explicit local/evidence compositions that provide a separate recording driver; it starts no provider worker and reports that state.
- Missing or contradictory mode/provider configuration fails before the listener starts.
- A configured worker uses one bounded poll interval and one unique claim prefix.
- The process interrupts and joins a configured worker before runtime disposal.
- The worker never creates another database Layer.

## Definition of done

1. A local database test submits an application and observes three ordered requests.
2. The test proves that the outbox contains a raw token, the applicant row contains its current digest, and each application contains its immutable digest snapshot.
3. The test proves an older pending activation remains deliverable after a later-period submission changes the applicant's current digest.
4. The test injects one provider failure and observes `Failed` with no claim.
5. The next delivery succeeds once with the same `effectId`.
6. A stale `Processing` claim returns to `Pending` on worker startup.
7. Worker interruption leaves no row in `Processing` for that worker.
8. Successful delivery clears the private outbox payload.
9. An upgrade test quarantines an incompatible pre-0041 command and clears its private payload.
10. Invalid persisted payloads and broken transaction links become `Quarantined` without stopping the worker.
11. PostgreSQL rejects an ordinal-to-effect-kind mismatch.
12. A permanently failing older command does not block the next command.
13. Provider timeout and interruption abort the underlying HTTP request; redirects are rejected.
14. A process test observes one worker start and one worker stop.
15. The existing public applicant browser journey still passes in authorized remote CI.
16. Root type checks, lint, build, and tests pass on the committed revision.
17. Configuration tests reject an implicit effect mode and contradictory disabled/provider values.

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
- A receipt, audit, application, applicant, or outbox row points at a different transaction identity.
- An ordinal carries the wrong effect kind.
- A later-period activation digest strands an older pending request.
- An invalid row terminates the global worker or retains its private payload.
- A failed command monopolizes the global queue.
- A provider request can redirect to another URL or reach a non-loopback endpoint over cleartext HTTP.
- An interrupted or timed-out provider request continues in the background.

## Non-goals

- Login, session creation, role assignment, and profile access.
- Production data import.
- Remote provider deployment or credential mutation.
- Admission staff review, interview scheduling, or final decisions.
