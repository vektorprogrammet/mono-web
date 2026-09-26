# Lead constructs: remaining steps

Status: open on the branch `build/lead-constructs-0926` on 2026-09-26. Remove this file when every step below has run and its result is recorded in a commit message or in `STATE.md`.

## Done on the branch

- The heavy lock, the model checks, `just land`, the migration registry, and the delegation section of `AGENTS.md`.
- The journey clock `tools/e2e/journey-clock.ts` (`admissionJourneyClock`, `journeyClock`) replaces the four inline clock copies, and the Oxlint rule `anti-slop/no-literal-window-instant` rejects literal window instants in journey code.
  The scoped run `bun x oxlint -A all -D anti-slop/no-literal-window-instant apps/dashboard/e2e apps/homepage/e2e tools/e2e tools/acceptance tools/verification` reported 30 findings before the migration and 0 after.
  `cd tools/oxlint && node --test anti-slop/rules/no-literal-window-instant.test.ts` passes 20 of 20; `just constructs` and `just guides` report 0 findings.

## Remaining steps

Run each heavy step alone, under the heavy lock, and record its exit code and evidence.

1. Rerun the suites whose files the journey-clock commit changed:
   - `just e2e scheduling`: the schedule and the seed timeline now derive from the backend's clock, and the spec reads `SCHEDULING_E2E_SCHEDULED_AT`.
   - `just e2e interview-response`: the windows derive from the runner's pin, and the spec reads it as `ADMISSION_FIXED_NOW`. The suite is red on `main` for an unrelated reason, the exact problem-key list; check that this is still the only failure.
   - `just e2e settlement`: the future-settlement control lies one year after the run.
   - `just e2e conduct` and `just e2e recruitment`: the seeds use `admissionJourneyClock` and give the same instants.
   - `just golden school-service` and the placement-check coverage mode: the claimed invitations expire 120 days after the clock.
   - `bun tools/acceptance/recommendation-check.ts`: applicant progress, the returning assistant, and the denied co-interviewer schedule.
   - `bun run --cwd apps/dashboard e2e:test e2e/dashboard-list-type-boundary.spec.ts --project=chromium`: the first spec that imports `tools/e2e` through a `.js` path.
   - `bun run --cwd tools/verification test` (application worker, organization import), `just rehearsal current-assignment`, and `just rehearsal organization-import`.
2. `just check-types`: `tools/e2e/tsconfig.json` includes `journey-clock.ts`, and `tools/verification` and `apps/dashboard` import it.
3. `just model check` and `just model validate`, once each. The counts must match the headers in `docs/model`.
4. Demonstrate `just land` on a throwaway branch.
5. `just check` on the clean committed tree.
