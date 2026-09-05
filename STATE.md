# State

Lifecycle: build

Now:
- Native migration continues from the completed local consolidation at `694cc34f`.
- Active implementation contract: [0094 — substitute pool](design-specs/0094-native-substitute-pool.md).
- Active implementation contract: [0095 — synthetic receipt import rehearsal](design-specs/0095-synthetic-receipt-import-rehearsal.md), including the explicitly amended private owner-file read boundary.
- Runtime behavior and generated API contracts are authoritative; historical migration prose in the agent instructions is background, not current completion evidence.

Next:
- Verify the complete substitute journey on a clean committed artifact before integration.
- Verify receipt import, fresh reconciliation, private owner reads, replay, failure recovery and actual snapshot restore against disposable PostgreSQL and filesystem resources.
- Resolve volunteer affiliation and applicant/account identity before freezing the manual placement contract.
- Rehearse receipt, private-file and identity reconciliation before any production cutover.

Blocked:
- No blocker to the substitute-pool contract.
- Full placement/account scope awaits the existing-volunteer versus applicant-onboarding decision. Team membership must not stand in for volunteer affiliation.
- Production changes require a separately authorized cutover; this phase uses synthetic local data only.
