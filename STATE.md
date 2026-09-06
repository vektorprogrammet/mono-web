# State

Lifecycle: build

Now:
- Native migration continues from the completed local consolidation at `694cc34f`.
- Implemented and observed with synthetic local resources: [0094 — substitute pool](design-specs/0094-native-substitute-pool.md), including the real dashboard/API/PostgreSQL journey.
- Implemented and observed: [0095 — synthetic receipt import rehearsal](design-specs/0095-synthetic-receipt-import-rehearsal.md), including private owner-file reads, replay, quarantine and nonempty backup/restore.
- Runtime behavior and generated API contracts are authoritative; historical migration prose in the agent instructions is background, not current completion evidence.

Next:
- Keep exact-commit runtime evidence separate from implementation and production cutover claims.
- Resolve volunteer affiliation and applicant/account identity before freezing the manual placement contract.
- Rehearse receipt, private-file and identity reconciliation before any production cutover.

Blocked:
- No blocker to the substitute-pool contract.
- Full placement/account scope awaits the existing-volunteer versus applicant-onboarding decision. Team membership must not stand in for volunteer affiliation.
- Production changes require a separately authorized cutover; this phase uses synthetic local data only.
