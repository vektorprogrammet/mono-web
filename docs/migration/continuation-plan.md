# Migration continuation plan

Accepted by the operator on 2026-09-06. Baseline: `ddd7c91ff5e913eac4cf70a7ce68eb8bea9c899f`.

Functional parity and production replacement are separate milestones. Completion means agreed operational journeys, not endpoint counts. Preserve intended legacy behavior and explicitly record corrections or retirements. Current runtime evidence is in the workspace report `docs/assistant-operations-2026-09-06.md`; the dated [journey inventory](2026-09-05-journey-inventory.md) is historical evidence, superseded for substitute pool and contact by their completed specs.

| Sequence | Outcome                             | Acceptance boundary                                                                                                                                              |
| -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Authoritative parity checklist      | Enumerate roles, department scope, history, files, effects and exports; preserve unresolved dispositions. Diagnose `UNSAFE_SOURCE` without weakening guards.     |
| 2        | Existing-volunteer manual placement | Explicit Organization affiliation, scoped coordinator creation/edit/removal, semester and school history.                                                        |
| 3        | Applicant-to-assistant lifecycle    | Application, interview, decision, explicit Person/account linking, activation, recovery and placement. Email equality alone cannot establish identity.           |
| 4        | Complete finance operations         | Actual acknowledged notification transport, reconciled real records/files/identity/payment authority, explicit rejected-claim reopening disposition.             |
| 5        | Remaining operational journeys      | Events, surveys, certificates, statistics and exports, ordered by semester needs; validate supporting administration and public journeys.                        |
| 6        | Production rehearsal and cutover    | Authorized real-data reconciliation, separately restored account access, legacy writer fence, final delta, native ownership, rollback accounting for new writes. |

Current implementation and next work are recorded in [STATE.md](../../STATE.md).
Existing volunteers preceded applicant onboarding. Automatic scheduling awaits
verified source behavior or an explicit replacement contract.

Source correction, 2026-09-06: legacy assistant admission is derived from school
history, not a persisted Accept/Reject/Waitlist decision. Its explicit interviewer
recommendation is a distinct Ja/Kanskje/Nei field missing from native conduct.
[0101](../../design-specs/0101-native-interviewer-recommendation.md) restores that
field first. A separate coordinator admission-decision workflow would be new
product policy. Legacy recommendation reporting, authorized edits to completed
interviews, co-interviewer privileges, applicant progress and completion receipts
remain separate parity items; 0101 does not establish all of them.

Reporting population, 2026-09-07: the legacy interviewed-applicant query selects
one admission period and excludes applications with `previousParticipation`.
Native applications currently have no equivalent stored flag. Legacy sets it
through the authenticated returning-assistant workflow, not a public yes/no
answer. Establish the creation-provenance mapping before claiming the same
reporting population; do not add a self-report checkbox or infer application
origin from an account link. Native public-submission audit proves submission
origin, not absence of assistant history. [0103](../../design-specs/0103-coordinator-interview-report.md)
therefore reports all completed native interviews in an explicit period, clearly
labelled without a first-time-only equivalence claim. Returning-assistant
registration/classification remains a distinct journey. Historical classification
requires traceable evidence; no new checkbox or flag backfill is introduced.
The report must preserve current department authority and exclude proven self
assessments before deriving either rows or totals. Separate recommendation counts
exist in an unused legacy partial; the live table establishes total rows and
sortable recommendations/scores, not currently rendered per-choice counts.

Returning registration, 2026-09-12: [0104](../../design-specs/0104-returning-assistant-registration.md)
delivers the authenticated native returning-assistant journey. It resolves the
canonical person and admission period, enforces current eligibility and scope,
and commits one idempotent registration identity. Repeated registration returns
the existing result; a conflicting command returns `412`, while a successful
registration returns `201`. Immutable original-receipt provenance, audit and
retained digest custody, later-period finalization, and acknowledged notification,
subscription and audit effects were observed in the real dashboard/API/PostgreSQL
journey. See the [acceptance manifest](../../evidence/functional-parity/0104/acceptance-manifest.json)
and [sealed evidence](../../evidence/functional-parity/0104/SHA256SUMS).
This closes the native registration implementation gap. Historical first-time
classification and exact legacy reporting population remain separate because
public-submission provenance does not prove absence of prior service.

