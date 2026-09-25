# Golden school-service CI

Status: accepted locally; hosted acceptance not run.

This contract owns slice B of the [functional testing roadmap](../web-system-functional-testing.md#development-sequence).
[Slice A](golden-school-service-journey.md) is accepted locally. This slice does not repeat its product acceptance.

## Goal

The existing CI workflow must run `bun run test:golden-school-service` as a required, credential-free functional gate.
A successful result must identify the exact checkout, built dashboard, runner, fixture, and retained evidence.
A missing, skipped, unsupported, interrupted, or failed journey must never produce a successful gate.

## Constraints

### Scope and ownership

This slice owns this specification, a narrow addition to [CI](../../.github/workflows/tests.yml), and acceptance/report glue in `tools/e2e/`.
Narrow [browser runner](../../apps/dashboard/e2e/run-real-native-placement.mjs) changes record the built dashboard identity and owned process groups.
Golden-only transport diagnostics contain method, path, status, elapsed time, and abort events, never headers, query strings, or bodies.
The [parent runner](../../tools/e2e/placement-check.ts) remains the lifecycle owner.
The [observer](../../tools/e2e/golden-school-service.mjs) remains the authority for required step identities.
No new framework or private product API belongs to this slice.

Forbidden areas include product behavior, provider configuration, deployment workflows, database implementations, generated sequences, new journeys, and visual or design acceptance.
PGlite, scaling, and fixture reuse remain separate roadmap slices.
The documentation branch owns its specification and documentation work. This branch must not change those files.

The integration owner controls shared `STATE.md`, roadmaps, manifests, lockfiles, and required-check repository configuration.
Before any necessary shared-file change, declare its path, reason, and owner to the integration owner.
No dependency change forms part of this contract.
No publication, hosted workflow trigger, deployment, or credential change follows from local implementation authority.

### Required execution

The job must run on every existing pull-request and main-push CI event without path filters or secret-dependent conditions.
Its stable check name must distinguish the golden gate from lint, build, preview, and release jobs.
Repository protection must require that check through a separately authorized configuration action.
Workflow code alone cannot establish that repository protection exists.

The job must call the existing local command, not `--api-only`, broader placement coverage, or a substitute scenario.
The browser must run once with one worker and zero acceptance retries.
A failed first attempt remains failed. A later run cannot replace its evidence without a distinct run identity.
Diagnostics and cleanup must not overwrite the first failure.
An artifact upload failure must also fail the job.

### Identity and evidence

The acceptance step must reject an absent or malformed `receipt.json`.
It must require `native-functional-journey/v1`, `intent://golden-school-service`, required browser evidence, and every ordered golden step.
It must require a passed result, exit code zero, no termination signal, and a clean source tree.
It must compare `mono_revision_ref_id` and `source_tree` with the actual checkout, including a pull-request merge checkout.
An unrelated branch head, stale receipt, or previous run cannot satisfy this comparison.

The acceptance step must recompute runner source hashes, `fixture_digest`, artifact sizes, artifact hashes, and `artifact_digest`.
It must reject missing files, duplicate paths, symlinks, traversal paths, and unsupported artifact names.
The browser runner must record a sorted digest inventory of the built dashboard before it starts the server.
The acceptance step must compare that inventory with the local build bytes.
The browser must use that same build without another build during the journey.
The backend runs the exact clean checkout rather than a separate compiled deployment artifact.

Uploads must use a private staging directory and an explicit allowlist:

- `receipt.json` and `evidence.json`.
- `browser-evidence.json`, `browser-network.json`, and `playwright-evidence.json`.
- `browser-build.json`, `browser-cleanup.json`, and `browser-active.json`.
- `browser-trace-sanitized.json` on browser failure.
- Sanitized `failure.log`, `dashboard-runtime.log`, and numbered `dashboard-command-<number>.log` files.
- A bounded CI acceptance summary with checkout identity, command outcome, and acceptance errors.

Only receipt-listed evidence files can enter staging. The receipt and CI summary are explicit exceptions.
The staging step must reject credentials, authorization values, cookies, private bytes, and unredacted synthetic secrets.
Raw traces, credential manifests, database files, browser profiles, and raw result directories must never enter an upload.
Artifact names must include the checkout revision, workflow run ID, and attempt number.
Retention must not exceed one day. Uploads must not use a wildcard over a runtime directory.
The upload file set must contain exactly the checked staging files.
The workflow must not maintain a second file inventory.

### Resources and cleanup

The job must use read-only repository permission, disabled checkout credential persistence, and no provider credentials or environment approvals.
The toolchain must use the root Bun version and frozen lockfile, Node 22, PostgreSQL with `btree_gist`, installed Chromium, and `unzip`.
The workflow must identify the OS and PostgreSQL major version and record actual runtime versions.
One job owns one mutable checkout, build directory, temporary root, database, receiver, port set, and browser session set.
The gate must not use the existing receipt service database or operator demonstration resources.
Only immutable dependencies can share a cache. No result, authenticated session, or mutable database can share a cache.

The job timeout must leave time for bounded command termination, cleanup, evidence acceptance, and upload.
The command must receive SIGTERM before forced termination. SIGINT and SIGTERM must preserve failed receipts when graceful cleanup remains possible.
Cleanup must stop owned processes, release ports, close the receiver, and delete database and credential files.
Browser cleanup must delete raw traces and private result directories.
Cleanup failures must fail acceptance without replacing the original journey failure.
After a hard kill or runner loss, the isolated hosted runner provides final containment, not proof of graceful cleanup.
A missing receipt after that event remains a failure.

## Values

- Preserve the accepted journey and its independent observations.
- Prefer the existing workflow, command, receipt format, and lifecycle owners.
- Reject incomplete evidence instead of inferring success from a log line.
- Keep local evidence distinct from hosted execution and provider acceptance.
- Preserve the first failure and keep diagnostics safe to retain.

## Definition of done

Local implementation acceptance is complete. Hosted acceptance remains **not run**.

| Check                                                                                           | Required result                                                                         | Local acceptance                         |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| Clean local `bun run test:golden-school-service` through CI acceptance glue                     | One passed scenario, exact source/build identity, complete evidence, successful cleanup | Passed; 13 ordered steps                 |
| `GOLDEN_SCHOOL_SERVICE_FAULT=omit-attendance` with the same command                             | Nonzero command and gate results, retained original failure, no false completion        | Passed; exit 1 and failed receipt        |
| `GOLDEN_SCHOOL_SERVICE_FAULT=absent-browser-evidence` with the same command                     | Missing browser evidence fails the gate                                                 | Passed; exit 1 and failed receipt        |
| SIGINT and SIGTERM after `browser-active.json`                                                  | Failed receipt, stopped processes, released ports, deleted private state                | Passed; exits 130 and 143                |
| Parent runner SIGKILL after browser startup                                                     | Missing receipt fails the gate; owned process groups stop                               | Passed; SIGKILL retained, gate exit 1    |
| Deleted receipt or required artifact                                                            | Acceptance fails                                                                        | Passed                                   |
| Wrong revision/tree, changed runner, artifact, fixture digest, or build bytes                   | Acceptance fails                                                                        | Passed                                   |
| Skipped, incomplete, or duplicate required results                                              | Acceptance fails                                                                        | Passed                                   |
| Unknown path, symlink, raw trace, or credential-bearing diagnostic                              | No unsafe upload, failed acceptance                                                     | Passed, including decoded credentials    |
| Upload file set on success, failure, and setup failure                                          | Exact checked files and summary; no separate workflow inventory                         | Passed                                   |
| Local workflow structure review                                                                 | Unconditional job, bounded resources, read-only permission, explicit uploads            | Passed locally                           |
| Separately authorized hosted success, deliberate failure, cancellation, and missing-result runs | Actual hosted conclusions and retained evidence match this contract                     | Not run; separate authorization required |

Local commands and workflow review do not prove hosted execution, hosted cancellation, artifact service behavior, or repository protection.
The integration owner controls hosted acceptance and shared status documents.

### Local acceptance record

The runtime checks cover implementation commit `14f47869e5d09a0a526e58891d0ce2d8dc25ceb1`.
Its source tree is `f9134bdf9f834c06dc6c8417fda2b51824de9763`.
The later documentation-only acceptance commit does not have a separate runtime result.

The [CI runner](../../tools/e2e/golden-school-service-ci.mjs) passed in 28.76 seconds through the existing local command.
It used Bun 1.3.10, Node 22.22.0, PostgreSQL 17.11, and the local Chromium executable.
The success evidence remains at `/tmp/golden-ci-acceptance-14f47869`.
Its artifact inventory digest is `sha256:1f8edc5a30046b3c5a4ba914c8007ead85be67d6339ba1ad42bcb160d97502ca`.
The generated upload set contained exactly 13 checked files, including the receipt and CI summary.

The two deliberate failures remain at `/tmp/golden-ci-omit-14f47869` and `/tmp/golden-ci-absent-14f47869`.
Their generated upload sets matched the retained files.
Signal evidence remains at `/tmp/golden-ci-sigint-14f47869` and `/tmp/golden-ci-sigterm-14f47869`.
Parent-crash evidence remains at `/tmp/golden-ci-owner-crash-14f47869`.
Independent checks found no owned processes, rebound every recorded port, and confirmed removal of each private temporary root.

A throwaway receipt check passed 23 acceptance and rejection cases against the final success evidence and build bytes.
The [focused regressions](../../tools/e2e/golden-school-service-evidence.test.mjs) passed both tests with 18 assertions.
They cover encoded credential rejection and safe upload output after setup failure.
The workflow uses a 40-minute job bound with bounded steps and termination headroom.

### Preserved failure limits

An earlier attempt at `ae5928fe` failed after a dashboard GET returned HTTP 503.
Its evidence remains at `/tmp/golden-ci-success-ae5928fe`; its failed result did not change.
A distinct diagnostic run at `3abf4958` passed. The underlying cause remains unproven.
No acceptance retry, product timeout increase, or product behavior change hides that failure.

The first `14f47869` attempt lost its tool connection before the CI wrapper returned a result.
Its recovered inner receipt remains at `/tmp/golden-ci-success-14f47869`; it does not prove CI acceptance.
The recovery record is `/tmp/golden-ci-success-14f47869.recovery.json`.
Independent recovery checks found stopped processes and released ports, then removed the private temporary root.
The separately named acceptance run above used the same unchanged source.

### Cleanup and handoff

Temporary negative-case copies and proof scripts were removed after local acceptance.
The retained evidence is local and ephemeral, not a hosted artifact or permanent audit store.
The integration owner retains the shared temporary toolchain until combined integration checks finish.
The integration owner updates shared roadmaps, status, and release notes after branch integration.
