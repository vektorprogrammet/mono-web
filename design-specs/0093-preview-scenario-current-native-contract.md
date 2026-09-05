# 0093 — Restore the existing preview scenario against the native contract

Status: frozen after coordinating lead scope review, 2026-09-05.

Depends on [0092](0092-preview-contact-data.md). Restores the existing journeys
specified by [0072](0072-preview-scenario-seed.md) and its guarded application in
[0076](0076-live-preview-scenario.md). This is scenario maintenance, not a new
product capability or authorization to change shared preview data.

## Problem and goal

Real disposable execution of 0072 at `001d6864` applied schema migration 29, then
failed because the runner still requires migration 23. Source inspection finds
obsolete v0.1 route names, command payloads, response shapes, and receipt identity
assumptions across the scenario. The component checks in 0092 cannot establish
that the complete scenario works.

A developer can run the existing complete synthetic scenario against a fresh,
owned PostgreSQL database using the current native backend, then replay it with
stable business state and verifiable command outcomes. The resulting organization
data has unique public contact slugs. The existing live wrapper retains its exact
operator acknowledgment, backup, target, provider-disabled and compatibility gates.

## Scope and source dependencies

| Existing step                  | Required repair and authoritative source                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema readiness               | Derive expected migration identity from `packages/database/src/migrations.ts` definitions; share derivation with the live wrapper instead of copying a version string.                    |
| Department/team administration | Use current generated SDK operation, request schemas, idempotency headers and returned resource identities. Bind the team to the returned synthetic department identity.                  |
| Admission period/application   | Use current SDK schemas and idempotency semantics; retain imported department `1`, open period, and the existing synthetic applicant.                                                     |
| Interview assignment           | Use current assignment projection and application-specific interview creation. Read current representations instead of v0.1 observation envelopes.                                        |
| Receipt submission             | Use current multipart contract and returned receipt identity; preserve real local file staging/commit and pending receipt checks.                                                         |
| Article draft/publication      | Use current content operations, ETag preconditions and idempotency semantics; retain one published version.                                                                               |
| Replay evidence                | Replace assumptions that caller keys equal domain receipt IDs with current HTTP mutation identity or returned-resource evidence. Preserve exact counts and state comparisons in 0076.     |
| Authentication and custody     | Verify the existing sign-in/session topology against the actual backend; retain target restrictions, disabled delivery, backup gates, process cleanup and 0092 incompatibility rejection. |

The HTTP contract and generated SDK remain authoritative for routes, fields,
headers, responses and errors. Database migration definitions remain authoritative
for schema expectations. Reuse existing fixture definitions and generator entrypoints.
No generic seed/reconciliation framework and no new volunteer journey are included.

## Ownership and constraints

Implementation owns the existing `infra/host` scenario scripts, directly related
tests, component verification adaptations needed by shared fixture changes, and this
spec. Product SDK/domain/HTTP behavior is not silently changed to accommodate the
runner. A discovered product defect is reported with its reproducer before scope
is revised. Existing migration documents are referenced, not rewritten wholesale.

Keep the six-person/five-membership cohort, imported authority identity, distinct
synthetic department, application, assigned interview, pending receipt and published
article. Stable caller idempotency keys must not be reused for changed payloads.
Replay must not rely on guessing server-derived identifiers. Failures and unsupported
prerequisites stay visible; do not mark skipped operations successful.

No live database access or mutation, deployment, credentials, provider requests,
remote git mutation or shared fixture cleanup is authorized by this contract.
Heavy PostgreSQL/backend execution requires the coordinating lead's available slot.

## Acceptance and falsifiers

1. A clean committed revision completes the existing full scenario against real
   freshly migrated disposable PostgreSQL and the real native HTTP backend.
2. Observe the intended organization/authority, admission, assignment, receipt-file
   and publication results and unique active contact slugs through real boundaries.
3. A second invocation replays successfully with stable relevant rows and durable
   receipt files. Assert actual idempotency outcomes, not merely HTTP success.
4. The live-wrapper rehearsal succeeds twice under its existing backup/target/no-
   delivery checks. Incompatible previous scenario data still fails before writes.
5. Relevant existing and revised tests, formatter and linter pass. Record exact
   revision, commands, runtime ownership, cleanup and unavailable evidence.

The contract is false if a component-only check is called whole-scenario success,
if synthetic data papers over an invalid public-data response, if changed commands
reuse immutable identities, if replay adds duplicate business data or loses files,
or if authentication/provider/target safeguards are weakened to make the runner pass.
