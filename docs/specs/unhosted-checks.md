# Unhosted checks: remaining steps

Branch `fix/unhosted-checks-0926`, worktree `mono-web-unhosted-0926`, from main 7933ffc1.
The work-in-progress commit holds the check, recipe, and conventions changes below. Remove this file before landing.

## Done in the work-in-progress commit

- `tools/conventions/src/journeys.ts`: `rehearsal` joins the journey recipes. A journey name runs the files that its command names and, in turn, the files that journey code names. `just layout` fails on a Playwright spec (`apps/*/e2e/**/*.spec.{ts,mjs}`) or a file of `tools/acceptance` that no name runs and no exclusion lists. Exclusions can list a file. `tools/conventions/tests/journeys.test.ts` holds the negative controls (an unlisted spec and an unlisted probe fail; a spec that a runner names passes).
- `justfile`: `just e2e` accepts `onboarding`, `password-recovery`, `recommendation`, `recommendation-applicant-progress`, `recommendation-co-interviewer`, `recommendation-correction`, `recommendation-report`, `recommendation-returning`, `sign-in-pages`, and `unavailable-projections`. The two dashboard dev-server suites are package scripts in `apps/dashboard/package.json`; `e2e:unavailable-projections` sets `API_URL` and `VITE_API_URL` to the fixture API.
- Cause fixes:
  - `tools/acceptance/recommendation-check.ts`: the default mode filled the conduct form without opening the interview. Regression origin dc6c4571 moved `open(page, "Sofie Gjennomfører")` into the `--correction-mode` branch.
  - `tools/acceptance/interview-correction-integrity.ts`: `--correction-mode` and `--co-interviewer-mode` failed decoding pg's `DatabaseError`, whose `constraint` is present and undefined. Regression origin 62a7b94c decoded it with `Schema.optionalKey`.
  - `apps/dashboard/e2e/dashboard-list-type-boundary.spec.ts`: `/dashboard/assistenter` is the native placement page since f81a86bc, so it left the unavailable pages.
  - Organization import rehearsal: `/dashboard/team` shows appointment management since 62a7b94c, so the Chromium stage reads the imported department and team on `/dashboard/teamsoknader` (SSR `/api/departments` and `/api/teams`).

## Evidence so far

Evidence, scripts, and a clean snapshot worktree live in `/tmp/vektor-unhosted-0926` (`observe.sh <label> <class> <command...>` runs in `snap/` under `just measure`; results append to `observations.txt`). The probes refuse a dirty tree, so observe only in `snap/`, moved with `git -C snap checkout --detach <commit>`.
Red on 7933ffc1: `recommendation` (fill timeout on `#question-interview-schema-native-conduct-0063-q0`), `--correction-mode` and `--co-interviewer-mode` (integrity decode). Green on 7933ffc1: `--returning-mode`.
The supervised process `unhosted-batch-red2` (`hub logs`) runs the red `unavailable-projections`, the remaining recommendation modes, and baselines of sign-in-pages, homepage-dev-journey, onboarding, password-recovery, receipt-import, and current-assignment on 7933ffc1.

## Remaining steps

1. Read `observations.txt` and the `obs-*.log` files of the batch. Observe the organization-import red on 7933ffc1 with `orgimport-with-cluster.sh red` (a throwaway admin cluster).
2. After PostgresHarness lands `startDisposablePostgres` from `@monoweb/postgres` on main, rebase. In `tools/verification/organization-import-rehearsal-main.ts`, make `program` start a disposable cluster and pass its URL as the administrator URL, and stop it after `runRehearsal`. Remove `ORGANIZATION_IMPORT_REHEARSAL_ADMIN_PG_URL` and its `/run/postgresql` default. Default the evidence path to a fresh `mkdtemp` directory and remove `SPEC_0067.evidencePath`: the fixed `/tmp/mono-web-0067-organization-import-evidence.json` makes a second run fail with EEXIST. IdentityFlake edits the legacy classifier lines of this file and of the rehearsal spec; keep clear of them.
3. Commit, move `snap/` to the commit, and observe green through `just measure` for every mode of `recommendation-check.ts`, `unavailable-projections`, `rehearsal organization-import`, and each new suite. Give every journey that stays red a journey-level exclusion with its reason, and host `homepage-dev-journey.spec.ts` as a suite if it passes. Run `just layout write`.
4. Record the local wall times from `just measure --report`. Set the `browser-journeys` step timeout to three times the longest run, and add ports 5187 and 8791 to the fixed-port comment in `.github/workflows/tests.yml`.
5. Run actionlint (`nix run nixpkgs#actionlint -- .github/workflows/tests.yml`) and `just measure --class check -- just check` on the clean committed tree.
6. Remove this file, `git worktree remove /tmp/vektor-unhosted-0926/snap`, and the evidence scripts.

## Follow-ups outside this slice

- `native-session-journey`, `native-users-journey`, `native-team-interest-journey`, and `native-mailing-lists-journey` specs need runners that own their topology.
- `native-recruitment-assignment.spec.ts` duplicates the hosted recruitment session journey; delete it with operator approval.
- `apps/dashboard/app/foldkit/organization` keeps the Team catalog view and load branches that no element mounts since 62a7b94c.
- The legacy-data rehearsals need a job with the `legacy-data` devenv profile to be hosted; `bun run --cwd tools/e2e rehearsal:legacy-person` reads a private backup and has no `just rehearsal` name.
