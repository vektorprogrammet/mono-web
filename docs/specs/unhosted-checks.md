# Unhosted checks: remaining steps

Branch `fix/unhosted-checks-0926`, worktree `mono-web-unhosted-0926`, rebased onto main 78e5b603. Remove this file before landing.

## Done

- `82f08207` (work in progress): `rehearsal` joins the journey recipes; `just layout` fails on a Playwright spec or `tools/acceptance` file that no name runs and no exclusion lists; the new `just e2e` names; the first cause fixes (recommendation-check opens the interview in every mode since dc6c4571; the integrity decode accepts pg's undefined `constraint` since 62a7b94c; `/dashboard/assistenter` left the unavailable projections; the organization import reads its team on `/dashboard/teamsoknader`).
- `677fa01b`: the organization import writes its evidence to `evidence.json` in a fresh `mkdtemp` directory (`SPEC_0067.evidencePath` is gone; `ORGANIZATION_IMPORT_REHEARSAL_EVIDENCE_PATH` still overrides).
- `4aab8e4a`: sign-in specs resolve pages through `dashboardMount` and check the token reset page (red: 9 of 9 failed since 5cbdbe5e and 75398187); password-recovery-check imports `packages/domain/src/mail.js` by path (red: module not found since 8ce4b409); recommendation-check expects 403 `authority.denied` from the retried link-race finalization (red: 403 !== 409 since 74b037e2). `homepage-dev-journey.spec.ts` stays excluded: its home page answers 503 without a backend since 4efd0a2c.
- `83816c1d`: recommendation-check expects no Intervjuskjema link for a board leader (red in correction mode: the link is global-administrator only since 7472f5ea).

## Evidence

`/tmp/vektor-unhosted-0926` (`observations.txt`, `obs-*.log`; `observe.sh` runs a command in the clean snapshot `snap/` under `just measure`).
Red on 7933ffc1: organization import (`Registrerte team` missing; a second run with the same evidence path fails with EEXIST, `obs-red-rehearsal-organization-import-eexist.log`).
Red on a64690de: sign-in-pages, homepage, password-recovery, recommendation and recommendation-report (403 !== 409), recommendation-correction (Intervjuskjema).
Green on a64690de, whose files for these journeys are unchanged since: unavailable-projections (16 s), onboarding, recommendation-applicant-progress, recommendation-co-interviewer, recommendation-returning. sign-in-pages passed 9 of 9 in the dirty worktree (13 s).
The supervised process `unhosted-batch-final` (`batch-final.sh`) runs every new name on the snapshot at the commit that adds this file, and appends `final-*` lines to `observations.txt`.

## Remaining steps

1. Read the `final-*` lines and logs. Fix the cause of each red run and observe it green, or exclude the journey in `tools/conventions/src/journeys.ts` with its reason and owner. Receipt-import, current-assignment, and the two organization-import cluster runs (`orgimport-green-with-cluster.sh`, default evidence path, twice) have no green run yet.
2. Organization import administrator cluster: `startDisposablePostgres` is not on main (PostgresHarness did not answer). If it lands, rebase and make `program` call `withDisposablePostgres("postgres", (url) => runRehearsal(Redacted.value(url), evidencePath))`; remove `ORGANIZATION_IMPORT_REHEARSAL_ADMIN_PG_URL`, its `/run/postgresql` default, and the variable name in the `createDisposableDatabase` error. Otherwise exclude `rehearsal organization-import`: inside `devenv shell`, `PGPORT=5480` sends the default to a socket that does not exist, and the hosted runner has no administrator PostgreSQL. Record that gap in STATE.md Known gaps.
3. Set the `browser-journeys` step timeout to three times the longest local wall time in the ledger (existing legs: 90 s, proof delivery-recovery), and add 8791 (the unavailable-projections fixture API) to the fixed-port comment. Do not add 5187: no runner binds it; it is only the unused `baseURL` of `playwright.organization-import-rehearsal.config.ts`, and the rehearsal binds 5174.
4. STATE.md Known gaps: the matrix also runs `just rehearsal` names; name the legs that passed locally only.
5. Run `just layout write`, actionlint (`nix run nixpkgs#actionlint -- .github/workflows/tests.yml`, 0 on the earlier tree), and `just measure --class check -- just check` on the clean committed tree.
6. Remove this file, `git worktree remove /tmp/vektor-unhosted-0926/snap`, and the evidence scripts.

## Follow-ups outside this slice

- `native-session-journey`, `native-users-journey`, `native-team-interest-journey`, `native-mailing-lists-journey`, and `homepage-dev-journey` specs need runners that own their topology.
- `native-recruitment-assignment.spec.ts` duplicates the hosted recruitment session journey; delete it with operator approval.
- `apps/dashboard/app/foldkit/organization` keeps the Team catalog view and load branches that no element mounts since 62a7b94c.
- `recommendation-check.ts --returning-login-probe` records a login diagnostic and asserts nothing, so no name hosts it.
- The legacy-data rehearsals need a job with the `legacy-data` devenv profile to be hosted; `bun run --cwd tools/e2e rehearsal:legacy-person` reads a private backup and has no `just rehearsal` name.
