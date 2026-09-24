# Golden school-service CI

Status: planned.

This contract owns slice B of the [functional testing roadmap](../web-system-functional-testing.md#development-sequence).
[Slice A](golden-school-service-journey.md) is accepted locally. This slice does not repeat its product acceptance.

## Goal

The existing CI workflow must run `bun run test:golden-school-service` as a required, credential-free functional gate.
A successful result must identify the exact checkout, built dashboard, runner, fixture, and retained evidence.
A missing, skipped, unsupported, interrupted, or failed journey must never produce a successful gate.

## Constraints

### Scope and ownership

The planning branch owns this specification only.
Implementation owns a narrow addition to [CI](../../.github/workflows/ci.yml) and acceptance/report glue in `tools/e2e/`.
A narrow [browser runner](../../apps/dashboard/e2e/run-real-native-placement.mjs) change can record the built dashboard identity.
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

Each requirement needs executable evidence. All implementation acceptance checks are **not run** at planning time.

| Check                                                                                           | Required result                                                                           | Planning status                          |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| Clean local `bun run test:golden-school-service` through CI acceptance glue                     | One passed scenario, exact checkout/build identity, complete evidence, successful cleanup | Not run                                  |
| `GOLDEN_SCHOOL_SERVICE_FAULT=omit-attendance` with the same command                             | Nonzero command and gate results, retained original failure, no false completion          | Not run                                  |
| `GOLDEN_SCHOOL_SERVICE_FAULT=absent-browser-evidence` with the same command                     | Missing browser evidence fails the gate                                                   | Not run                                  |
| SIGINT or SIGTERM after `browser-active.json`                                                   | Failed receipt, stopped processes, released ports, deleted private state                  | Not run                                  |
| Deleted receipt or required artifact                                                            | Acceptance fails                                                                          | Not run                                  |
| Wrong revision/tree, changed runner, artifact, fixture digest, or build bytes                   | Acceptance fails                                                                          | Not run                                  |
| Skipped, incomplete, or duplicate required results                                              | Acceptance fails                                                                          | Not run                                  |
| Unknown path, symlink, raw trace, or credential-bearing diagnostic                              | No unsafe upload, failed acceptance                                                       | Not run                                  |
| Local workflow structure review                                                                 | Required unconditional job, bounded resources, read-only permission, explicit uploads     | Not run                                  |
| Separately authorized hosted success, deliberate failure, cancellation, and missing-result runs | Actual hosted conclusions and retained evidence match this contract                       | Not run; separate authorization required |

Local workflow review and local commands do not prove hosted execution, hosted cancellation, artifact service behavior, or repository protection.
Implementation completion must report those limits without marking hosted acceptance complete.
Temporary negative-case copies must not alter the retained first-attempt evidence.
After local acceptance, delete throwaway copies and stop temporary processes.
The integration owner records acceptance and updates shared status documents after branch integration.
