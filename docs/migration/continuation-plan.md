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

Next batch: [0096 placement](../../design-specs/0096-existing-volunteer-placement.md) and [0097 receipt delivery](../../design-specs/0097-receipt-notification-delivery.md). Existing volunteers precede applicant onboarding; this sequencing is now accepted, not blocked on another preference question. Automatic scheduling awaits verified source behavior or an explicit replacement contract.

Each felt journey gets one frozen design-spec, isolated writer worktree and independently checked committed artifact. Use native agents. Serialize heavyweight execution across lanes. Reuse existing domain authorities, schemas, generated SDK, PostgreSQL and dashboard patterns. No stack replacement.

Required gates: real browser/API/persistence journey and reload; negative authority and concurrency/retry paths; historical/file reconciliation where applicable; observed external effects or explicit historical suppression; exact source revision and cleanup evidence. Unit/static checks are distinct evidence. Reports must expose skipped or unavailable boundaries.

Local implementation and synthetic loopback rehearsals are authorized. Production data access, remote PR/push, deployment, credentials/provider changes and production cutover require separate authority. No normal dual-write phase.
