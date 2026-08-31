# Design spec 0072 - representative preview scenario seed

> **Summary:** One idempotent runner composes the existing seed surfaces into a small synthetic
> scenario shaped like the deployed legacy organization, and proves every element exists with the
> expected state on a disposable loopback PostgreSQL.

## Metadata

| Field     | Value                                            |
| --------- | ------------------------------------------------ |
| Stable ID | `0072`                                           |
| Status    | Draft - runner implementation pending            |
| Date      | `2026-08-31`                                     |
| Base HEAD | `0bc4aa3ac5506b6371d25972c9608eee8e35c17d`       |
| Worktree  | `/tmp/mono-web-preview-scenario` (single writer) |
| Branch    | `feat/preview-scenario-seed`                     |

## Goal

The local rehearsal produces one coherent admissions journey: an open period, one application, one
assigned interview, one pending receipt, and one draft plus one published article. It also produces
native Trondheim, Bergen, and Ås display rows with a native Rekruttering team. Membership authority
uses one legacy-imported Trondheim/Rekruttering cohort because the importer maps numeric legacy IDs
to string IDs and cannot target native command-derived hashes. Evidence records this reconciliation
boundary. There are no unrecorded business-table inserts and no production effect.

## Operator steering (legacy-shaped content)

The preview must show content closest to the deployed legacy site. Synthetic values follow the
legacy shapes (source: `evidence/functional-parity/`, legacy fixtures at
`/srv/share/projects/vektorprogrammet/vektorprogrammet`, read-only):

- Departments: Trondheim (`NTNU`), Bergen (`UiB`), Ås (`NMBU`).
- Teams: `Styret`, `IT`, `Rekruttering`, `Skolekoordinering` (legacy team titles); positions
  `Leder` / `Medlem`; `Hovedstyret` is the legacy executive-board name and stays out of the
  `organization_departments` table (it is board data, not a department).
- Schools: legacy-style names (`Gimse`, `Selsbakk`, `Blussuvoll`, `Katta`, plus one inactive).
- Field of study: `Datateknologi` (legacy name).
- Articles: Norwegian titles in the legacy register (recruitment/profile/news style), bodies
  written fresh for this spec - no copied legacy text, no copyrighted content.
- Receipt description in the legacy register (event/supply purchases, e.g. kaffetrakter/stand
  style wording), amount in NOK øre.
- No real personal data, emails, or phone numbers: people use `@example.invalid` and `+47 900 …`
  synthetic values; sponsors are out of scope for the seed (placeholder-marked in evidence).

## Scenario inventory

Each element maps to one native write path, one idempotency mechanism, one dashboard surface, and
its legacy counterpart route (from `evidence/functional-parity/mono-routes.json`):

| #   | Element                                                                 | Native write path                                                                                                             | Idempotency                                                           | Dashboard surface                             | Legacy counterpart                                                           |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Identity persons (leader, member, interviewer, applicant-owner, author) | `identity:seed` (better-auth engine, caller-supplied IDs)                                                                     | person insert `ON CONFLICT DO NOTHING`; auth user skipped by id/email | login                                         | `/login`                                                                     |
| 2   | Department(s) Trondheim/Bergen/Ås                                       | `POST /api/admin/departments` (native Organization administration)                                                            | fixed synthetic IDs + command receipts                                | `/dashboard/team`                             | `GET /kontrollpanel/avdelingadmin`                                           |
| 3   | Team `Rekruttering`                                                     | `POST /api/admin/teams`                                                                                                       | fixed synthetic ID + command receipt                                  | `/dashboard/team`                             | `GET /kontrollpanel/teamadmin/team/{id}`                                     |
| 4   | Memberships (`Leder` + `Medlemmer`) in the imported authority cohort    | `Organization.importLegacyOrganization` (established import/classification path - no native membership-create command exists) | exact fixed snapshot replay                                           | `/dashboard/team`, `/dashboard/brukere`       | `GET /kontrollpanel/teamadmin/avdeling/{id}`                                 |
| 5   | Admission semester row                                                  | named prerequisite insert (`admission_period_semesters` has no native command; 0049 journey-seed precedent)                   | fixed ID + read-back                                                  | -                                             | `ANY /kontrollpanel/semesteradmin` (no native equivalent yet - recorded gap) |
| 6   | Open admission period (Trondheim)                                       | `POST /api/admin/admission-periods` (`CreateAdmissionPeriod`)                                                                 | command receipt; replay returns `replayed: true`                      | `/dashboard/opptaksperioder`                  | `GET/POST /kontrollpanel/opptaksperiode`                                     |
| 7   | Applicant + application                                                 | `POST /api/applications` (public application submit)                                                                          | fixed `commandId` receipt                                             | `/dashboard/sokere`                           | `POST /kontrollpanel/opprettsoker`                                           |
| 8   | Assigned interview                                                      | `POST /api/admin/recruitment/interviews/assign`                                                                               | assignment command receipt                                            | `/dashboard/sokere`                           | `POST /kontrollpanel/intervju/fordel/{id}`                                   |
| 9   | Pending receipt                                                         | `POST /api/receipts/submit` (multipart, payment authority prerequisite)                                                       | submission command receipt; replay `replayed: true`                   | `/dashboard/mine-utlegg`, `/dashboard/utlegg` | `GET /kontrollpanel/utlegg`, `POST /utlegg/rediger/{receipt}`                |
| 10  | Draft article                                                           | `POST /api/admin/content/articles` (`CreateDraft`)                                                                            | publication command receipt                                           | `/dashboard/artikler`                         | `GET /kontrollpanel/artikkeladmin`                                           |
| 11  | Published article                                                       | `POST /api/admin/content/articles/{id}/publish`                                                                               | publication command receipt                                           | `/dashboard/artikler`, public `/nyheter`      | `POST /kontrollpanel/artikkeladmin/opprett`                                  |
| 12  | Schools directory                                                       | explicit skip: no native write command exists; no directory rows are fabricated                                               | skip reason in evidence                                               | `/dashboard/skoler`                           | `GET /kontrollpanel/skoleadmin`, public `GET /skoler`                        |

