# Organization appointments and native access lifecycle

Status: implementation exists in source. End-to-end acceptance remains open. Production actions remain unauthorized.

Resume verification against this contract before adding implementation.
[STATE.md](../../STATE.md#next) records the remaining acceptance gate.

## Goal

An authorized operator can appoint a person, change or end a responsibility, and verify the resulting access through the native dashboard.
The system retains the appointment history. Account offboarding is a separate, explicit operation.

## Boundaries

- Person, Account, appointment, volunteer affiliation, and school placement remain separate facts.
- Reuse existing organization and identity services, transactional authority, generated HTTP/SDK contracts, and Foldkit dashboard patterns.
- Local team appointments and national-board appointments use one management journey. National scope is explicit, not a fake local department.
- A national-board position or chair title never creates a global-administrator grant.
- Ending one appointment does not end another appointment, disable the account, or change volunteer affiliations or placements.
- Account disabling blocks native human access. It does not claim to suspend Google Workspace, external mailboxes, or independently authorized service principals.
- No live data import, external notification, provider call, deployment, or production account change belongs to this slice.

## Observable contract

1. An operator can select an existing Person and organizational unit, record a position, leadership responsibility where applicable, and an effective interval.
2. The dashboard shows current, future, ended, and suspended appointments with their scope and current revision. It provides the Person and unit choices through authorized native reads.
3. An authorized operator can change an appointment, end it, suspend it, or reinstate it. Person and target identity remain immutable. Changes retain attributable history.
4. Active local leadership permits appointment management only within its authorized local scope. An explicit global administrator can manage national appointments and native account access. A member, expired leader, or wrong-scope leader cannot escalate authority.
5. Leadership handover can appoint the successor before ending the predecessor. Current authority is read at each protected interaction, including old sessions. Ending the last appointment in one scope revokes that scope, not unrelated authority.
6. A global administrator can explicitly disable or re-enable an existing native account with an expected revision and reason. Disabled accounts cannot sign in, regain access through recovery, resolve a usable cookie session, or use human OAuth credentials. Re-enabling does not restore revoked sessions or tokens.
7. Self-offboarding and disabling the last active global administrator fail without changes. Administrative races cannot bypass this guard. Account disabling does not delete identity, credentials, appointment history, claims, or service history.
8. Every mutation requires a stable command identity and expected revision where a record exists. Exact replay cannot duplicate history. A changed command under the same identity, stale revision, invalid interval, or denied actor leaves no partial change.
9. Authority checks, state transitions, revision updates, command receipts, and audit/history commit atomically. Authority writers use the existing person-authorization locking convention in a consistent order.
10. Human-facing controls expose pending, successful, denied, and stale states. Accessible labels and keyboard interaction work on desktop and narrow viewports. The frontend uses generated SDK operations, not database access or handwritten transport.

## Acceptance

- Exercise the actual dashboard, mounted API, and disposable PostgreSQL with synthetic people. Observe appointment creation, leadership change, scope revocation, suspension/reinstatement, and retained history.
- Exercise a national-board appointment and prove that it grants no global administration.
- Use the same pre-existing actor session before and after handover; prove the next protected request uses current authority.
- Disable an account, prove old-session and new-sign-in denial, and prove recovery cannot restore usable access. Check human OAuth denial through its real credential boundary.
- Re-enable the account; prove fresh authentication works while old sessions remain invalid.
- Exercise wrong-scope and ordinary-member denial, stale updates, exact and changed-payload replay, concurrent competing changes, self-offboarding, and last-administrator preservation.
- Prove unrelated appointments, affiliations, placements, and retained history survive the scoped end operation.
- Run relevant existing checks and add only durable regressions for plausible boundary failures.
- Observe the local UI independently before acceptance. Record limits without claiming production or provider evidence.

## Completion

Update the intended system and current state after verification. Remove this completed specification and disposable proof machinery. Preserve existing user work.
