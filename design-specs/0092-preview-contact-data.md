# 0092 — Preview scenario contact department identity

Status: frozen for implementation, 2026-09-05.

Amends [0072](0072-preview-scenario-seed.md) and its use by
[0076](0076-live-preview-scenario.md). Separate from contact command authority
[0043.1](0043.1-native-contact-authority.md).

## Problem and goal

The captured public departments response contains imported department `1` and a
native command-derived department with identical active short name `Trondheim`.
The public contact loader correctly rejects the duplicate slug with HTTP 503.
The preview scenario imports the former and creates the latter; all three native
IDs in the response match the runner's command-derived IDs. Historical execution
has not been established by this source diagnosis.

A fresh disposable preview scenario must retain imported Trondheim authority and
produce distinct active contact slugs. Its native administration demonstration
uses an explicitly synthetic department name and short name. Public duplicate
slug rejection stays intact.

## Constraints and compatibility

- Keep imported department `1`, memberships, admissions and authority references.
- Give the changed native department command and its dependent team command new
  identifiers: immutable command receipts must never receive changed payloads.
- Before identity seeding, migrations, imports or any scenario database mutation,
  reject a target containing the superseded department or either superseded
  command receipt. Do not repair or delete existing data.
- Both disposable preparation and application (including the live wrapper) use
  this read-only compatibility preflight. Missing tables on an empty database
  are allowed; failed inspection is not treated as an empty database.
- Compatible revised scenarios retain existing replay behavior. The previous
  seeded revision is explicitly incompatible and requires a separate operator
  decision. This change authorizes no live access or mutation.
- Reuse existing fixture generator and tests; no generic reconciliation system.

## Acceptance and falsifiers

1. Fresh disposable PostgreSQL scenario produces unique active contact slugs,
   including imported Trondheim and the explicitly synthetic native department.
2. Changed department/team command IDs differ from the superseded IDs; the team
   references the new native department, while authority still references `1`.
3. A target with a superseded row or receipt fails before seed writes; compatible
   revised replay passes the compatibility gate.
4. Existing affected scenario tests and scoped formatting/lint checks pass.
5. Record real checks and unavailable checks against the committed revision.

Real PostgreSQL/scenario execution requires the lead's heavy-job slot. No live
preview data cleanup, provider calls, deployment or remote git changes are allowed.

## Verification status and encountered dependency

The complete scenario gate is BLOCKED: real disposable PostgreSQL execution at
`001d6864` migrated to `29_native-http-semantics`, but the runner requires
`23_declarative-authorization-rules` and stopped before department creation.
Source inspection also finds obsolete `/api/admin/departments` and
`/api/admin/teams` operations and old command payloads. Restoring the complete
existing scenario requires a separate bounded contract; this amendment does not
claim that the full scenario works.

An additional component check, `infra/host/preview-contact-data-postgres.ts`,
uses the actual migration/Organization layers with the same typed department and
team fixtures as the runner. It requires an explicit fresh disposable database,
checks current command replay and public slug uniqueness, and verifies previous
scenario markers cause rejection before identity seeding. This is component
verification, not a substitute for acceptance gate 1 or a browser journey.