Payment authority (`economy_payment_authorities`) is a named prerequisite for element 9 (no native
command creates it); the receipt itself goes through the native submit command.

The imported authority cohort has department ID `1` and team ID `11`. The native administration
commands derive hashed entity IDs. The current importer has no destination-ID reconciliation map,
so the runner does not rewrite either side with raw SQL. It records this boundary explicitly while
the application, interview, receipt, and article journey remains coherent inside the imported
authority scope.

## Runner design

`infra/host/preview-scenario.ts` is one Bun entrypoint composed from existing boundaries:

1. Reject non-PostgreSQL URLs, non-loopback hosts, shared preview port `5434`, and database names
   that do not contain `preview` or `scenario`.
2. Run `identity:seed`; its `DatabaseLive` applies migrations. Read back migration
   `23_declarative-authorization-rules` and all six person IDs.
3. Call `Organization.importLegacyOrganization` through `OrganizationLive` and `DatabaseLive` for
   the fixed membership authority snapshot.
4. Insert only named prerequisites that have no native command: global-administrator authority,
   admissions authority rows, payment authority, and interview schema. Record every reason.
5. Start the real backend on loopback port `8872`, sign in through Better Auth, and execute the
   native HTTP routes for departments, team, admission period, application, assignment, receipt,
   draft, and publish.
6. Read back every required state after its write, including the exact assignment receipt,
   `Pending` receipt status, and article version `1`.
7. Emit one evidence JSON artifact with step status, table counts, replay results, skip reasons,
   and a `legacyAlignment` map.

## Falsifiers

1. **Duplicate-safe re-run:** the second invocation reports every command step as `replayed` and
   changes zero business-table counts; any duplicate row fails the run.
2. **No silent mock/skip:** any surface without a native command path appears in evidence with its
   exact missing capability. A fabricated success is a falsifier.
3. **Fresh reads:** every required state is verified after its write in the same invocation;
   pre-recorded expectations are rejected.
4. **No production hosts:** the runner rejects non-loopback PostgreSQL, shared preview port `5434`,
   and unsafe database names. The tunnel and production hosts are never touched.
5. **No PGlite/SQLite/in-memory store** - real PostgreSQL only (spec 0067 rule reused).

## Non-goals

- No production data access and no deploy: the runner never targets the live preview DB, tunnel,
  Cloudflare, or the apex Workers; applying it to `vektor.phibkro.org` requires operator authority
  this spec does not grant.
- No new product features, no schema changes, no new tables, no legacy source execution.
- No sponsor or survey/board seeding beyond the placeholder note in evidence.

## Acceptance

1. `bun run infra/host/preview-scenario.ts` twice against a fresh disposable PostgreSQL on port
   5435 exits 0 both times with identical business-table counts and `replayed: true` on the second
   run.
2. The evidence artifact shows every supported inventory element in its expected state, records
   every explicit skip, and includes the legacy-route counterpart map.
3. The focused safety tests pass, and the runner itself exercises the real Better Auth and native
   API journeys against PostgreSQL.
4. The disposable cluster is stopped after evidence capture; the worktree stays clean.
