# Reviewed organization reconciliation

Status: frozen for local implementation and rehearsal. Production access and cutover remain unauthorized.

## Goal

An operator reconciles legacy teams, national boards, and appointments through Organization's supported import boundary.
Every imported appointment references accepted Person evidence. Historical appointments never imply current authority.
The existing cutover imports Organization in the same transaction as references, People, service, and Accounts.

## Source and review contract

- Reuse the existing SELECT-only reader, transport checks, InnoDB checks, and consistent read-only transaction.
- Organization selection is explicit. Include five additional tables only when requested: team, position, team_membership, executive_board, executive_board_membership.
- Retain the original six-table source shape when Organization is not requested. Existing historical rehearsals remain explicit and valid.
- Read legacy main's actual column names. Membership foreign keys can be null; preserve invalid rows for disposition rather than dropping them.
- Source revisions bind all selected noncredential data. Password hashes remain outside that revision.
- A private review binds the source revision, source watermark, authorization instant, reviewer, and evidence reference.
- Every team and board membership occurrence needs exactly one review entry bound to its source kind, source ID, and raw-row digest.
- Each entry explicitly excludes the occurrence or supplies a reviewed interval, temporal classification, and evidence reference.
- Historical intervals end at or before the review instant. Current intervals contain it. Future intervals start after it.
- Missing, duplicate, unknown, changed, or temporally inconsistent review entries reject the review before target writes.
- Never derive exact dates, timezone, active status, leadership, or global grants from semester labels or the process clock.
- Reviewed current or future team appointments preserve the source leadership and suspension facts. Contradictory or invalid flags cannot grant authority.
- Board membership and position titles never confer local leadership or global-administrator authority.
- Global-administrator grants, Account enablement, and external service grants are not inferred or created by this import.

## Identity and ownership contract

- Organization owns classification, canonical writes, conflicts, and append-only provenance. The CLI owns selection and source projection, not business SQL.
- Reuse Organization's existing import classification and appointment invariants. Make identity resolution explicit before duplicate classification; do not rewrite completed rows afterward.
- Migrate affected callers when the shared import contract changes. No implicit numeric source-user-to-Person fallback remains in the shared classifier.
- Resolve each source user through the accepted mapping for the exact Person snapshot, repository, source user, and target Person.
- Native Person existence, matching email, or an occurrence label alone is insufficient evidence.
- Reuse accepted department/reference provenance. Do not create parallel numeric departments beside the cutover's canonical departments.
- Preserve team and board identity, titles, suspension, reviewed intervals, and named deleted-team history where the native model supports them.
- Missing Person mappings, invalid rows, unresolved units or positions, duplicate targets, and unowned canonical collisions have explicit dispositions.
- A rejected row cannot create partial membership or authority. Unrelated valid rows can still import.
- Import creates neither human lifecycle audit events nor notification work. Its review and source evidence remain distinct from operational history.

## Persistence and replay contract

- Follow the existing cohort transaction pattern. A caller-owned transaction includes all cutover facts; standalone import owns its transaction.
- Use existing authority lock ordering for affected People. Concurrent first imports converge on one result.
- Snapshot identity and accepted source mappings are immutable. Changed source, review, mapping, or transformation under an existing identity is refused.
- Exact replay returns the original dispositions without restoring ended or suspended appointments, changing native edits, or creating duplicate records.
- Evidence tables reject update, delete, and truncate. Invalid input and transaction failures leave no partial facts.
- A requested cohort with no accepted appointments cannot report successful operational reconciliation.
- The CLI requires `--organization=none|PATH`; omission, duplicate options, public review files, and symlinks are refused.

## Acceptance

1. Exercise the actual reader and operator CLI against disposable MariaDB and PostgreSQL with faithful synthetic table shapes.
2. Import team and board appointments using accepted nonnumeric Person identities and the existing department mappings.
3. Cover current leaders, ordinary members, suspended members, future and ended appointments, named deleted-team history, and board members.
4. Read native authority through the existing resolver. Current eligible leaders receive only their department scope; other cases do not gain leadership or global authority.
5. Prove exact Person binding, including cross-snapshot occurrence collision refusal and valid accepted replay evidence.
6. Prove review completeness, raw digest binding, interval validation, unresolved references, source conflicts, and unowned target collisions.
7. Prove first import, exact replay after native edits, concurrent import, concurrent replay, and whole-cutover rollback after a later failure.
8. Prove append-only evidence and absence of fabricated lifecycle history, global grants, and notification work.
9. Exercise explicit Organization omission and the existing current-assignment/Person paths. Update affected fixtures and contract checks.
10. Retain sanitized source-bound evidence and remove owned runtime resources. Rehearsal data must never be reported as live operational reconciliation.

## Established mechanisms

Reuse the legacy reader, private cohort-file checks, Person accepted-mapping ledger, department reference provenance, Organization schemas and authority resolver, and disposable database tooling.
Use the existing cohort transaction pattern rather than a new migration framework or a fabricated Effect SQL-client adapter.
