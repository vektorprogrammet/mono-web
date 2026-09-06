# Migration continuation plan

Accepted by the operator on 2026-09-06. Baseline: `ddd7c91ff5e913eac4cf70a7ce68eb8bea9c899f`.

Functional parity and production replacement are separate milestones. Completion means agreed operational journeys, not endpoint counts. Preserve intended legacy behavior and explicitly record corrections or retirements. Current runtime evidence is in the workspace report `docs/assistant-operations-2026-09-06.md`; the dated [journey inventory](2026-09-05-journey-inventory.md) is historical evidence, superseded for substitute pool and contact by their completed specs.

| Sequence | Outcome | Acceptance boundary |
| --- | --- | --- |
| 1 | Authoritative parity checklist | Enumerate roles, department scope, history, files, effects and exports; preserve unresolved dispositions. Diagnose `UNSAFE_SOURCE` without weakening guards. |
| 2 | Existing-volunteer manual placement | Explicit Organization affiliation, scoped coordinator creation/edit/removal, semester and school history. |
| 3 | Applicant-to-assistant lifecycle | Application, interview, decision, explicit Person/account linking, activation, recovery and placement. Email equality alone cannot establish identity. |
| 4 | Complete finance operations | Actual acknowledged notification transport, reconciled real records/files/identity/payment authority, explicit rejected-claim reopening disposition. |
| 5 | Remaining operational journeys | Events, surveys, certificates, statistics and exports, ordered by semester needs; validate supporting administration and public journeys. |
| 6 | Production rehearsal and cutover | Authorized real-data reconciliation, separately restored account access, legacy writer fence, final delta, native ownership, rollback accounting for new writes. |

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

Finance source correction: legacy administrators can return rejected claims to
Pending so owners can edit the same claim. [0102](../../design-specs/0102-reopen-rejected-receipt.md)
restores that correction journey under the existing native scoped approval
authority, amending the previous terminal-rejection contract. It adds no owner
self-reopening or notification and does not reopen refunded/withdrawn claims.

Each felt journey gets one frozen design-spec, isolated writer worktree and independently checked committed artifact. Use native agents. Serialize heavyweight execution across lanes. Reuse existing domain authorities, schemas, generated SDK, PostgreSQL and dashboard patterns. No stack replacement.

Required gates: real browser/API/persistence journey and reload; negative authority and concurrency/retry paths; historical/file reconciliation where applicable; observed external effects or explicit historical suppression; exact source revision and cleanup evidence. Unit/static checks are distinct evidence. Reports must expose skipped or unavailable boundaries.

Local implementation and synthetic loopback rehearsals are authorized. Production data access, remote PR/push, deployment, credentials/provider changes and production cutover require separate authority. No normal dual-write phase.
