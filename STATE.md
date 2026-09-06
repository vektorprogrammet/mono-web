# State

Lifecycle: build

Now:

- Native migration continues from the completed local consolidation at `694cc34f`.
- Implemented and observed with synthetic local resources: [0094 — substitute pool](design-specs/0094-native-substitute-pool.md), including the real dashboard/API/PostgreSQL journey.
- Implemented and observed: [0095 — synthetic receipt import rehearsal](design-specs/0095-synthetic-receipt-import-rehearsal.md), including private owner-file reads, replay, quarantine and nonempty backup/restore.
- Implemented and runtime-observed with synthetic local resources: [0096 — existing-volunteer placement](design-specs/0096-existing-volunteer-placement.md), including self-request, scoped establishment, historical placement, edits/removal and preserved audit history.
- Implemented and runtime-observed: [0097 — acknowledged receipt delivery](design-specs/0097-receipt-notification-delivery.md), including immutable first-attempt envelopes, bounded retry, failure/restart and historical-import suppression.
- [0098 — parity diagnostics](design-specs/0098-safe-parity-diagnostics.md) identifies rejected source safely and corrects fetch destination extraction. Generated catalog freshness is not semantic parity.
- Runtime behavior and generated API contracts are authoritative; historical migration prose in the agent instructions is background, not current completion evidence.

- Implemented and observed in synthetic isolated rehearsals: [0054.2 — native recovery](design-specs/0054.2-native-password-recovery.md), [0099 — applicant account onboarding](design-specs/0099-applicant-account-onboarding.md), and [0100 — synthetic password cohort](design-specs/0100-synthetic-password-cohort.md). Exact combined-commit acceptance is recorded separately from lane evidence.

Next:

- Keep exact-commit runtime evidence separate from implementation and production cutover claims.
- Continue the accepted [continuation plan](docs/migration/continuation-plan.md): explicit assistant admission decisions, remaining finance outcomes and semester workflows. The implemented onboarding journey grants no assistant acceptance or automatic affiliation.
- Rehearse receipt, private-file and identity reconciliation before any production cutover.

Blocked:

- No blocker to the substitute-pool contract.
- Real cohort mapping, unsupported credential/alias disposition and production mail/cutover authority remain outstanding. Team membership must not stand in for volunteer affiliation.
- Production changes require a separately authorized cutover; this phase uses synthetic local data only.
