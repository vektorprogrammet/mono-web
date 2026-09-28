# Command grammar

Status: frozen design on 2026-09-27, from the operator decision of 2026-09-27. No implementation.
The lead settles the [open questions](#open-questions-for-the-lead); a settled answer changes this file before code does.
Remove this specification when the registry, the runner, the hooks, and CI run the grammar, and `AGENTS.md`, `README.md`, and the effect-house overlay describe it.

## Handoff (2026-09-27)

The operator paused this slice for a handoff to a new lead. This section records the state at the handoff. Remove it when the open questions are answered and this file is landed.

- **State.** Design only. The branch `docs/command-grammar-0927` holds this file in commits on top of `main` at `b3193cb1`. `main` was at `88b5281e` at the handoff. The branch is not landed and not pushed.
- **Next step.** The lead answers the [open questions](#open-questions-for-the-lead) and writes each answer into this file. Then the lead rebases the branch onto `main` and lands it with `just land docs/command-grammar-0927`. The branch changes only this file.
- **After landing.** Implementation starts when the schema collapse branch has landed and the landing queue is empty, in the window of the mono-web heavy-admit cutover ([Cutover](#cutover)). Its first step is the registry and the runner with `--plan`, with falsifiers F4 to F9, F16, and F17 on a scratch repository. Hooks, workflows, and callers change only after that step passes.
- **Review.** Nobody has reviewed this file. No review finding is open.
- **Known gaps for the review:**
  1. The package `test` scripts of `packages/domain` and `apps/dashboard` also run fixture programs, D1 proofs, and the preview bundle gate (`AGENTS.md`, section Commands). This file does not assign them to `test:unit` or `test:pg`.
  2. The families come from the heavy-admit design, which is proposed. Its C2 family names can change before it freezes, and its queue order is an open operator decision.
  3. This file does not name the `changed` inputs of the two `model` targets. The obvious ones are `docs/model/authority.als`, `docs/model/contexts.cml`, and `tools/scripts/model.ts`.
- **Verified:**
  - The commit `45094472`, which added this file: `git commit` exited 0 with the hooks on, after `devenv shell -- true`. `hook-config-current`, `check-merge-conflicts`, `format`, and `source-safety` passed, and `lint` skipped because no JavaScript or TypeScript path was staged. `.oxfmtrc.json` excludes `docs/specs/`, so the format hook did not examine this file.
  - A scan of this file outside code found no `<`, `>`, `{`, or `}` that MDX can read as markup.
  - E1 to E3: just 1.58.0 of the devenv shell, on scratch justfiles in `/tmp`, since deleted. Exit 0 for `just check lint --staged` and `just check::lint --staged` under `mod check`. Exit 1 for `just check --staged` under `mod check`, for a recipe named `check:lint`, for a module and a recipe with one name, and for `just check::lint` with a `check *args` recipe.
  - E9, E16, and E17: Turbo 2.8.13, the locked binary of the main checkout, in scratch repositories in `/tmp`, since deleted, and its source at tag `v2.8.13` (commit `0c5af8fb`). A research subagent ran these experiments. Nobody repeated them.
  - E8 to E10: the ledger on 2026-09-27, 3411 rows.
  - E4 to E7 and E11 to E15: the repository at `8d1b7e09` and `b3193cb1`.
- **Not verified:**
  - No implementation exists, so no falsifier (F1 to F18) exists or ran.
  - `just docs build`, which builds the site and checks its links, did not run with this file. `just layout` did not run; its mention check skips `docs/specs/`.
  - No pre-push or pre-merge hook ran on this branch.
  - The value of `PRE_COMMIT_FROM_REF` for a new branch (E7) was observed once, with prek 0.5.2.
- **Decisions waiting.** The lead decides open questions 1 to 11, and question 7 together with the heavy-admit lead. Questions 2 and 3 change an operator decision or the verification policy, so the lead decides whether they need the operator. The slice also waits for the schema collapse branch and for the heavy-admit design.

## Goal

One grammar names every verification command, and one typed registry declares it.
The justfile recipes, the Git hooks, the hosted CI matrix, the command tables, and the ledger classes derive from the registry.
A derived file that differs from the registry fails a check, or cannot differ because it is generated.

## Operator decision (2026-09-27)

| Axis    | Values                                                                                                                                                     | Spelling                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| verb    | `check` (static properties), `test` (executed behaviour)                                                                                                   | first word after `just`                    |
| kind    | check: `format`, `lint`, `types`, `conventions`, `safety`, `duplication`, `surface`, `model`; test: `unit`, `pg`, `e2e`, `golden`, `proof`, `mutation`       | second word                                |
| scope   | `staged`, `changed`, `all`                                                                                                                                 | `--staged`, `--changed`, `--all`           |
| package | workspace packages, in Turbo's own filter syntax: `pkg`, `...pkg` (dependents), `pkg...` (dependencies), `!pkg`, `{dir}`                                  | `--filter=<value>`, repeatable             |
| target  | a suite, journey, proof, or model of a kind that has them, such as `e2e onboarding` and `golden team-application`                                          | third word                                 |

`conventions` covers the layout, construct, guide, and Effect exception checks. `model` is the Alloy check, which is static.
`mutation` tests the tests.

## Evidence

Observed on 2026-09-27 at `8d1b7e09` and at `b3193cb1`, which adds the hook configuration check of `5f734424`, unless the row names another source.

| #   | Observation                                                                                                                                                                                                                                                                                                                                              | Source                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| E1  | just 1.58.0 rejects a colon in a recipe name: `check:lint:` fails with "expected '&&', '*', '::', comment, end of file, end of line, identifier, indent, or '(', but found ':'".                                                                                                                                                                         | scratch justfile, `just --list`                                                                           |
| E2  | With `mod check`, both `just check lint --staged` and `just check::lint --staged` run the same recipe. `just check --staged` fails with "justfile does not contain recipe `check --staged`". A module recipe runs in the directory of its module file unless `[no-cd]` or `set working-directory` moves it. A module and a recipe cannot share a name. | scratch justfiles; [just manual, Modules](https://github.com/casey/just/blob/1.58.0/README.md#modules)   |
| E3  | With `set positional-arguments` and `check *args`, `just check lint --staged --filter=@x/y` passes every word to the recipe, `--help` and `--` included, and `just check::lint` fails with "expected submodule at `check` but found recipe".                                                                                                          | scratch justfile                                                                                          |
| E4  | The justfile has 28 public recipes in the groups check, develop, hooks, journeys, and migration. Four journey recipes carry closed name sets in `case` statements: 27 `e2e` suites, 4 `golden` journeys, 3 `proof` names, and 8 `rehearsal` names. `tools/conventions` reads them through `just --dump` and renders the command table from the dump.         | `justfile`; `tools/conventions/src/justfile.ts`; `tools/conventions/src/sections.ts:97-101`               |
| E5  | The Tests workflow hosts 34 generated matrix legs (3 golden, 25 e2e, 3 proof, 3 rehearsal) and 3 own jobs (`golden school-service`, `e2e identity`, `e2e applicant`). Five rehearsals are excluded because they need the legacy-data profile.                                                                                                        | `.github/workflows/tests.yml:145-181`; `tools/conventions/src/journeys.ts:63-138`                         |
| E6  | Hooks: pre-commit runs a configuration check, the stock conflict-marker check, `just format --check` on the staged paths that prek passes, `just lint-files` in a hook slot, and `just source-safety --changed`. Pre-push runs the configuration check, `just check --concurrency=1`, and `just test --affected --concurrency=1` in hook slots. Pre-merge-commit runs the configuration check against `HEAD`, the conflict-marker check, and `just check --concurrency=1 && just test --concurrency=1` under `just measure`. | `devenv.nix:239-313` at `b3193cb1` |
| E7  | Prek reduces the working tree to the staged content during pre-commit. It exports `PRE_COMMIT_FROM_REF` and `PRE_COMMIT_TO_REF` to push-style hooks; for a branch that the remote lacks, prek 0.5.2 set `PRE_COMMIT_FROM_REF` to the parent of the first unpushed commit. | `devenv.nix:134-138` at `b3193cb1`; [prek 0.5 environment variables](https://prek.j178.dev/0.5.0/reference/environment-variables/); a prek 0.5.2 pre-push hook in a scratch repository |
| E8  | The ledger held 3411 rows under 570 distinct class names from 2026-09-25 to 2026-09-27. `measure-job.ts` accepts any kebab-case class.                                                                                                                                                                                                                 | `~/.local/state/vektorprogrammet/job-ledger.jsonl`; `tools/scripts/measure-job.ts:35,341-342`             |
| E9  | 122 of the 123 `hook-pre-push-test` rows ran in the main checkout, and all but one ended within about 1 s. With `HEAD` at `main` and unpushed commits, `--affected` with its default base `main` selected nothing, because the merge base of `main` and `HEAD` is `HEAD`. With `TURBO_SCM_BASE=$PRE_COMMIT_FROM_REF` inside a prek pre-push hook, it selected the pushed changes. | ledger; [`git.rs`](https://github.com/vercel/turborepo/blob/v2.8.13/crates/turborepo-scm/src/git.rs#L272-L275); scratch-repository runs of the locked binary |
| E10 | `just model check` took 584 s at the median over 4 runs. No hook and no CI job runs `just model`.                                                                                                                                                                                                                                                      | ledger class `model-check`; `devenv.nix`; `.github/workflows/*.yml`                                       |
| E11 | These CI steps verify without `just`: two `bun test` files (`tools/placements-docs/placements-artifact.test.mjs`, `tools/e2e/golden-school-service-evidence.test.ts`), the golden school-service CI wrapper, the placements reference steps (also in the Docs workflow), and `proof:receipt`, `proof:identity-postgres`, and a focused `auth-live` test, which read a PostgreSQL service container. | `.github/workflows/tests.yml:60-69,106-120,278-281,324-341`; `.github/workflows/docs.yml:44-48` |
| E12 | `packages/database` has 11 `proof:*` and 3 `trace:*` scripts. CI runs `proof:receipt` and `proof:identity-postgres`. `just proof` runs `authorization-rules` and `rule-reconciliation`, which start their own cluster. No hook or CI job runs the other 8 proofs or 2 traces, which read database URLs from the environment.                     | `packages/database/package.json`; `packages/database/runtime/*-main.ts`                                   |
| E13 | Seven packages have a `lint` script and `turbo.json` has a `lint` task, but no recipe, hook, or workflow runs `turbo lint`. `just lint` runs one root Oxlint process over the tree.                                                                                                                                                                    | package manifests; `turbo.json:15-17`; `justfile:91-94`                                                   |
| E14 | Five test files start a real PostgreSQL cluster: `apps/backend/src/rpc/receipt-transaction.test.ts` (through `apps/backend/test/postgres.ts`), three in `packages/database/src`, and one in `tools/postgres`. The other suites use PGlite or no database.                                                                                         | `git grep startDisposablePostgres\|withDisposablePostgres`                                                |
| E15 | In a worktree without `node_modules`, `bun x turbo --version` fetched and ran Turbo 2.11.4. `bun.lock` resolves Turbo 2.8.13. The recipes `build`, `check`, `check-types`, and `test` call `bun x turbo`, and `format` and `lint-files` call `bun x oxfmt` and `bun x oxlint`.                                                                         | this worktree before `bun install`; `bun.lock:2764`; `justfile`                                           |
| E16 | Turbo 2.8.13, the locked version, selects for `--affected` the changed packages and their transitive dependents. Changed paths are `git diff-tree --merge-base <base> <head>` plus the staged, unstaged, and untracked paths, always. The base is `TURBO_SCM_BASE`, else the event base on GitHub Actions, else local `main`, then `master`. A missing default base, an unknown commit, or a shallow history selects every package with a warning and exit 0. An unknown ref name in `TURBO_SCM_BASE` exits 1. `--affected` with `--filter` exits 1; from 2.9.4 on, it intersects. Task `inputs` do not change selection. No mode selects the index alone. With the base given as a merge-base commit, `--filter=...[<commit>]` selected the same packages as `--affected` in clean and dirty trees. Inside a package directory, Turbo adds that package to every selector. | [run reference](https://github.com/vercel/turborepo/blob/v2.8.13/apps/docs/content/docs/reference/run.mdx#L41-L68); [`git.rs`](https://github.com/vercel/turborepo/blob/v2.8.13/crates/turborepo-scm/src/git.rs#L51-L342); [`filter.rs`](https://github.com/vercel/turborepo/blob/v2.8.13/crates/turborepo-scope/src/filter.rs#L209-L260); [`cli/mod.rs`](https://github.com/vercel/turborepo/blob/v2.8.13/crates/turborepo-lib/src/cli/mod.rs#L867-L877); [`target_selector.rs`](https://github.com/vercel/turborepo/blob/v2.8.13/crates/turborepo-scope/src/target_selector.rs#L180-L203); scratch-repository runs of the locked binary (not committed) |
| E17 | A change to root `package.json`, `turbo.json`, or `turbo.jsonc` selects every package. Another path outside the packages selects every package only when `globalDependencies` matches it; otherwise it selects the root package `//`, which runs nothing because `turbo.json` defines no root task. `turbo.json` has no `globalDependencies`, yet eleven workspace `tsconfig.json` files extend the root `tsconfig.json`, and nine Vitest configurations import `vitest.shared.ts`. A `bun.lock` change selects the packages whose dependency closure changed; in a scratch copy of mono-web, a change to `vocs` alone also selected `@monoweb/dashboard`. | [`change_mapper/mod.rs`](https://github.com/vercel/turborepo/blob/v2.8.13/crates/turborepo-repository/src/change_mapper/mod.rs#L127-L260); [`package_graph/mod.rs`](https://github.com/vercel/turborepo/blob/v2.8.13/crates/turborepo-repository/src/package_graph/mod.rs#L459-L562); [`configuration.mdx`](https://github.com/vercel/turborepo/blob/v2.8.13/apps/docs/content/docs/reference/configuration.mdx#L36-L61); `turbo.json`; `git grep` of `extends` and `vitest.shared` |

## Grammar

```text
just <verb> [<kind>] (--staged | --changed | --all) [--filter=<turbo filter>]... [--plan]
just <verb> <kind> <target> [--plan]
```

1. **One selector.** A command selects by one scope or by one target, never both and never neither.
2. **Aggregate.** Without a kind, the command runs every kind of the verb that supports the scope, in registry order. An aggregate takes no target and no `--filter`.
3. **Order.** The positional words come first, then the flags. Each flag appears once, except `--filter`.
4. **One spelling.** There are no aliases. The runner rejects `-F`, `--filter <value>` with a space, `--affected`, `--`, any other Turbo option, an abbreviated word, and a positional word after a flag. just itself rejects `just check::lint` (E3).
5. **Package axis.** `--filter` is valid only with a package-aware kind at `--changed` or `--all`. Turbo resolves each value, and several values form a union. A value that names a Git range (`[…]`) is a usage error, because the scope selects by change. Values that together select no package are a usage error.
6. **Plan.** `--plan` prints the resolved plan as JSON and runs nothing: the base commit, and for each step its entry, packages, files, argv, class, and family.
7. **Exit status.** A run exits with the status of the first failing step, and stops there. A command line that does not parse against the registry exits 64 and lists the valid words at the failing position. A tree that does not match the scope, or a base that does not resolve, exits 65 and names the cause ([Exactness](#exactness)).

| Command                                                  | Runs                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `just check --staged`                                    | every check kind that supports `staged`: the pre-commit stage                                |
| `just check lint --changed`                              | Oxlint over the packages that the change affects                                             |
| `just check types --all --filter=@vektorprogrammet/domain...` | the type checks of `domain` and its dependencies                                        |
| `just test --changed`                                    | `unit` and `pg` of the affected packages: the test part of the pre-push stage                |
| `just test pg --all`                                     | every real PostgreSQL suite, the lane that CI runs on each supported PostgreSQL major        |
| `just test e2e onboarding`                               | one browser suite                                                                            |
| `just check model authority`                             | the Alloy commands of `docs/model/authority.als`                                             |
| `just check lint`                                        | exit 64: no scope and no target; the message lists `--staged`, `--changed`, and `--all`      |
| `just test e2e`                                          | exit 64: `e2e` selects by target only; the message lists the 27 suites                       |
| `just check format --all --filter=web`                   | exit 64: `format` is not package-aware                                                       |

## Syntax decision: positional arguments

The grammar uses two plain recipes, `check *args` and `test *args`, with `set positional-arguments`. Each passes its words to one runner, which parses them against the registry.

| Criterion                                   | just modules (`mod check`, a recipe per kind)                                        | Positional arguments (`check *args`)                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| One spelling                                | No: just accepts `check lint` and `check::lint` for every recipe (E2)                | Yes: `check::lint` fails (E3)                                               |
| Aggregate `just check --staged`             | Not expressible (E2); it needs a pseudo-kind such as `check all --staged`            | Expressible                                                                 |
| Unknown kind                                | just fails before the runner starts                                                  | The runner exits 64 and lists the kinds                                     |
| Kinds in `just --list`                      | Only with `--list-submodules`                                                        | In the generated doc comment of each verb recipe                            |
| Working directory                           | The module file's directory, unless every module sets `working-directory` (E2)       | The justfile directory                                                      |
| Both at once                                | Impossible: a module and a recipe cannot share a name (E2)                           | –                                                                           |

The first two rows decide. Modules give every command a second spelling that the repository cannot turn off, and they cannot express the aggregates that the hooks call.
just 1.58 can validate recipe arguments with `[arg(pattern=…)]` and declare long options with `[arg(long)]`. The recipes do not use them: the runner parses and validates once, from the registry, and prints the help (`just check --help`).

## Scopes

| Scope     | Selects                                                                                                     | Stage                        |
| --------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `staged`  | The paths that the index changes against `HEAD` (added, copied, modified, renamed; not deleted), with their index content. | pre-commit                   |
| `changed` | The paths that differ between the merge base and the working tree: committed since the merge base, staged, unstaged, and untracked. For package entries, the packages that own those paths, with their dependents. | pre-push                     |
| `all`     | Every tracked path and every workspace package.                                                             | pre-merge-commit, hosted CI  |

### Selection modes

Each supported scope of an entry declares one mode.

| Mode       | Meaning                                                                                                                                                                                              | Entries                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `files`    | The runner passes the selected paths that match the entry's pattern to one tool process. When no path matches, the step reports that it has nothing to do and succeeds.                             | `format`, `lint` at `staged`, `safety`               |
| `packages` | Turbo selects the packages. The runner then runs a Turbo task over them, or one tool process over their directories. The entry is package-aware.                                                    | `types`, `unit`, `pg`, `lint` at `changed` and `all` |
| `tree`     | The tool reads the whole tree: the index view at `staged`, the working tree otherwise. An optional trigger pattern runs the step only when the selected change touches it.                           | `conventions`, `duplication`, `surface`, `model` at `changed` |

`lint` is package-aware at `changed` because a type-aware rule in a dependent package can fail when a dependency's types change.
Turbo selects the affected packages with their dependents, and one Oxlint process lints their directories after route type generation.
The per-package `lint` scripts and the Turbo `lint` task go (E13), so the tree has one lint path.

### Base commit of `--changed`

The runner resolves the base once:

1. `TURBO_SCM_BASE`, when it is set and not empty.
2. `PRE_COMMIT_FROM_REF`, when prek runs a push-style hook and the value is neither empty nor all zeros (E7).
3. `main` otherwise.

It then computes the merge base of that commit and `HEAD`, once. If either step fails, the run exits 65. It never falls back to every package, as Turbo does silently for some of these failures (E16).
Turbo's package selection and the runner's path selection both use this merge base ([Turbo mapping](#turbo-mapping)).
The second rule corrects E9: a push of `main` compares with the remote state of `main`, not with `main` itself.

### Exactness

- **`staged` outside prek.** The tools of `files` and `tree` entries read the working tree. If a selected path has unstaged changes, the run exits 65 and names the paths. During pre-commit, prek sets unstaged changes aside (E7), so the hook always meets this rule. `safety` reads index blobs and is exact in both cases.
- **`changed` in pre-push.** The push sends commits, but Turbo adds uncommitted and untracked paths to every selection, and every tool reads the working tree (E16). If `HEAD` differs from `PRE_COMMIT_TO_REF`, or `git status --porcelain` reports any path, the run exits 65. `README.md` already asks for a clean worktree before a push.

## Turbo mapping

Turbo selects packages, never paths. The runner maps each scope as below, and it always runs Turbo from the repository root, because inside a package directory Turbo adds that package to every selector (E16).

| Scope     | Package entries                                     | File and tree entries                                                                                                                                                                                                   |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staged`  | not supported                                       | `git diff --cached --name-only --diff-filter=d -z`, with index content                                                                                                                                                  |
| `changed` | `turbo run <task> --filter=...[<merge-base>]`       | the same merge base, with Turbo's own three Git queries: `git diff-tree -r --name-only --no-commit-id -z <merge-base> HEAD`, `git ls-files --others --modified --exclude-standard -z`, and `git diff --name-only --cached -z`, without deleted paths |
| `all`     | `turbo run <task>`, without a filter                | every tracked path that the entry's pattern matches, or the tool's own walk of the tree                                                                                                                                 |

**`...[<merge-base>]`, not `--affected`.** Turbo documents `--affected` as `--filter=...[main...HEAD]`, and with the base given as a merge-base commit the two selected the same packages in clean and dirty trees (E16). The explicit form wins on four points in 2.8.13:

1. It composes with the package axis. `--affected` with `--filter` exits 1 in 2.8.13 and intersects from 2.9.4 on, so one command line would change its meaning with the Turbo version.
2. It fails loudly. `--affected` selects every package with exit 0 when the base is missing or the history is shallow.
3. It reads the previous `bun.lock` at the merge base. `--affected` reads it at the tip of the base, which over-selects when `main` changed the lockfile after the branch point.
4. It never falls back to the default base `main`, which selects nothing when `HEAD` is `main` (E9).

**Package axis at `changed`.** The runner reads two selections from Turbo's dry run (`turbo run <task> --dry=json`, field `packages`): the change selection above, and the union of the `--filter` values. It runs the task over their intersection, with one `--filter=<name>` per package. Turbo 2.9.4 and later compute the same intersection for `--affected --filter`. An empty intersection is a step with nothing to do. `turbo ls --output=json` gives the same data, but 2.8.13 marks it experimental.

**Selection and execution.** The scope selects packages. Turbo still adds the tasks that `dependsOn` names, such as `generate` before `check-types`, and replays a selected task whose hash matches a cached run.

**Root inputs.** A path outside every package selects only the root package `//`, unless `globalDependencies` matches it (E17). The cutover adds `tsconfig.json` and `vitest.shared.ts` to `globalDependencies`: a change to either then selects every package, and it enters every task hash, which today it does not. `check conventions` fails when a workspace `tsconfig*.json` extends, or a Vitest configuration imports, a root file that `globalDependencies` lacks.
An entry whose tool reads configuration outside the packages that it examines declares that configuration as `widenOn`: `.oxfmtrc.json` for `format`, `oxlint.config.ts` and `tools/oxlint` for `lint`, and `tools/source-safety` for `safety`. A change there makes `changed` select everything for that entry. A Turbo-task entry has no `widenOn`, because its root inputs belong in `globalDependencies`, where Turbo's cache sees them too.

**Where Turbo cannot express a scope.**

- `staged`, for every kind. Turbo has no index-only selection: `[HEAD]` adds unstaged and untracked paths, and inside prek's pre-commit the untracked paths still enter (E16). The runner reads the index.
- Paths, at every scope. `format`, `safety`, and `lint` at `staged` run on files, and Turbo 2.8.13 does not expose its list of changed paths. The runner repeats Turbo's Git queries with the same merge base.
- A pushed commit that is not checked out. Turbo tasks run on the working tree, so pre-push requires the clean tree of [Exactness](#exactness).
- A root file outside `globalDependencies`. It selects `//`, which runs nothing.

## Kinds at cutover

The registry holds the kinds that have an implementation. `duplication` and `surface` join with their specifications ([repository conventions](repository-conventions.md#duplication), [public surface](public-surface.md)), under the names and scopes below. `mutation` joins with a specification of its own. Until then, each is an unknown kind and exits 64.

| Kind                | `staged`                              | `changed`                                            | `all`                              | Targets                                                                                     | Package-aware       | Family                                   | Writer                   |
| ------------------- | ------------------------------------- | ---------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------- | ------------------------ |
| `check format`      | files: Oxfmt `--check` on staged paths | files: Oxfmt `--check` on changed paths             | tree: Oxfmt `--check`              | –                                                                                           | no                  | light                                    | `just write format`      |
| `check lint`        | files: Oxlint on staged JS/TS paths   | packages: Oxlint over affected package directories   | packages: Oxlint over the tree     | –                                                                                           | at `changed`, `all` | `hook` / `lint` / `lint`                 | –                        |
| `check types`       | –                                     | packages: Turbo `check-types` over the change selection | packages: Turbo `check-types`   | –                                                                                           | yes                 | `types`                                  | –                        |
| `check conventions` | –                                     | tree                                                 | tree                               | –                                                                                           | no                  | light                                    | `just write conventions` |
| `check safety`      | files: index blobs of staged paths    | files: the blobs that each commit since the merge base adds, and uncommitted paths | tree: the whole index | –                                                                          | no                  | light                                    | –                        |
| `check model`       | –                                     | tree, per target, when the target's inputs changed   | –                                  | `authority` (Alloy, `solver`), `contexts` (Context Mapper, light)                            | no                  | per target                               | –                        |
| `check duplication` | tree: index snapshot, trigger JS/TS/CSS | tree, trigger JS/TS/CSS                            | tree                               | –                                                                                           | no                  | light                                    | `just write duplication` |
| `check surface`     | tree                                  | tree                                                 | tree                               | –                                                                                           | no                  | light (to measure)                       | –                        |
| `test unit`         | –                                     | packages: Turbo `test:unit` over the change selection | packages: Turbo `test:unit`      | –                                                                                           | yes                 | `unit`                                   | –                        |
| `test pg`           | –                                     | packages: Turbo `test:pg` over the change selection  | packages: Turbo `test:pg`          | –                                                                                           | yes                 | `postgres`                               | –                        |
| `test e2e`          | –                                     | –                                                    | –                                  | the 27 suites of `just e2e`                                                                 | no                  | `browser`                                | –                        |
| `test golden`       | –                                     | –                                                    | –                                  | `school-service`, `recruitment`, `reimbursement`, `team-application`                        | no                  | `browser`                                | –                        |
| `test proof`        | –                                     | –                                                    | –                                  | the names of `just proof` after the schema collapse; today `authorization-rules`, `delivery-recovery`, `rule-reconciliation` | no | `postgres` (calibrate `delivery-recovery`) | – |

The migration manifest is not part of `conventions`. The schema collapse branch deletes the numbered migrations, their checksums, the migration registry, `just migration-hashes`, and the upgrade proofs, and it lands before this cutover (operator decision, 2026-09-27).
`model` has no `all` scope: its Alloy check takes about ten minutes (E10), so the pre-merge stage does not run it. The pre-push stage runs a model target when its inputs change, and CI hosts both targets.
`test unit` and `test pg` replace the package `test` task. A test file that starts a real PostgreSQL cluster (E14) carries the suffix `.pg.test.ts`, and only the `test:pg` script of its package runs it. A lint rule rejects `startDisposablePostgres`, `withDisposablePostgres`, and `apps/backend/test/postgres.ts` in any other test file, with a negative control.

## The registry

### Location

The registry is `tools/conventions/src/commands.ts`, a typed declaration like `layout.ts`.
It takes over the hosting declarations of `journeys.ts`: the journey recipes, own jobs, exclusions, evidence scripts, and run files.
The run-file check of `journeys.ts` stays, and reads each target's argv from the registry instead of a `case` branch of the justfile.
One runner, `tools/scripts/commands.ts`, parses a command line against the registry and runs it.

### What an entry declares

| Field     | Meaning                                                                                                                              | Constraint                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `verb`    | `check` or `test`                                                                                                                    | closed union                                                         |
| `kind`    | the kind name                                                                                                                        | kebab-case, unique per verb, never a scope name                      |
| `summary` | one sentence for the tables and the recipe doc                                                                                       | –                                                                    |
| `scopes`  | per supported scope: the mode, the tool argv or Turbo task, the path pattern or trigger, the Turbo options (such as `concurrency: 1`), and the family | `packages` never at `staged`                                         |
| `widenOn` | per `files` scope, or `packages` scope that runs a tool: the configuration paths whose change makes `changed` select everything      | never on a Turbo-task scope ([Turbo mapping](#turbo-mapping))        |
| `targets` | per target: name, argv, family, input paths (for `--changed`), devenv profile, and hosting                                          | kebab-case names, unique per kind, never a scope name                |
| `hosting` | per target: a leg of a generated matrix, an own job (job id and reason), or not hosted (a reason, or the profile that no hosted leg has) | exactly one                                                        |
| `slice`   | the family of an ad hoc run of one part of the kind, such as one Vitest file                                                         | –                                                                    |
| `writer`  | the argv of the write operation                                                                                                      | only on check entries                                                |

The registry also declares, once:

- **The stage table.** `pre-commit` runs `check` at `staged`. `pre-push` runs `check`, then `test`, at `changed`. `pre-merge-commit` runs `check`, then `test`, at `all`.
- **The CI aggregate steps.** The Checks job runs `just check --all`. The Tests `ts` job runs `just test --all` on the default PostgreSQL major and `just test pg --all` on every other supported major.
- **The operations outside the grammar that need a class or hosting.** `rehearsal` (its targets, profiles, and hosting), and each other recipe that runs a heavy job, today `build` and `migration`, with a class and a family each.

Derived facts are never declared: the stages of an entry (from its scopes and the stage table), whether it is package-aware (a `packages` mode), whether CI hosts it (an `all` scope through the aggregate steps, or its target hosting), and its ledger classes.

### Invariants

The types of the registry enforce these where they can, and a registry test enforces the rest:

1. Every entry supports `all` or has targets, and every target is hosted or excluded with its reason. So no check exists that nothing runs.
2. A family is a name of the closed heavy-admit set, or `light`.
3. A writer belongs to a check entry.
4. Verbs, kinds, targets, and operations are kebab-case and unique within their parent.

### Derivations

| Derived artifact                                                                                   | How it derives                                                                                          | Enforcement                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| justfile section `commands`: the recipes `check`, `test`, `write`, and `rehearsal` and their doc comments | `just write conventions` splices it between marker comments                                   | `check conventions` fails when the section differs                                                                                                            |
| devenv hook definitions                                                                            | `just write conventions` renders `tools/conventions/hooks.json` from the stage table. `devenv.nix` maps each entry into `git-hooks.hooks` with `lib.importJSON` | generated. `check conventions` fails when the file differs, and when the hook configuration that `devenv shell` generated holds a hook that is neither in the file nor one of the fixed hooks ([Hooks](#hooks)) |
| the target matrices of the Tests workflow: one for test and rehearsal targets, one for check targets | spliced sections, as the journey legs are today                                                   | `check conventions` fails when a section differs, when an own job is missing, and when a workflow runs a `just` command that does not parse                  |
| CI aggregate steps                                                                                 | written by hand                                                                                         | `check conventions` fails when a declared aggregate step is missing from its job                                                                              |
| `README.md` and `AGENTS.md` command tables                                                         | spliced: the verification table from the registry, the operations table from the other recipes of the justfile | `check conventions` fails when a table differs                                                                                                        |
| hosted-journeys section of `docs/web-system-functional-testing.md`                                 | spliced from the target hosting                                                                         | `check conventions` fails when the section differs                                                                                                            |
| ledger classes and their families                                                                  | a function of the registry ([Admission and ledger](#admission-and-ledger))                              | `--class` decodes against the closed class union; an unknown class exits 64                                                                                   |
| command mentions in Markdown, workflows, and the hook configuration                                | –                                                                                                       | `check conventions` parses each `just …` mention against the grammar, not only the recipe name                                                               |

## Hooks

| Stage              | Hooks in order                                                                        |
| ------------------ | ------------------------------------------------------------------------------------- |
| `pre-commit`       | `hook-config-current`, `check-merge-conflicts`, `just check --staged`                 |
| `pre-push`         | `hook-config-current`, `just check --changed` (fail fast), `just test --changed`      |
| `pre-merge-commit` | `hook-config-current-merge`, `check-merge-conflicts`, `just check --all` (fail fast), `just test --all` |

- The grammar hooks come from `tools/conventions/hooks.json`. Each hook runs one aggregate, so a new entry joins its stages through its scopes, and the file does not change.
- The configuration check and the stock conflict-marker check stay fixed in `devenv.nix`, as the exceptions that it already declares: the configuration check must not depend on the configuration's tools (E6), and the conflict-marker check is a stock prek hook.
- `hooks.json` joins `hookSources` in `devenv.nix`, so a worktree whose hook configuration came from another `hooks.json` fails with the instruction to run `devenv shell -- true`.
- The hook slots, the `--concurrency=1` arguments, and the `just measure` wrapper of pre-merge go. Each heavy step admits itself with its family, and Turbo options are registry facts.
- Behaviour change: pre-push checks at `changed`, where it checked the whole tree. The pre-merge stage and CI still check at `all`.

## CI

- The Checks job runs `just check --all`. The four separate convention steps go, because the aggregate runs `conventions` first.
- The Tests `ts` job runs `just build`, then `just test --all` on the default major, and `just test pg --all` on the other majors, where it filtered to two packages.
- The generated Tests matrix hosts one test or rehearsal target per leg. A leg keeps its current name, such as `Browser journeys (e2e contact)`, so that no status name changes.
- A second generated matrix job in the Tests workflow hosts the check targets: `check model authority` and `check model contexts`, which no job runs today (E10). The Checks workflow stays the fast feedback of every push (`checks.yml:3`).
- The own jobs stay: `golden-school-service` (its CI wrapper accepts the exact-source evidence), `identity-browser-evidence`, and `applicant-evidence`. Each runs its target command.
- The steps of E11 that are not a target stay outside the grammar until a follow-up moves them ([Open questions](#open-questions-for-the-lead)). The registry lists each one with its reason, and `check conventions` fails when a listed step no longer exists.
- No workflow passes Turbo options. CI has no admission tool, and the runner runs each step directly there ([Admission and ledger](#admission-and-ledger)).

## Admission and ledger

The registry is the one client registry that the heavy-job admission design asks each project for (homelab `docs/specs/2026-09-27-heavy-job-admission.md`, C2, on branch `heavy-admit-0927`, proposed).
Each step whose family is not `light` runs through the mono-web admission client with its class. The client maps the class to its family, queues, measures, and records one ledger row with the class and a label.
The label is the full command line. A light step runs directly and records no row.

**Classes.** A scope step records `<verb>-<kind>-<scope>`, such as `check-lint-staged`. A target step records `<verb>-<kind>-<target>`, such as `test-e2e-onboarding`. An ad hoc slice of a kind, such as one Vitest file against PostgreSQL through `just measure`, records `<verb>-<kind>`, such as `test-pg`. An operation records its name, or `<operation>-<target>`, such as `rehearsal-receipt-import`.
The class set is a closed union derived from the registry, and each class has exactly one family. `just measure --class` accepts only its members. A registry test fails when two classes are equal.

| Class                                                  | Family     | Heavy-admit workload (C2)                           |
| ------------------------------------------------------ | ---------- | --------------------------------------------------- |
| `check-lint-staged`, `check-lint` (slice)                   | `hook`     | "A Git hook check, such as pre-commit lint"          |
| `check-lint-changed`, `check-lint-all`                      | `lint`     | "A whole-tree lint"                                  |
| `check-types-changed`, `check-types-all`, `check-types`     | `types`    | "A type check of one repository"                     |
| `check-model-authority`, `check-model` (slice)              | `solver`   | "An SMT solver or model checker, such as Z3 or Alloy" |
| `test-unit-changed`, `test-unit-all`, `test-unit`           | `unit`     | "A test suite without external services"             |
| `test-pg-changed`, `test-pg-all`, `test-pg`                 | `postgres` | "Tests or proofs that start real PostgreSQL"         |
| `test-e2e-<suite>`, `test-golden-<journey>`, `test-e2e`, `test-golden` | `browser` | "A headless-browser suite and the servers it starts" |
| `test-proof-<name>`, `test-proof`, `rehearsal-<name>`, `migration` | `postgres` | as above                                        |
| `build`                                                     | `build`    | "A non-Nix build or link step in the pane"           |
| every `format`, `conventions`, `safety`, and `duplication` class, and `check-model-contexts` | light | runs directly                          |

### For the heavy-admit lead

1. **Aggregate families.** Each step of an aggregate admits itself, so mono-web uses neither the `check` nor the `test` family. Stage-level admission is the alternative: one ticket per hook stage, with nested steps (C8). It holds one large reservation through the cheap steps too.
2. **`hook` family.** Under the grammar it covers staged-scope and ad hoc lint only. Pre-push steps admit as `lint`, `types`, `unit`, and `postgres`, not as "a pre-push check at concurrency 1" (C2).
3. **Calibration.** The C2 provenance filters class names by pattern (E8 of that design). After this cutover, each class names one workload, so calibration can group by class.
4. **CI.** The mono-web cutover spec decides how CI runs without the tool (its point 6). This design needs one rule: the runner admits a step exactly when `heavy-admit` resolves on `PATH`, and no flag or environment variable of the runner changes that.
5. **Hook jobs inside a job.** A commit inside an admitted job runs its hooks nested (C8). Nothing in this design takes a second ticket for them.

## Current surface and its new form

### Recipes

| Current                                                        | New                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `just check [args]`                                            | `just check --all`                                                                               |
| `just check-types [args]`                                      | `just check types --all [--filter=…]`                                                            |
| `just check-types -F @vektorprogrammet/backend --concurrency=1` | `just check types --all --filter=@vektorprogrammet/backend`                                     |
| `just layout`, `just constructs`, `just guides`, `just exceptions` | `just check conventions --all`                                                                |
| `just layout write`, `just constructs write`, `just guides write` | `just write conventions`                                                                      |
| `just constructs consumers [name]`                             | `just consumers [name]`, a query outside the grammar                                             |
| `just migration-hashes`, `just migration-hashes write`         | deleted by the schema collapse branch, which lands first                                         |
| `just format`, `just format --write`                           | `just write format`                                                                              |
| `just format --check`                                          | `just check format --all`                                                                        |
| `just lint [paths]`                                            | `just check lint --all`; a focused lint is `bun x oxlint --threads=2 <paths>`, as a focused Vitest run is documented |
| `just lint-files <paths>`                                      | removed; the pre-commit use is `just check lint --staged`                                        |
| `just source-safety`                                           | `just check safety --all`                                                                        |
| `just source-safety --changed`                                 | `just check safety --staged` (the old flag meant the staged change)                             |
| `just model check`                                             | `just check model authority`                                                                     |
| `just model validate`                                          | `just check model contexts`                                                                      |
| `just test [args]`                                             | `just test --all`, or `just test unit --all [--filter=…]` and `just test pg --all [--filter=…]` |
| `just test --affected`                                         | `just test --changed`                                                                            |
| `just e2e <suite>`                                             | `just test e2e <suite>`                                                                          |
| `just golden <journey>`                                        | `just test golden <journey>`                                                                     |
| `just proof <name> [args]`                                     | `just test proof <name>`; no caller passes arguments                                            |
| `just measure --class <free text> -- <command>`                | `just measure --class <registry class> [--label <text>] -- <command>`                            |
| `just measure --report`                                        | unchanged                                                                                        |
| `just hook-slot …`                                             | removed; each heavy step admits itself                                                           |
| `just hooks [args]`                                            | removed; each stage is its grammar commands, and `prek run` stays in devenv to debug the configuration |
| `just rehearsal <name> [args]`                                 | unchanged, outside the grammar; its names and hosting come from the registry                    |
| `just build [args]`                                            | unchanged, outside the grammar; admits itself as `build`                                         |
| `just migration <name> [args]`                                 | unchanged, outside the grammar; admits itself as `migration`                                     |
| `just fixture recommendation-preupgrade`                       | deleted with the upgrade proofs by the schema collapse branch; its recipe goes with its last name |
| `just dev`, `just seed`, `just docs [script]`, `just changelog`, `just land <branch>` | unchanged, outside the grammar                                             |

### Hooks, workflows, and package scripts

| Current                                                                                      | New                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| hook `format`: `just format --check --no-error-on-unmatched-pattern` on prek's staged paths  | `just check --staged`; the runner selects the paths                                              |
| hook `lint`: `just hook-slot --class hook-pre-commit-lint -- just lint-files …`              | `just check --staged`                                                                            |
| hook `source-safety`: `just source-safety --changed`                                         | `just check --staged`                                                                            |
| hook `push-check`: `just hook-slot … -- just check --concurrency=1`                          | `just check --changed`                                                                           |
| hook `push-test`: `just hook-slot … -- just test --affected --concurrency=1`                 | `just test --changed`                                                                            |
| hook `merge-full`: `just measure --class hook-pre-merge-full -- bash -c 'just check … && just test …'` | `just check --all`, then `just test --all`                                             |
| hooks `hook-config-current`, `hook-config-current-merge`, `check-merge-conflicts`            | unchanged, fixed in `devenv.nix`                                                                 |
| Checks: `just layout`, `just constructs`, `just guides`, `just exceptions`, then `just check` | `just check --all`                                                                              |
| Tests matrix: `just "$RECIPE" "$SUITE"`                                                      | one generated target command per leg, such as `just test e2e contact` and `just rehearsal organization-import` |
| Tests `ts`: `just test --concurrency=1`                                                      | `just test --all`                                                                                |
| Tests `ts`, other majors: `just test --concurrency=1 --filter=@vektorprogrammet/backend --filter=@vektorprogrammet/database` | `just test pg --all`                                               |
| Tests own jobs: `just e2e identity`, `just e2e applicant`                                    | `just test e2e identity`, `just test e2e applicant`                                              |
| Tests: `bun run --cwd packages/database proof:receipt`, `proof:identity-postgres`, `test -- src/auth-live.test.ts`; the placements reference steps; two `bun test` steps | outside the grammar, listed in the registry with their reasons (E11) |
| Docs and Worker Previews workflows                                                           | unchanged: `just docs build` and deployment are operations outside the grammar                   |
| package `test` scripts and the Turbo `test` task                                             | `test:unit` and `test:pg` scripts and tasks                                                      |
| package `lint` scripts and the Turbo `lint` task                                             | removed (E13)                                                                                    |
| package `format` scripts (`apps/dashboard`, `apps/homepage`)                                 | removed; `just write format` formats the tree                                                    |
| `bun x turbo`, `bun x oxfmt`, `bun x oxlint` in recipes                                      | the runner calls the locked binaries in `node_modules/.bin` and exits with an instruction to run `bun install` when they are missing (E15) |

## Falsifiers

Each row is a test of `tools/conventions` or `tools/scripts`, a scratch-repository test, or a hook run on a scratch branch.
Scope tests build a scratch Git repository with four Bun workspace packages (`a`; `b` depends on `a`; `c` depends on `b`; `d`), root files, a `main` branch, a remote, and a feature branch, and read `--plan`.

| #   | Property                                   | Test                                                                                                                                                                                  | Fails when                                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| F1  | A new entry reaches every derivation       | Add a check kind that supports all three scopes to a registry fixture and run `just write conventions`.                                                                               | Its row is missing from a table, it is missing from `check --staged`, `--changed`, or `--all` plans, or `hooks.json` changes. |
| F2  | A new target reaches CI                    | Add a hosted e2e target to the fixture and run `just write conventions`.                                                                                                              | The Tests matrix does not gain exactly one leg, or the hosted-journeys section lacks it.           |
| F3  | A hand edit fails                          | Edit the justfile section, `hooks.json`, a matrix leg, a command table, or add a hook to `devenv.nix` by hand (negative controls).                                                    | `check conventions` passes.                                                                         |
| F4  | `staged` is exact                          | Stage an edit of `a`; leave an unstaged edit of `d` and an untracked file in `d`. Then add an unstaged edit to the staged path.                                                       | The plan selects anything but the staged path; the second run does not exit 65.                    |
| F5  | `changed` selects affected packages        | Commit a change to `a` on the feature branch.                                                                                                                                          | `types`, `unit`, and `lint` plans do not select exactly `a`, `b`, and `c`.                           |
| F6  | A root input selects everything            | Commit a change to `tsconfig.json`, which `globalDependencies` lists. Then commit a change to `oxlint.config.ts` alone.                                                               | The first does not select every package for `types`, `unit`, and `lint`; the second does not widen `lint` to every package, or selects a package for `types`. |
| F7  | A push of `main` has a base                | On `main`, two commits ahead of the remote, run `just test --changed` with prek's push variables set.                                                                                 | The plan selects nothing, or selects packages that the two commits do not affect.                  |
| F8  | `all` selects everything                   | Any state.                                                                                                                                                                             | A package-aware plan misses a package, or a `files` plan misses a tracked path of its pattern.      |
| F9  | Wrong words fail loudly                    | `check lnt --all`, `check lint`, `check lint --staged --all`, `test e2e`, `test e2e onbording`, `check --all --filter=a`, `check format --all --filter=a`, `check types --all --filter=zzz`, `check types --changed --filter=[main]`, `-F a`, `--affected`, `--concurrency=1`, `--`, `check --staged lint`. | Any of them exits other than 64, or its message lacks the valid words.                             |
| F10 | Stages equal their aggregates              | Run each stage with `prek run --hook-stage <stage>` on a scratch branch.                                                                                                             | A stage runs a step that its aggregate plan lacks, or the reverse.                                  |
| F11 | Nothing is unrun                           | Registry test over the real registry, and a fixture entry with neither `all` nor a hosted target (negative control).                                                                | The fixture passes.                                                                                 |
| F12 | Classes are closed                         | `just measure --class check-lnt -- true`; then one grammar run under the admission client.                                                                                            | The first run does not exit 64; the ledger row's class is not a registry class, or its label is not the command line. |
| F13 | Mentions parse                             | A Markdown code span `just check-types`, `just test e2e onbording`, and `just check lint --staged`.                                                                                   | One of the first two passes, or the third fails.                                                    |
| F14 | One lint path                              | `turbo.json` and the package manifests after cutover.                                                                                                                                 | A `lint` task or script remains.                                                                    |
| F15 | Locked tools only                          | Run a grammar command in a worktree without `node_modules`.                                                                                                                           | It runs any tool instead of exiting with the `bun install` instruction.                            |
| F16 | A base that does not resolve fails loudly  | `TURBO_SCM_BASE=does-not-exist just test --changed`, and a shallow clone without the merge base.                                                                                      | A run exits other than 65, or selects every package.                                               |
| F17 | Pre-push checks the pushed commit          | In a pre-push hook: an untracked file, an unstaged edit, and `HEAD` different from the pushed ref, each alone.                                                                        | A run exits other than 65.                                                                          |
| F18 | Root inputs stay declared                  | A fixture workspace `tsconfig.json` that extends a new root file, and a Vitest configuration that imports one, neither in `globalDependencies` (negative controls).                   | `check conventions` passes.                                                                         |

## Cutover

**Sequencing.** Start after the schema collapse branch lands and the current landing queue drains, because the rename touches the justfile, `devenv.nix`, both workflows, and every guide. Land in the same window as the mono-web heavy-admit cutover, before the next branch is cut.
The collapse decides which proofs stay: `authorization-rules` reads the migration definitions and a migration proof today. The registry takes the target names that remain.
If the homelab tool is not active yet, the runner's admission client keeps today's lock for that window: a `hook` family takes a hook slot, another family takes the exclusive lock, and `light` takes nothing. The heavy-admit cutover then replaces only the client.

**One change, no aliases.** One branch renames every caller, and no old recipe remains as an alias or a forwarding recipe:

- the justfile, `devenv.nix` (hooks and `hookSources`), `hooks.json`, `turbo.json` (`test:unit`, `test:pg`, no `lint` task, and `tsconfig.json` and `vitest.shared.ts` in `globalDependencies`), and the package manifests;
- the Checks and Tests workflows;
- `README.md`, `AGENTS.md` (the commands, verification, and landing sections, and the construction-over-trust precedents that name recipes), and `STATE.md`;
- `.agents/skills/effect-house/SKILL.md` and its references;
- `docs/web-system-functional-testing.md`, `docs/module-developer-documentation.md`, the construct pages, and every module guide, which `just write conventions` regenerates;
- the active specifications that name recipes to come: [repository conventions](repository-conventions.md) (`just duplication`, `just duplication --staged`, `just duplication baseline`) and [public surface](public-surface.md) (`just surface`), which change to `just check duplication`, `just write duplication`, and `just check surface`;
- the messages of `tools/scripts` (`land.ts`, `dev.ts`, `changelog.ts`, `measure-job.ts`, `model.ts`) and `apps/dashboard/e2e/native-users-journey-seed.mjs`.

**Deletions.** `hook-slot.ts` and the lock code go with the heavy-admit cutover. This cutover deletes the `case` dispatch of `golden`, `e2e`, `proof`, and `rehearsal`, the `case` parser of `justfile.ts` that only they feed, the `--staged` option of the conventions command line, the `lint` scripts and task, the package `format` scripts, and the tests that pin old recipe strings, such as `tools/conventions/tests/layout.test.ts:89-91`. A test that pinned wording is deleted, not moved to the new wording.

**Turbo upgrades.** The runner never passes `--affected`, so an upgrade past 2.9.4, where `--affected --filter` changed from an error to an intersection (E16), does not change what a grammar command selects.

**Done when.** F1 to F18 pass; the hooks run the grammar on a scratch commit, push, and merge; the Checks and Tests workflows pass on the cutover commit; and `rg -n 'just (check-types|lint-files|source-safety|layout|constructs|guides|exceptions|migration-hashes|model|e2e|golden|proof|hook-slot|hooks)\b'` finds nothing outside `CHANGELOG.md` and `docs/specs/`.

## Open questions for the lead

1. **Writers.** This design adds `just write <kind>` for the check kinds that have a writer: `format`, `conventions`, and later `duplication`. It sits beside the grammar and derives from the same entries. The alternative keeps one writer per tool, which leaves `layout`, `constructs`, and `guides` as recipe names beside `check conventions`.
2. **Rehearsal.** The operator placed `rehearsal` outside the grammar, and it stays there, but its hosted names come from the registry. The alternative is a test kind, `just test rehearsal <name>`: a rehearsal verifies import code against a disposable database.
3. **Pre-push at `changed`.** The stage map narrows pre-push from the whole tree to the change. A direct commit on `main` then relies on prek's push base and on `globalDependencies` (E17). Pre-merge and CI still check at `all`.
4. **Model.** `check model` has no `all` scope, so landings do not run the ten-minute Alloy check. Pushes run a target when its inputs change, and CI hosts both targets. The alternative adds `all`, and every landing runs Alloy.
5. **CI steps outside the grammar (E11).** Proposed follow-ups: `proof:receipt`, `proof:identity-postgres`, and the focused `auth-live` test start their own cluster and become `test proof` targets and part of `test pg`; the two `bun test` files join `test unit` through `test:unit` scripts in `tools/placements-docs` and `tools/e2e`. The placements reference gate needs a decision: the operator's kinds include none for documentation.
6. **Unhosted proofs (E12).** After the schema collapse, each remaining proof becomes a hermetic `test proof` target, or it goes.
7. **Admission granularity.** Per step, as designed, or one ticket per hook stage. This question is shared with the heavy-admit lead ([For the heavy-admit lead](#for-the-heavy-admit-lead)).
8. **Admission before the homelab tool is active.** [Cutover](#cutover) keeps today's lock for that window. The alternative waits for the tool.
9. **`mutation`.** It needs a specification of its own: the tool, scopes, family, and hosting. If it supports `all`, every landing runs it.
10. **`surface` and `duplication`.** Implement both under the grammar names after this cutover, so that nothing is renamed twice. Their specifications change in the cutover change.
11. **`just hooks`.** It goes, because each stage is its grammar commands. `prek run --hook-stage <stage>` in devenv still runs the literal stage configuration.

## Rejected alternatives

- **just modules.** Two spellings for every command and no aggregate ([Syntax decision](#syntax-decision-positional-arguments)).
- **A package selector of our own.** Turbo's filter syntax and `--affected` already select by name, dependents, dependencies, directory, and Git range. A second selector would need its own graph and could disagree with Turbo's.
- **A separate `stages` field per entry.** It would repeat what the scopes and the stage table already fix, and the two could disagree. An entry that must not run in a stage does not support that stage's scope, and a target hosts it instead, as `model` shows.
- **Per-package Turbo lint processes.** Each process builds its own TypeScript programs for type-aware rules. One Oxlint process over the Turbo selection builds them once.
- **Scope defaults.** A default scope would make `just check lint` and `just check lint --all` two spellings of one command, and a default hides the caller's intent.
