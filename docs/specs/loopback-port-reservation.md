# Loopback port reservation

Status: in progress on `fix/loopback-port-reservation-0926`, stacked on `fix/returning-revision-race-0926`.

## Defect

A journey runner learned a "free" port with a probe. The probe listened on port 0, read `address()`, closed, and handed the number to a child that bound it seconds later.
The kernel hands the just-released port to the next port 0 bind about once in 2000 runs: 1 collision in 2000 trials of the runner's probe sequence.
That next bind can be the run's own effect receiver or its disposable PostgreSQL probe.
Evidence: run 2 of the 5-run batch at `aa83bde9` (`/tmp/returning-race-0926/batch/run-2.log`). The backend met `EADDRINUSE` on port 40315, then readiness failed at `tools/acceptance/recommendation-check.ts:192`.
Forced red: `/tmp/returning-race-0926/port-red/run-1.log` sets the effect port to the API port and reproduces the same failure.

## Contract

- `reserveLoopbackPorts(count)` in `tools/postgres/index.ts` (`@construct test-harness`) is the one allocator.
  It draws ports from 20000-32767, below the kernel's ephemeral range. It checks each port is free and never returns a port twice in one process.
- `loopbackPortFree(port)` answers for a named port: a fixed port such as 5174 before its server binds it, or a reserved port after teardown.
- `startDisposablePostgres` without `port` reserves through the construct, so its port never repeats a port that the caller reserved.
- `anti-slop/no-port-probe` (`tools/oxlint/anti-slop/rules/no-port-probe.ts`) rejects a server identifier that listens, reads `address()`, and closes outside `finally` in one flow.

## Done on the branch

- The construct and `startDisposablePostgres` default, with `freeLoopbackPort` removed.
- `tools/e2e/golden-harness.ts` reserves and verifies release through the construct. Its `bindLoopback`, `distinctLoopbackPorts`, and `reserveLoopbackPorts` are removed.
- These runners import the construct from `@monoweb/postgres`: the 7 `apps/*/e2e` runners and `tools/acceptance/substitute-outcome-check.ts`.
- These probe helpers are migrated: `tools/acceptance/recommendation-check.ts`, `tools/acceptance/onboarding-check.ts`, `tools/acceptance/password-recovery-check.ts`, and `tools/e2e/placement-check.ts`.
- The rule, with 8 valid and 6 invalid RuleTester cases, is registered in `tools/oxlint/anti-slop/index.ts` but is not enabled yet. `bun run --cwd tools/oxlint test` passed 107/107.

## Remaining steps

1. Migrate the remaining probe helpers onto `reserveLoopbackPorts` and `loopbackPortFree`:
   - `tools/e2e/golden-reimbursement.mjs:144` `reservePort`: allocation at 401 and release check at 349. Drop the `new Set` distinctness assertion, which the construct now guarantees.
   - `tools/verification/unattended-delivery-recovery.ts:45` `port`: allocation at 113-117 and 548, release check at 732.
   - `tools/verification/identity-cohort-rehearsal.ts:103` `freePort`, called at 784.
   - `tools/verification/receipt-import-rehearsal.ts:109` `freePort`, called at 172-173.
2. Enable `anti-slop/no-port-probe` in `oxlint.config.ts`, in the journey-code group beside `no-git-history`, and add `tools/postgres/**`.
   Run oxlint on `apps/*/e2e tools/e2e tools/acceptance tools/verification tools/postgres` and migrate every site it reports.
   Correct the `UPSTREAM.txt` entry: it says "enables it everywhere".
3. In `tools/conventions/src/layout.ts`, move "loopback ports" from the `tools/e2e` import-exception reason to the `tools/postgres` one.
   Run `just layout write`, `just constructs write`, and `just guides write`.
4. Add a Construction over trust row to AGENTS.md: a probe learns a free port and releases it, so reserve through `reserveLoopbackPorts` and let `anti-slop/no-port-probe` reject probes. Keep each cell within the table's current column widths.
5. Verify in one supervised `just measure` batch on the clean committed tree. Run `just e2e recommendation-returning` 5 times, plus one run of each leg whose runner changed: e2e onboarding, password-recovery, substitutes, admission-periods, interview-response, content-publication, identity, organization, owner, and applicant; golden reimbursement; proof delivery-recovery; rehearsal receipt-import; and the placement suite. Then run `just check`.
6. Remove this spec once the facts live in the code, AGENTS.md, and the rule.