Completed-interview corrections, 2026-09-12: [0105](../../design-specs/0105-authorized-completed-interview-corrections.md) delivers a bounded correction journey for the current active assigned interviewer at final runtime revision `4b17590d1ba605f1153588b375bebd6ff93b5427`. It keeps the completed interview and original conduct immutable, appends linear replacement assessments, and requires fresh authority and applicant custody before detail, history, correction, or exact replay. The Foldkit detail shows original completion time/finalizer and ordered read-only Original/Correction history, including historical `NULL` recommendation display. Domain, database, SDK and strict changed-harness checks passed; the integrated browser/API/PostgreSQL evidence and checksums are recorded in the [acceptance manifest](../../evidence/functional-parity/0105/acceptance-manifest.json). This does not reopen interviews, grant coordinator or co-interviewer access, change application or identity data, or send notifications.

Applicant progress, 2026-09-20: [0107](../../design-specs/0107-authenticated-applicant-progress.md) delivers the authenticated current-semester progress journey. It derives seven states from canonical source facts. It does not store a second status value. The generated SDK and dashboard return every linked current application. They do not return assessment, contact or capability data. The exact browser, API and PostgreSQL result is in the [acceptance manifest](../../evidence/functional-parity/0107/acceptance-manifest.json).

Interview completion receipt, 2026-09-20: [0108](../../design-specs/0108-interview-completion-receipt.md) delivers one receipt for the first native interview completion at runtime revision `64d49ec36373b9004890f68ff39faad9e76b1f14`. The finalize transaction creates the durable effect. The worker freezes the recipient envelope before its first request. It uses the effect identity as the transport idempotency key. A failed request stays retryable. Invalid source data enters quarantine without a network request. The receipt contains no interview answers, scores, recommendation or admission outcome. The [acceptance manifest](../../evidence/functional-parity/0108/acceptance-manifest.json) records the browser, API, PostgreSQL, applicant privacy and delivery proof. Production transport and cutover still require operator authority.

Scoped receipt-file review, 2026-09-20: [0109](../../design-specs/0109-scoped-approver-receipt-file-review.md) completes the current approver's private-file journey at runtime revision `67648d8a8877927b93f93a80b80f0b2fc207ef15`. Current department-scoped and global approvers open exact native receipt bytes through same-origin dashboard navigation. Owners retain their separate owner-file route but do not gain approval access. Missing or invalid sessions, foreign departments, inactive affiliation, absent grants, absent receipts and unavailable object storage remain distinct closed boundaries. The rehearsal also proved the existing refund/reject contract under exact replay, conflicting replay, stale writes and synchronized concurrent decisions; twenty ordered outbox effects reached `Delivered`, including eight acknowledged synthetic notification envelopes. See the [acceptance manifest](../../evidence/functional-parity/0109/acceptance-manifest.json).

Finance source correction: legacy administrators can return rejected claims to
Pending so owners can edit the same claim. [0102](../../design-specs/0102-reopen-rejected-receipt.md)
restores that correction journey under the existing native scoped approval
authority, amending the previous terminal-rejection contract. It adds no owner
self-reopening or notification and does not reopen refunded/withdrawn claims.

Each felt journey gets one frozen design-spec, isolated writer worktree and independently checked committed artifact. Use native agents. Serialize heavyweight execution across lanes. Reuse existing domain authorities, schemas, generated SDK, PostgreSQL and dashboard patterns. No stack replacement.

Required gates: real browser/API/persistence journey and reload; negative authority and concurrency/retry paths; historical/file reconciliation where applicable; observed external effects or explicit historical suppression; exact source revision and cleanup evidence. Unit/static checks are distinct evidence. Reports must expose skipped or unavailable boundaries.

Local implementation and synthetic loopback rehearsals are authorized. Production data access, remote PR/push, deployment, credentials/provider changes and production cutover require separate authority. No normal dual-write phase.
