# Scoped mailing recipients

Status: frozen for local implementation and acceptance.
Production, provider actions, and mail delivery remain unauthorized.

## Goal

A currently authorized leader selects a department, semester, and recipient cohort.
The dashboard shows the canonical contact emails for that selection.
This is a read-only recipient projection, not subscription management or a mail sender.

The legacy contract is `MailingListController`: assistants, team members, or their union, selected by department and semester.
The native HTTP handler currently omits assistant source facts and does not resolve the requested semester interval.
Repair the complete existing journey rather than adding ad-hoc mailing-list records.

## Contract

- Current department leadership permits reads only within that department. Current global administration permits all departments.
- The API preserves its three cohorts: `assistants`, `team`, and `all`.
- Resolve an explicit semester against the canonical semester catalogue. Reject unknown references rather than treating them as an empty cohort.
- If the caller omits the semester, resolve the unique current semester from the request clock and canonical intervals.
- A missing or ambiguous current semester is an explicit failure. A read never creates reference data.
- Assistant eligibility comes from accepted historical service and active canonical placements for the selected department and semester.
- Deduplicate the union by Person, then canonical contact email. Application, recommendation, Account, and bare affiliation are not assistant eligibility.
- Team eligibility comes from nonsuspended appointments overlapping the selected semester. Preserve half-open interval semantics at exact boundaries.
- Preserve existing native suspension exclusion. Do not infer a new historical suspension policy from legacy behavior.
- Resolve email through current canonical Profile contacts. Do not use legacy usernames or organization aliases.
- A genuinely missing contact can remain absent from the recipient result, as the existing contract specifies.
- A database or Profile infrastructure failure must fail the read. It must not return a successful empty or partial list.
- Recipient source data and scope remain server-owned. Remove optional caller-supplied assistant maps and semester windows from the effectful service contract.
- Keep one Organization query and existing domain/persistence/HTTP/SDK boundaries. Reuse canonical reference APIs where available.
- The dashboard exposes department, semester, and cohort selection, preserves the selected filters on reload, and distinguishes an empty cohort from failure.
- Preserve existing response shape unless complete caller migration is necessary for the journey. No compatibility aliases or duplicate recipient stores.

## Acceptance

Use synthetic identities, canonical fixtures, and disposable PostgreSQL.
Exercise the mounted native HTTP endpoint and real authenticated dashboard.

1. Reproduce missing assistant recipients and ignored semester filtering before the fix.
2. Show historical-only assistants, active-placement assistants, overlapping team members, and the deduplicated union.
3. Exclude unrelated departments, other semesters, inactive placements, suspended memberships, and appointments touching only a half-open boundary.
4. Reject unknown semester, missing or ambiguous current semester, anonymous access, ordinary membership, and a request outside current leadership scope.
5. Revoke leadership and show that the existing session cannot retain access.
6. Distinguish missing contact from infrastructure failure. A failed contact query cannot yield success with fewer recipients.
7. Show dashboard selection and reload through visible controls at desktop and narrow widths. Check keyboard use and accessibility.
8. Run focused behavior regressions, affected type checks, and generated contract checks. Keep tests for the demonstrated defects and uncertain boundaries only.

No notifications, subscriptions, provider synchronization, credential changes, production reads, or production writes belong to this slice.
No standalone team recruitment, reminder policy, no-show state, service reversal, or generic analytics belongs to this slice.

## Acceptance record

After acceptance, update STATE.md, the system document, and changelog.
Keep source-bound proof outside the repository. Remove disposable resources and this completed specification.
Commit locally. Do not push or deploy.
