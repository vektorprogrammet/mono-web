# Mono-web

Turborepo monorepo for the Vektorprogrammet native replacement.

## Authority

Read [STATE.md](STATE.md) for current work.
Read [docs/system.md](docs/system.md) for intended product behavior.
Read [docs/architecture.md](docs/architecture.md) for technical boundaries.

The migration targets the native application. Symfony source establishes legacy
behavior to assess. It is not the target architecture.

For a non-trivial journey, create one active contract under `docs/specs/`.
Remove it after the accepted intent is represented by the system document, code,
and observable checks. Do not retain completed specifications, screenshots,
logs, generated references, or runtime evidence in the repository.

Current executable contracts, package manifests, and source code define the
implemented surface. Local observations do not authorize production action.

## Building reference

Use [rat-stack](https://ratstack.sh/llms.txt) as the architectural reference.
Before code changes, search its rules and skills for the affected concern.
Before simplification, read its [uncomplect skill](https://ratstack.sh/skills/uncomplect).
Read the installed Effect package's `AGENTS.md`, linked `ai-docs`, and source before Effect changes.
Check APIs against installed versions, not unrelated examples or newer package copies.

Effect owns effectful work, typed failures, services, and resource cleanup.
Alchemy owns cloud infrastructure and bindings.
Lifecycle definitions own legal transitions; clients display state and submit commands.
Keep one authoritative contract and derive its transport interfaces.
Enforce boundaries with types first, then compiler or lint checks, rather than prose alone.
Report violations with their source location, preserved behavior, proposed deletion, and enforcing check.

Keep the product boundaries below, including Bun, Foldkit, and generated HTTP clients.
Check peer compatibility before adopting reference dependencies, including XState and its Effect integration.
Reference examples do not authorize production actions or replace the active journey contract.

The root catalog and lockfile own dependency versions. Do not copy version pins into instructions.
The PostgreSQL adapter pin preserves `PgClient.fromPool` and the pool shared by Database and Better Auth.
Before changing it, inspect the candidate adapter source.
Verify pool ownership, transaction behavior, and shutdown against PostgreSQL.
Keep infrastructure dependencies separate from the application catalog.

## Commands

`devenv shell` is the entry point. Run commands inside it, or one at a time with `devenv shell -- <command>`.
Commands that start PHP, Composer, or MariaDB need `devenv --profile legacy shell`.
[README.md#toolchain](README.md#toolchain) lists what devenv provides and the local commands.
Package manifests own exact scripts. Use `bun run`, not `bun test`, for package scripts.

For focused Vitest checks, invoke Vitest directly through the package:

```bash
bun run --cwd packages/domain vitest run src/receipt/update.property.test.ts --no-file-parallelism --maxWorkers=1
bun run --cwd apps/backend vitest run src/http-api/receipt-transaction.test.ts --no-file-parallelism --maxWorkers=1
bun run --cwd packages/http-api generate
```

The domain aggregate `test` script also runs fixture programs and D1 proofs.
Do not append Vitest flags to that aggregate script.
Focused Vitest does not prove those additional gates or the dashboard bundle gate.

## Packages

| Path                | Responsibility                                           |
| ------------------- | -------------------------------------------------------- |
| `apps/backend`      | Native Effect HTTP process and workers                   |
| `apps/homepage`     | Public React application                                 |
| `apps/dashboard`    | Authenticated React Router and Foldkit application       |
| `apps/server`       | Retained Symfony modernization source                    |
| `packages/domain`   | Business values, transitions, failures, and authority    |
| `packages/database` | PostgreSQL schema, persistence, locks, audit, and outbox |
| `packages/http-api` | HTTP contracts, middleware declarations, and OpenAPI     |
| `packages/sdk`      | Generated native API client                              |
| `tools/e2e`         | Disposable local journey drivers                         |
| `tools/parity`      | Temporary migration analysis and safe runtime helpers    |

Keep the dependency graph in [docs/architecture.md](docs/architecture.md).
Product packages must not import migration tools or application source.

## TypeScript conventions

- Use Bun as package manager and runtime unless a target requires Node.
- Use Effect v4 as the application language for effectful code.
- Push concrete runtimes and vendors into Layer implementations.
- Use direct functions for total local calculations.
- Use Schema at external, persistence, and transport boundaries.
- Infer types from schemas. Do not duplicate interfaces.
- Use Oxfmt and Oxlint. Do not add another formatter or linter.
- Use generated SDK operations for frontend-to-backend communication.
- Model stateful dashboard workflows with one Foldkit Model.
- Treat UI roles and navigation as projections, not authority.

## Change rule

Implement one complete operational journey at a time. A route, schema, unit
test, or generated SDK method is not migration completion.

For a permanent behavior change:

1. Define the observable outcome and authority boundary.
2. Update domain, persistence, HTTP, SDK, and UI callers as one cutover.
3. Exercise the real UI, API, and PostgreSQL path.
4. Observe denial, concurrency, replay, and recovery where applicable.
5. Remove temporary scripts and the completed specification.
6. Update STATE.md and the intended system document when their facts change.

Production data, credentials, providers, deployments, writer transfer, and
legacy shutdown require explicit operator authority.

## Boundary practices

- Expose complete business commands through the existing domain service. Avoid generic CRUD and additional repository layers.
- Resolve authority inside the committing transaction. Never reuse an authorization result across transactions or retries.
- Preserve state, revision, command receipts, audit, and outbox writes in one transaction. Keep provider I/O after commit.
- Keep HTTP response receipts and preconditions in the transport layer. A revision preflight grants no write authority.
- Reuse domain field schemas with `SqlSchema`. Keep SQL projections, joins, ordering, scope, and storage codecs in database adapters.
- Use Model variants for useful representations, not automatic business commands or partial PATCH schemas.
- Encode through the explicit public schema. Raw `JSON.stringify(model)` does not enforce private-field omission.
- Make absence explicit in schemas. For canonical command encoding, use absent keys rather than present `undefined` values.
- Generate HTTP, OpenAPI, and SDK artifacts from the existing contract. Never maintain parallel operation lists.
- Keep lifecycle rules in the owning domain and UI workflow state in one Foldkit Model.

The Economy query and settlement command in [architecture.md](docs/architecture.md#domain-services) are the current boundary precedent.
A compatible dependency is not an adoption decision.
Do not introduce XState, EventLog, or PersistedQueue without an approved behavioral need and a complete replacement contract.
A queue replacement must preserve atomic enqueue, claim fencing, predecessor ordering, immutable envelopes, retry, cancellation, and secret cleanup.
EventLog does not replace command idempotency or external delivery.

## Construction over trust

A rule that only a reviewer, a comment, or a copied value enforces is not enforced.
When you touch code that trusts one of the patterns below, fix that instance in the same change.
Record instances you cannot fix in `STATE.md` with their location. Remove the record when the instance is fixed.

| Trusted by convention                                                   | Construction                                             | Precedent on `main`                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A string names a closed set, and a second value repeats a fact about it | Derive the type and every related fact from one registry | `NativeProblemRegistry` in `packages/http-api/src/http-semantics.ts` owns code, status, and body; `Problem.make(code)` takes no status. Counter-example: `PlacementFailure` carries a `status` beside its registry `code`. |
| A value is validated at the edge but travels as a plain string          | Decode once to the domain type at the boundary           | Instants belong in `DateTime.Utc`. Counter-example: `compareRfc3339Instants` parses both strings at each call.                                                                                                             |
| A copy of a derived value is kept in sync by hand                       | Generate it, or check it against its source              | `devenv.nix` reads tool versions from `package.json`, `bun.lock`, and `composer.json`. It and `.oxfmtrc.json` hold the only hook and formatter definitions.                                                                |
| A test pins the observed output                                         | Decode the response with the contract schema             | `apps/dashboard/e2e/receipt-approval.spec.ts` decodes with the exported receipt schemas. Counter-example: suites that re-pinned `credential.invalid` after 042e808d.                                                       |
| An operation reports success when its precondition was lost             | Return a typed failure that the caller must handle       | `OutboxClaimLost` in `packages/database/src/outbox-lifecycle.ts`.                                                                                                                                                          |
| A runtime flag grants test authority                                    | Let only the test composition construct it               | `decodeReceiptE2EComposition` rejects receipt E2E flags outside the `local` deployment.                                                                                                                                    |
| A check exists but nothing runs it                                      | Run it from a hook or CI job                             | The `devenv.nix` Git hooks run format, lint, and the changed packages' type checks and tests on commit; `check-types` regenerates the HTTP contract and asserts it.                                                        |

## Verification and resources

Use the configured rules in `oxlint.config.ts`. Do not copy their rule inventory into prose or suppress a failure.
Use existing typed test Layers or disposable infrastructure. Do not substitute module mocks or SDK echoes for a real boundary.
Keep regression tests for plausible behavior failures, not field forwarding, source text, or incidental wording.
Use disposable probes for other implementation observations.

For property checks, generate reachable command sequences and assert business invariants.
Use the installed Arbitrary API with bounded runs, deterministic seeds, and typed options.
Valid schema generation does not cover malformed wire input.

Full end-to-end suites dominate machine load. Only the orchestrating lead starts them, one at a time.
They are the golden journeys (`test:golden-*`) and their CI wrappers, `verify:delivery-recovery`,
and the browser evidence suites (`e2e:*:real`, `e2e:real-*`).
A worker that needs one reports the exact command to the lead and does not start it.

All other checks and tests can run at the same time under the admission rule below.
Heavy jobs are real PostgreSQL tests, browsers and dev servers, `turbo check-types`, and `turbo test`.
Each agent runs at most one heavy job at a time.
Run a heavy job through `bun run measure-job --class <class> -- <command...>` to record its resource use.
The ledger is `${XDG_STATE_HOME:-~/.local/state}/vektorprogrammet/job-ledger.jsonl`.
It is machine runtime evidence. Do not commit it.

Before a heavy job, run `bun run measure-job --report`. Read the max peak RSS and max mean cores of the class.
If the class has no ledger row, measure it first while no other heavy job runs.
Start the job only if both conditions are true:

- `MemAvailable - peak RSS >= 20% of MemTotal`
- `1-minute load + mean cores <= 80% of logical CPUs`

Memory is the hard limit, and CPU is the soft limit because oversubscription only slows jobs.

If a condition is false, wait and check again.
Load and `MemAvailable` lag a job that started in the last minute. Include its peak RSS and mean cores before you compare.

Git hooks do not use the admission rule. Their type checks and tests run through `scripts/hook-slot.ts`.
It holds one of N machine-wide slots, a `flock` lock on `${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet/hook-slot-<n>`.
If all slots are busy, the hook shows the slot holders and waits.
The lock is released when the hook process stops, also on a signal.
Each slot pins its job to 1/N of the allowed CPUs. Vitest starts one worker less than that CPU count.
Explicit settings, such as `--no-file-parallelism`, still apply. Hook Turbo runs use `--concurrency=1`.
A staged change that selects no type check or test does not take a slot.
The ledger records hook jobs as `hook-*` classes.

`VEKTORPROGRAMMET_HOOK_SLOTS` sets N. The default is 5.
Derive N for a machine as slots = min(memory bound, CPU bound), and use at least 1.
The memory bound is the usable memory divided by the peak RSS of the heaviest hook job.
Usable memory is the typical `MemAvailable` minus 20% of `MemTotal`.
The CPU bound keeps at least 6 CPUs for each job, because the test suites have 5-second timeouts.
On this machine, the memory bound is 23.5 GiB / 2.4 GiB = 9 and the CPU bound is 32 / 6 = 5.

Bound worker counts and PostgreSQL connections.
Use private database instances and ports. Dispose runtimes before removing their storage.
Stop only resources owned by the task. Do not terminate an unrelated process to free a port.

Bind acceptance to the exact source artifact, not a branch name or an agent report.
If the operator tree is dirty, preserve it and use a separate committed snapshot for acceptance.
Verify source equality with a file manifest and checksums.
Retain evidence and source bundles outside the product repository.
Report the exercised journey, source revision, environment, results, and unverified boundaries.
Remove owned disposable scripts, checkouts, processes, and completed specifications after acceptance.

A failed aggregate command is not a passing suite because its earlier tests passed.
A local browser journey is not provider proof. A deployed provider journey is not production cutover authority.
`STATE.md` holds current state only: current acceptance, open gaps, and the next gates. Remove an item when it is resolved; Git keeps the history.
Keep enduring behavior in the system and architecture documents.

## Symfony source

Use `apps/server/CLAUDE.md` for Symfony-specific commands and constraints.
Server commands run through Composer inside `devenv --profile legacy shell`:

```bash
devenv --profile legacy shell
cd apps/server
composer install
composer test
composer lint
composer analyse
```

After a database constraint or validation change, verify that fixtures load:

```bash
APP_ENV=test php bin/console doctrine:fixtures:load --no-interaction
```
