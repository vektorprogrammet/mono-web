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
- Implemented and observed in isolated synthetic rehearsals: [0101 — interviewer recommendation](design-specs/0101-native-interviewer-recommendation.md), including explicit Ja/Kanskje/Nei, immutable historical absence, current membership and proven self-interview denial before reads/replay. Source review found no separate legacy assistant admission decision; school placement determines that legacy status. Combined-commit acceptance is recorded separately from lane evidence.
- Implemented and observed in an isolated synthetic rehearsal: [0102 — rejected receipt correction](design-specs/0102-reopen-rejected-receipt.md), including scoped reopening, correction of the same claim, subsequent decision and acknowledged local transport. This explicitly amends the prior Rejected-is-terminal rule; Refunded and Withdrawn remain terminal.
- Implemented and observed in an isolated synthetic rehearsal at `58391ed6`: [0103 — coordinator interview report](design-specs/0103-coordinator-interview-report.md): scoped, read-only reporting of completed native interviews for an explicit admission period, with exact recommendations, scores, historical absence and self-privacy. This does not claim legacy's first-time-only population. Independent combined-commit acceptance is recorded separately from this lane observation.
- Implemented and observed in the final local integration at runtime revision `5cb4401610d3799a8fe931471fee265676824b9c`: [0104 — returning-assistant registration](design-specs/0104-returning-assistant-registration.md), including authenticated returning identity, eligibility and authority checks, idempotent 201/412 registration semantics, retry-safe persistence, immutable provenance and audit/outbox custody, later-period finalization and acknowledged effects. The real dashboard/API/PostgreSQL journey and package checks are recorded in [the acceptance manifest](evidence/functional-parity/0104/acceptance-manifest.json); the integrated evidence commit is `239be812`.

Next:

- Returning-assistant registration is implemented and observed for the authenticated native journey. Historical first-time classification and exact legacy population remain separate: public-submission provenance is not proof that an applicant has never served, and no self-report checkbox or inferred account-link classification is allowed.
- Keep exact-commit runtime evidence separate from implementation and production cutover claims.
- Continue the accepted [continuation plan](docs/migration/continuation-plan.md): coordinator recommendation reporting and authorized completed-interview edits, remaining recruitment/finance outcomes and semester workflows. A new coordinator admission-decision workflow remains a separate product choice. The implemented onboarding journey grants no assistant acceptance or automatic affiliation.
- Rehearse receipt, private-file and identity reconciliation before any production cutover.

Blocked:

- No blocker to the substitute-pool contract.
- Real cohort mapping, unsupported credential/alias disposition and production mail/cutover authority remain outstanding. Team membership must not stand in for volunteer affiliation.
- Production changes require a separately authorized cutover; this phase uses synthetic local data only.
