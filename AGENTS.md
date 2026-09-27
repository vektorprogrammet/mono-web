# Mono-web

Turborepo monorepo for the Vektorprogrammet native replacement.

## Authority

Read [STATE.md](STATE.md) for current work.
Read [docs/system.md](docs/system.md) for intended product behavior.
Read [docs/architecture.md](docs/architecture.md) for technical boundaries.

The migration targets the native application. Legacy behavior comes from the live
legacy system and its source in the separate vektorprogrammet repository; see
[docs/architecture.md](docs/architecture.md#legacy-source). It is not the target architecture.

For a non-trivial journey, write one active contract in `content/specs/<name>.mdx`.
`just docs generate` provides its read path at `docs/specs/<name>.md`; never edit that generated file.
Remove it after the accepted intent is represented by the system document, code,
and observable checks. Do not retain completed specifications, screenshots,
logs, generated references, or runtime evidence in the repository.

Current executable contracts, package manifests, and source code define the
implemented surface. Local observations do not authorize production action.

## Building reference

Use [rat-stack](https://ratstack.sh/llms.txt) as the architectural reference.
Before code changes, search its rules and skills for the affected concern.
Before simplification, read its [uncomplect skill](https://ratstack.sh/skills/uncomplect).

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

## Effect first

Before writing TypeScript, read the installed Effect guidance: `node_modules/effect/AGENTS.md`, the `ai-docs` that it links, and the source.
Check APIs against the installed versions, not unrelated examples or newer package copies.
Then read the skill `effect-first` and the overlay of this repository, [.agents/skills/effect-house/SKILL.md](.agents/skills/effect-house/SKILL.md).
The overlay names the constructs, composition roots, test platform, runtime bridges, typed problems, and exception registry of this repository.

Use the first form that expresses the intent:

1. An Effect construct.
2. A composition of Effect constructs.
3. A small domain construct built from Effect constructs. Tag it `@construct <category>` when two modules outside its own module share it, and write its contract.
4. A boundary adapter behind a service that returns Effects.
5. A registered exception.

Keep a total, deterministic calculation a plain function. Do not wrap it in an Effect or a service.

Read about a construct in three steps, each only when you need it: the one-line index [docs/constructs.md](docs/constructs.md), the contract on the page of its category in [docs/constructs](docs/constructs), and its consumers, which `just constructs consumers <name>` prints.
A contract is the JSDoc of the construct, a summary, `@remarks`, `@sideEffects`, `@example`, and `@avoid`, and the annotations of its parameters and return type.
`just constructs` fails on a missing one, and on a construct that fewer than two modules outside its own module and the tests of its app or package import.

Every Effect rule is an error, never a warning or a suggestion: the rules of the Oxlint Effect plugin and the Effect language-service rules of `@effect/tsgo`, which make Oxlint type-aware.
`just lint`, the lint hook, `just check`, and the hosted Checks workflow run them; `tsc` reports no Effect diagnostic.
Fix a finding at its site with the rule's own fix. Where that fix would change behavior or the intent of a test, keep the behavior and choose the equivalent Effect form.
A suppression of an Effect rule, or a non-native substitute, names its entry in [tools/conventions/effect-exceptions.json](tools/conventions/effect-exceptions.json). `just exceptions` rejects one that does not.

When the Effect skill tier of `/srv/share/projects` is installed, delegate Effect work to its profiles.
Use `effect-backend-engineering` for `apps/backend` and the domain, database, and HTTP packages, and `effect-ui-development` for the Foldkit code of `apps/dashboard`.
Use `effect-library-development` for `packages/sdk` and shared constructs, and `effect-engineering` for other work.
Each profile reads the overlay above by its path, also when its session starts outside this repository.

## Commands

`devenv shell` is the entry point. Run commands inside it, or one at a time with `devenv shell -- <command>`.
Legacy data rehearsals that start MariaDB or the PHP CLI need `devenv --profile legacy-data shell`.
[README.md#toolchain](README.md#toolchain) lists what devenv provides and the local commands.
The root [justfile](justfile) is the command surface: `just` lists its recipes, and hooks and CI workflows call them.
Package manifests own the per-package scripts that recipes and Turbo run. Use `bun run`, not `bun test`, for package scripts.

[//]: # "commands: generated from the justfile by just layout write; do not edit"

| Group     | Recipe                            | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| check     | `just check [args...]`            | Check layout, docs, constructs, guides, Effect exceptions, source safety, format, lint, types, and the HTTP contract. Arguments go to Turbo.                                                                                                                                                                                                                                                                                                                                      |
| check     | `just check-types [args...]`      | Type check every package and assert the HTTP contract. Arguments go to Turbo.                                                                                                                                                                                                                                                                                                                                                                                                     |
| check     | `just constructs [args...]`       | Check the construct index and contract pages against the @construct tags and their JSDoc, each construct's contract tags and annotations, and that two modules share it; `just constructs write` renders the pages, and `just constructs consumers [name]` prints the modules that import a construct.                                                                                                                                                                            |
| check     | `just exceptions [args...]`       | Check that every suppression of an Effect rule names its entry in tools/conventions/effect-exceptions.json, and every entry its current sites and versions.                                                                                                                                                                                                                                                                                                                       |
| check     | `just format [args...]`           | Format with Oxfmt, or check with `just format --check`. Oxfmt has no config key for threads.                                                                                                                                                                                                                                                                                                                                                                                      |
| check     | `just guides [args...]`           | Check the AGENTS.md guide and the CLAUDE.md that imports it, of every app, package, and context folder; `just guides write` renders them.                                                                                                                                                                                                                                                                                                                                         |
| check     | `just layout [args...]`           | Check the repository layout and its generated sections: the README and AGENTS.md tables and the hosted journey legs; `just layout write` renders them.                                                                                                                                                                                                                                                                                                                            |
| check     | `just lint [args...]`             | Lint the full tree after generating React Router route types, a heavy job (AGENTS.md#verification-and-resources).                                                                                                                                                                                                                                                                                                                                                                 |
| check     | `just lint-files [args...]`       | Lint only named paths without generating route types. The pre-commit hook passes staged JS/TS paths here.                                                                                                                                                                                                                                                                                                                                                                         |
| check     | `just measure [args...]`          | Run a heavy job under the machine-wide heavy lock and measure it, or show the ledger with `just measure --report`.                                                                                                                                                                                                                                                                                                                                                                |
| check     | `just migration-hashes [args...]` | Check the migration registry and the checksums of applied migrations; `just migration-hashes write` records new ones.                                                                                                                                                                                                                                                                                                                                                             |
| check     | `just model <action>`             | Run the Alloy commands of content/model/authority.als (check) or validate content/model/contexts.cml (validate), a heavy job.                                                                                                                                                                                                                                                                                                                                                     |
| check     | `just source-safety [args...]`    | Scan the Git index for credentials, personal data, and SQL data. --changed limits a commit to staged changes.                                                                                                                                                                                                                                                                                                                                                                     |
| check     | `just test [args...]`             | Test every package, a heavy job (AGENTS.md#verification-and-resources). Arguments go to Turbo.                                                                                                                                                                                                                                                                                                                                                                                    |
| develop   | `just build [args...]`            | Build every package through Turbo. Arguments go to Turbo.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| develop   | `just changelog [args...]`        | Regenerate CHANGELOG.md from conventional commits, or compare it with `--check`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| develop   | `just dev [args...]`              | Start the homepage, dashboard, and backend against BACKEND_PG_URL. `devenv up` runs it.                                                                                                                                                                                                                                                                                                                                                                                           |
| develop   | `just docs [script] [args...]`    | Serve the documentation site, or run another of its scripts, such as `just docs build`.                                                                                                                                                                                                                                                                                                                                                                                           |
| develop   | `just land <branch>`              | Land a branch on main in the main checkout, then remove its worktree and delete it. It does not push.                                                                                                                                                                                                                                                                                                                                                                             |
| develop   | `just seed`                       | Provision the native journey accounts in the `devenv up` database.                                                                                                                                                                                                                                                                                                                                                                                                                |
| hooks     | `just hook-slot [args...]`        | Run a command in one of the machine-wide hook slots under the shared heavy lock (lint and pre-push hooks).                                                                                                                                                                                                                                                                                                                                                                        |
| hooks     | `just hooks [args...]`            | Run the Git hooks by hand, for example `just hooks --hook-stage pre-push`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| journeys  | `just e2e <suite>`                | Run a browser suite: admission-periods, applicant, approval, conduct, contact, content-publication, identity, interview-response, onboarding, organization, owner, password-recovery, profile, recommendation, recommendation-applicant-progress, recommendation-co-interviewer, recommendation-correction, recommendation-report, recommendation-returning, recruitment, scheduling, schools, settlement, sign-in-pages, social-events, substitutes, or unavailable-projections. |
| journeys  | `just fixture <name> [args...]`   | Build a PostgreSQL fixture in JOURNEY_SEED_PG_URL: recommendation-preupgrade.                                                                                                                                                                                                                                                                                                                                                                                                     |
| journeys  | `just golden <journey>`           | Run a golden journey: school-service, recruitment, reimbursement, or team-application.                                                                                                                                                                                                                                                                                                                                                                                            |
| journeys  | `just proof <name> [args...]`     | Run a PostgreSQL proof: authorization-rules, delivery-recovery, or rule-reconciliation.                                                                                                                                                                                                                                                                                                                                                                                           |
| migration | `just migration <name> [args...]` | Run an operator migration command: legacy-service (the service cutover) or legacy-receipt.                                                                                                                                                                                                                                                                                                                                                                                        |
| migration | `just rehearsal <name> [args...]` | Run a migration rehearsal, where account-cohort and the legacy ones need the legacy-data profile: organization-import, receipt-import, current-assignment, account-cohort, legacy-current-assignment, legacy-organization, legacy-receipt, or legacy-candidate.                                                                                                                                                                                                                   |

[//]: # "commands: end"

For focused Vitest checks, invoke Vitest directly through the package:

```bash
bun run --cwd packages/domain vitest run src/receipt/update.property.test.ts --no-file-parallelism --maxWorkers=1
bun run --cwd apps/backend vitest run src/http-api/receipt-transaction.test.ts --no-file-parallelism --maxWorkers=1
bun run --cwd packages/http-api generate
```

The domain aggregate `test` script also runs fixture programs and D1 proofs.
Do not append Vitest flags to that aggregate script.
Focused Vitest does not prove those additional gates or the dashboard bundle gate.

## Layout

[//]: # "layout: generated from tools/conventions/src/layout.ts by just layout write; do not edit"

| Path                    | Holds                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/backend`          | Native Effect HTTP process and workers                                                                |
| `apps/dashboard`        | Authenticated React Router and Foldkit application                                                    |
| `apps/docs`             | Documentation site: renders the content folders and the code extracts to the static site and to docs/ |
| `apps/homepage`         | Public React application                                                                              |
| `packages/domain`       | Business values, transitions, failures, and authority                                                 |
| `packages/database`     | PostgreSQL schema, persistence, locks, audit, and outbox                                              |
| `packages/http-api`     | HTTP contracts, middleware declarations, and OpenAPI                                                  |
| `packages/sdk`          | Generated native API client                                                                           |
| `tools/acceptance`      | Local API and browser acceptance probes of single journeys                                            |
| `tools/conventions`     | Layout, guide, construct, and Effect exception checks and their generated files                       |
| `tools/e2e`             | Golden journeys, local journey drivers, and legacy migration commands                                 |
| `tools/oxlint`          | Project Oxlint rules                                                                                  |
| `tools/placements-docs` | Placements API reference generation and checks                                                        |
| `tools/postgres`        | Disposable PostgreSQL clusters of the selected major                                                  |
| `tools/scripts`         | Local launcher, Git hook runner, job measurement, preview deployment, changelog                       |
| `tools/source-safety`   | Staged-tree scan for credentials and personal data                                                    |
| `tools/verification`    | Cross-application PostgreSQL proofs and migration rehearsals                                          |
| `infra`                 | Worker preview deployment configuration                                                               |
| `content`               | Hand-written repository-wide documentation pages and the formal models                                |
| `docs`                  | Generated read paths: the Markdown of every documentation page, the construct pages, and llms.txt     |
| `patches`               | Dependency patches that `patchedDependencies` in package.json applies                                 |
| `.github`               | Checks, Tests, Docs, and preview workflows and their actions                                          |
| `.claude`               | Claude Code settings and project rules                                                                |
| `.agents`               | Agent skills of the repository: the Effect house overlay                                              |

Apps and packages never import `tools/`.
Context folders in `packages/domain/src`, `packages/database/src`, `apps/backend/src`, and `apps/dashboard/app/foldkit` carry the kebab-case name of a bounded context in [content/model/contexts.cml](content/model/contexts.cml).
Code that several contexts share lives in `shared-kernel`.
`just layout` checks the tree against [tools/conventions/src/layout.ts](tools/conventions/src/layout.ts), which lists the exceptions and their reasons.
Every app, package, and context folder has an `AGENTS.md` guide and a `CLAUDE.md` that imports it; `just guides write` renders their generated part.
[docs/constructs.md](docs/constructs.md) indexes the shared constructs, and a page per category in [docs/constructs](docs/constructs) holds their contracts; `just constructs write` renders them, and `just constructs consumers <name>` prints the modules that import one.
[tools/conventions/effect-exceptions.json](tools/conventions/effect-exceptions.json) registers each suppression of an Effect rule; `just exceptions` checks it against the sites.

[//]: # "layout: end"

Keep the dependency graph in [docs/architecture.md](docs/architecture.md).
Product packages must not import application source.

## TypeScript conventions

- Use Bun as package manager and runtime unless a target requires Node.
- Use Effect v4 as the application language for effectful code.
- Push concrete runtimes and vendors into Layer implementations.
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

## Delegation and landing

- A writer works in its own worktree and branch, and never pushes.
  The lead lands a branch with `just land <branch>` in the main checkout and pushes separately.
- `just land` refuses a dirty main or worktree and a branch that contains another unlanded branch.
  It always records a merge commit; the pre-merge hook checks the full merged tree before removing the branch worktree. A failed hook aborts and leaves main unchanged.
- A subagent that may run out of budget commits its work in progress on its branch.
  It writes the remaining steps into `content/specs/<slice>.mdx`, never into session-only files.
- A large slice needs an approved design before code.
- A regression fix goes from red to green: observe the failing run before the fix.
  Then close the defect class with a rule or a type, as [Construction over trust](#construction-over-trust) describes.
- A migration that rewrites existing rows needs an upgrade proof.
  Seed data through the previous migration with the code of that time, apply the new migrations, and compare the exact rows, on PGlite and on each supported PostgreSQL major.
- A new journey suite joins `just e2e`, `just golden`, `just proof`, or `just rehearsal`, and the hosted journey matrix.
  `just layout` rejects a Playwright spec or an acceptance probe that no name runs, unless `tools/conventions/src/journeys.ts` excludes it with its reason.
  A check is hermetic: it builds what it serves from the current source, starts its database with `startDisposablePostgres`, and reads no ambient environment.
- A flaky check is a defect. Find the nondeterministic input and fix it. Do not add retries or loosen the assertion.
- Size a delegated slice to finish in about 30 minutes of agent work.
  Run a verification batch as one supervised script that writes a summary file, so that a budget stop keeps its results.
- Observe exit codes and evidence. Never infer them from a summary.

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

| Trusted by convention                                                   | Construction                                                 | Precedent on `main`                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A string names a closed set, and a second value repeats a fact about it | Derive the type and every related fact from one registry     | `NativeProblemRegistry` in `packages/http-api/src/http-semantics.ts` owns code, status, and body; `Problem.make(code)` takes no status. Counter-example: `PlacementFailure` carries a `status` beside its registry `code`.                                                                                                                                            |
| A value is validated at the edge but travels as a plain string          | Decode once to the domain type at the boundary               | Instants belong in `DateTime.Utc`. Counter-example: `compareRfc3339Instants` parses both strings at each call.                                                                                                                                                                                                                                                        |
| A copy of a derived value is kept in sync by hand                       | Generate it, or check it against its source                  | `devenv.nix` reads tool versions from `package.json` and `bun.lock`. It and `.oxfmtrc.json` hold the only hook and formatter definitions.                                                                                                                                                                                                                             |
| A test pins the observed output                                         | Decode the response with the contract schema                 | `apps/dashboard/e2e/receipt-approval.spec.ts` decodes with the exported receipt schemas. Counter-example: suites that re-pinned `credential.invalid` after 042e808d.                                                                                                                                                                                                  |
| An operation reports success when its precondition was lost             | Return a typed failure that the caller must handle           | `OutboxClaimLost` in `packages/database/src/outbox-lifecycle.ts`.                                                                                                                                                                                                                                                                                                     |
| A runtime flag grants test authority                                    | Let only the test composition construct it                   | `decodeReceiptE2EComposition` rejects receipt E2E flags outside the `local` deployment.                                                                                                                                                                                                                                                                               |
| A check exists but nothing runs it                                      | Run it from a hook or CI job                                 | Pre-commit checks only staged paths (format, lint, source-safety). `just land` always makes a merge commit whose hook runs full `just check` and `just test`; pre-push checks direct commits too. `just layout` rejects an unhosted journey.                                                                                                                          |
| A hook depends on a generated file and skips when the file is missing   | Refuse without it, and check it against its source           | The installed hook (`hookShim` in `devenv.nix`) refuses a worktree without its generated `.pre-commit-config.yaml`, and `hook-config-current` rejects one generated from another `devenv.nix`, `devenv.yaml`, or `devenv.lock`. Counter-example: on 2026-09-27 two commits in a new worktree, made before its first `devenv shell`, ran no hook.                      |
| Two branches take one migration number, or an applied migration changes | Check the registry and freeze applied migrations             | `packages/database/src/migration-registry.test.ts` checks ids, positions, and files against `migrations/checksums.json`; `just migration-hashes write` only appends. Select by id with `selectDatabaseMigration`.                                                                                                                                                     |
| A fixed defect class stays possible                                     | Add a lint rule or a type, with a negative control           | `anti-slop/no-json-text-parameter`, `anti-slop/no-raw-advisory-lock-sql`, and `anti-slop/no-literal-window-instant` in `tools/oxlint/anti-slop/rules`. Each test keeps valid negative controls beside the invalid cases.                                                                                                                                              |
| A hard-coded instant expires                                            | Derive it from the journey clock                             | `admissionJourneyClock` and `journeyClock` in `tools/e2e/journey-clock.ts` derive journey instants from `ADMISSION_FIXED_NOW`, the time of the run, or a runner's pin; `anti-slop/no-literal-window-instant` rejects literal window instants in journey code. Counter-example: seeds whose admission period ended on 2026-09-30, fixed in 501b1cbd.                   |
| A service counts as ready once its port accepts TCP                     | Wait for its protocol in the construct that starts it        | `startDisposablePostgres` in `tools/postgres/index.ts` waits until `pg_isready` reports that the server accepts connections; the client-only `PostgresProgram` type and `anti-slop/no-hand-rolled-postgres` reject any other starter. Counter-example: CI run 36224459581, where `createdb` met "the database system is starting up".                                 |
| A journey reads Git history that the hosted checkout lacks              | Bind the source to HEAD and reject history reads             | Hosted journeys check out one commit. Journey code binds its source with `rev-parse HEAD` or `HEAD^{tree}`; `anti-slop/no-git-history` rejects `merge-base`, `log`, ancestors, ranges, and fixed commit names in journey code. Counter-example: CI run 36233895862, where the organization import rehearsal asked for the merge base of a fixed commit.               |
| A journey learns a free port with a probe and releases it               | Reserve ports through the construct and reject probes        | `reserveLoopbackPorts` in `tools/postgres/index.ts` reserves distinct ports below the kernel's ephemeral range; `loopbackPortFree` checks a named port; `anti-slop/no-port-probe` rejects a listen, `address()`, and `close` probe in journey code. Counter-example: run 2 of a batch at aa83bde9, where the backend met `EADDRINUSE` on a probed port.               |
| A check serves a Vite dev server                                        | Serve a build of the current source and reject dev servers   | The dashboard Playwright webServer builds and runs `server.mjs`; `anti-slop/no-dev-server` rejects `vite dev`, `react-router dev`, and `run dev` in journey code and Playwright configs. Counter-example: CI runs 36239270833 and 36239753596, where a cold optimizer cache reloaded the page under `page.goto`.                                                      |
| A view renders an entry's command controls without a key                | Key the element by its entry and reject unkeyed command rows | `anti-slop/no-unkeyed-command-row` requires `h.Key` on a Foldkit element that renders one entry and dispatches messages built from it, whether a `.map` callback or a same-file helper returns it. Counter-example: CI run 36240534206, where a reload reordered the article rows and the "Publiser" control of one article published another.                        |
| An exception to an Effect rule is explained only by its suppression     | Register it and check the registry against its sites         | `just exceptions` checks each suppression of an Effect rule against `tools/conventions/effect-exceptions.json` in both directions and reopens an entry when an examined package changes version. Counter-example: the hand-kept list of the Effect diagnostics specification missed both `effect/no-cross-runtime` suppressions of `real-interview-response.spec.ts`. |
| A check reports findings without failing                                | Report each finding as an error and guard the severities     | `oxlint.config.ts` reports every Effect rule as an error, type-aware; `tools/conventions/tests/oxlint-groups.test.ts` rejects an override that relaxes one. Counter-example: CI run 36240534206, where `tsc` printed 926 Effect suggestion lines that nobody acted on.                                                                                                |

## Verification and resources

Use the configured rules in `oxlint.config.ts`. Do not copy their rule inventory into prose or suppress a failure.
Use existing typed test Layers or disposable infrastructure. Do not substitute module mocks or SDK echoes for a real boundary.
Keep regression tests for plausible behavior failures, not field forwarding, source text, or incidental wording.
Use disposable probes for other implementation observations.

For property checks, generate reachable command sequences and assert business invariants.
Use the installed Arbitrary API with bounded runs, deterministic seeds, and typed options.
Valid schema generation does not cover malformed wire input.

Full end-to-end suites dominate machine load: the golden journeys (`just golden <journey>`) and their CI wrappers,
`just proof delivery-recovery`, and the browser suites (`just e2e <suite>`).
Any agent may run one, but only through `just measure`, so that the heavy lock admits one at a time.

Heavy jobs are real PostgreSQL tests, browser suites and the servers they start, JVM model checks, `just check`, `just check-types`, `just lint`, and `just test`.
Run every heavy job through `just measure --class <class> -- <command...>`. `just model` does so itself.
`just measure` holds the heavy lock while its command runs, an exclusive `flock` lock on `${XDG_RUNTIME_DIR:-/tmp}/vektorprogrammet/heavy.lock`.
The lock is per machine and user: every worktree and every agent shares it, so one heavy job runs at a time.
Hook jobs hold the same lock shared. A heavy job waits for the running hook jobs, and hook jobs that start later wait for the heavy job.
A waiting job shows each holder: process id, class, start time, directory, and command.
The lock belongs to the `just measure` process. It is released when that process exits, also on a signal or `kill -9`.
The job's processes inherit `VEKTORPROGRAMMET_HEAVY_LOCK`, the process id of the holder.
A `just measure` or hook job inside a job that holds the lock, such as the hooks of a commit, runs without taking it again.
Setting that variable by hand bypasses the lock. Only the lead does that, to run a job beside the holder on purpose.
A service that runs until it is stopped, such as `devenv up`, does not run through `just measure`, because it would hold the lock until it stops.

`just measure` records the resource use of each job in `${XDG_STATE_HOME:-~/.local/state}/vektorprogrammet/job-ledger.jsonl`.
The ledger is machine runtime evidence. Do not commit it.
`just measure --report` shows the peak RSS and cores of each class beside the free memory and load of the machine.

Every hook stage first needs the hook configuration that `devenv shell` generates in each worktree: without it, commits, merges, and pushes there fail and name the command; one generated from another `devenv.nix`, `devenv.yaml`, or `devenv.lock` fails the same way.
Pre-commit checks only changed staged paths: the conflict-marker check, one serial Oxfmt invocation with `--threads=2`, one `lint-files` invocation with `--threads=2` for staged JS/TS (no route typegen, in a hook slot), and `source-safety --changed` over changed index blobs. It runs no tests, type checks, or whole-tree convention checks. `.oxfmtrc.json` controls format scope; Oxfmt and Oxlint have no config-file key for thread count in their installed versions, so their recipes pass the bounded CLI flag.
`just land` always records a merge commit. The pre-merge-commit hook runs `just check --concurrency=1` then `just test --concurrency=1` on the merged tree under `just measure` (exclusive heavy lock). A failed hook aborts the merge. Pre-push runs full `just check` and affected tests, including changes committed directly on main.
The shared `vitest.shared.ts` configuration bounds every workspace Vitest invocation to at most four workers (or one less than available CPUs, whichever is smaller). `just layout` rejects a workspace with a Vitest script but no merged shared config. Its global setup admits a standalone run through the machine-wide shared heavy lock and a hook slot; a run already under `just measure` or `just hook-slot` does not acquire the lock again. Explicit `--maxWorkers` is still an override.
Each hook slot pins its job to 1/N of the allowed CPUs. The lint hook runs only when the staged change includes JavaScript or TypeScript; formatting and source-safety take no slot. The ledger records hook jobs as `hook-*` classes.

Type-aware `just lint` builds a TypeScript program for each project that it lints.
Measured on this machine on `08865605` with the wiring: the whole tree takes 20 s, 3.3 GiB peak RSS, and 9 peak cores, route type generation included; plain lint took 3 s and 0.3 GiB.
In a hook slot (6 CPUs), the lint hook runs as one process: on every file it takes 21 s and 3.2 GiB, on five staged files in five packages 5 s and 1.0 GiB, and on one file 3 s and 0.4 GiB.

`VEKTORPROGRAMMET_HOOK_SLOTS` sets N. The default is 5.
Derive N for a machine as slots = min(memory bound, CPU bound), and use at least 1.
The memory bound is the usable memory divided by the peak RSS of the heaviest hook job.
Usable memory is the typical `MemAvailable` minus 20% of `MemTotal`.
The CPU bound keeps at least 6 CPUs for each job, because the test suites have 5-second timeouts.
On this machine, the memory bound is 23.5 GiB / 3.2 GiB (the lint hook on every file) = 7 and the CPU bound is 32 / 6 = 5.

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
