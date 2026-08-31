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

The live preview (future operator run) and any local rehearsal can reach one coherent scenario:
one department, one team with members, active plus inactive schools, one open admission period,
one applicant with an application, one assigned interview, one pending receipt, and one draft plus
one published article. Everything enters through native domain boundaries the application already
uses. No raw business SQL, no unrelated fixture tables, no production effect.

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
| 3   | Teams (IT, Rekruttering, Skolekoordinering)                             | `POST /api/admin/teams`                                                                                                       | fixed synthetic IDs + command receipts                                | `/dashboard/team`                             | `GET /kontrollpanel/teamadmin/team/{id}`                                     |
| 4   | Memberships (Leder + Medlemmer)                                         | `Organization.importLegacyOrganization` (established import/classification path - no native membership-create command exists) | import ledger replay of one fixed snapshot                            | `/dashboard/team`, `/dashboard/brukere`       | `GET /kontrollpanel/teamadmin/avdeling/{id}`                                 |
| 5   | Admission semester row                                                  | named prerequisite insert (`admission_period_semesters` has no native command; 0049 journey-seed precedent)                   | fixed ID + read-back                                                  | -                                             | `ANY /kontrollpanel/semesteradmin` (no native equivalent yet - recorded gap) |
| 6   | Open admission period (Trondheim)                                       | `POST /api/admin/admission-periods` (`CreateAdmissionPeriod`)                                                                 | command receipt; replay returns `replayed: true`                      | `/dashboard/opptaksperioder`                  | `GET/POST /kontrollpanel/opptaksperiode`                                     |
| 7   | Applicant + application                                                 | `POST /api/applications` (public application submit)                                                                          | fixed `commandId` receipt                                             | `/dashboard/sokere`                           | `POST /kontrollpanel/opprettsoker`                                           |
| 8   | Assigned interview                                                      | `POST /api/admin/recruitment/interviews/assign`                                                                               | assignment command receipt                                            | `/dashboard/sokere`                           | `POST /kontrollpanel/intervju/fordel/{id}`                                   |
| 9   | Pending receipt                                                         | `POST /api/receipts/submit` (multipart, payment authority prerequisite)                                                       | submission command receipt; replay `replayed: true`                   | `/dashboard/mine-utlegg`, `/dashboard/utlegg` | `GET /kontrollpanel/utlegg`, `POST /utlegg/rediger/{receipt}`                |
| 10  | Draft article                                                           | `POST /api/admin/content/articles` (`CreateDraft`)                                                                            | publication command receipt                                           | `/dashboard/artikler`                         | `GET /kontrollpanel/artikkeladmin`                                           |
| 11  | Published article                                                       | `POST /api/admin/content/articles/{id}/publish`                                                                               | publication command receipt                                           | `/dashboard/artikler`, public `/nyheter`      | `POST /kontrollpanel/artikkeladmin/opprett`                                  |
| 12  | Schools active + inactive                                               | explicit skip: directory has no native write command - rows are seeded inserts with the reason recorded, never silent         | fixed `school_id`s, `ON CONFLICT DO NOTHING`                          | `/dashboard/skoler`                           | `GET /kontrollpanel/skoleadmin`, public `GET /skoler`                        |

Payment authority (`economy_payment_authorities`) is a named prerequisite for element 9 (no native
command creates it); the receipt itself goes through the native submit command.

## Runner design

`infra/host/preview-scenario.ts` (single Bun entrypoint, Effect program), composed from existing
pieces - no new abstractions:

1. Assert the PostgreSQL URL is loopback and the port is the disposable one (default `5435`).
2. Apply migrations through `DatabaseLive` (same layer every capability uses) and assert
   `databaseSchemaRevision === "23_declarative-authorization-rules"`.
3. Compose the live Layers exactly as `apps/backend/src/main.ts` does
   (`DatabaseLive`, `AdmissionsLive`, `EconomyLive`, `OrganizationLive`, `ProfileLive`,
   `SchoolsLive`, `ContentManagementLive`, `ContentLive`, `RecruitmentLive`, `AuthLive`).
4. Execute elements 1-11 through the real router boundary
   (`makeBackendHttp` over `Bun.serve` on an ephemeral loopback port, real better-auth handler for
   session cookies from the identity-seeded credentials). Real sign-in, real session resolution -
   no test Identity layer, no token shortcuts.
5. Insert only the named prerequisites (semester row, payment authority, schools rows) and record
   each with its reason.
6. After every write, read the fresh state back through the native read endpoints and assert the
   expected value before continuing.
7. Emit one evidence JSON artifact: element-by-element status, native observation bodies, table
   counts, replay results, skip reasons, and a `legacyAlignment` map (element -> legacy route).

## Falsifiers

1. **Duplicate-safe re-run:** running the runner twice must change zero business-table counts and
   return `replayed: true` observations; any duplicate row fails the run.
2. **No silent mock/skip:** an element without a native command path must appear in the evidence
   with `status: "skipped"` (or `status: "seeded"` for school rows) plus the exact missing
   capability; a fabricated success is a falsifier.
3. **Fresh reads:** every write must be verified by a read that happens after the write in the
   same run; pre-recorded expectations are rejected.
4. **No production hosts:** the runner rejects any non-loopback PostgreSQL host and any hostname
   matching `vektorprogrammet.no`; the shared preview DB (5434) and tunnel are never touched.
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
2. The evidence artifact shows every inventory element present with the expected state and its
   legacy-route counterpart recorded.
3. One or two existing dashboard journeys (schools directory, recruitment assignment) pass
   against the seeded topology, heavy jobs run one at a time.
4. The disposable cluster is torn down after evidence capture; the worktree stays clean.
