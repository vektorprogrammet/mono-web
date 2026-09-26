[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# tools/scripts

Local launcher, Git hook runner, job measurement, preview deployment, changelog.
Package `@monoweb/scripts`.

## Entry points

The package has no `exports`, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"

## Heavy lock

`heavy-lock.ts` owns the machine-wide heavy lock. `measure-job.ts` takes it exclusively, and `hook-slot.ts` takes it shared.
[AGENTS.md](../../AGENTS.md#verification-and-resources) states the contract.

- A hook slot takes the heavy lock before its slot. A hook job that waits for a heavy job holds no slot, so the hooks of a commit inside that heavy job still get one.
- An exclusive holder keeps the gate, `heavy-gate.lock`, until it exits. Hook jobs that arrive while it waits queue behind it, so a stream of hook jobs cannot starve it.
- The lock descriptors stay in the process that took them. A job inherits only `VEKTORPROGRAMMET_HEAVY_LOCK`, so a process that a job leaves behind does not hold the lock.
- `tests/heavy-lock.test.ts` runs real processes against its own `XDG_RUNTIME_DIR` and removes `VEKTORPROGRAMMET_HEAVY_LOCK`, so it also passes inside a hook job.

## Staged checks

`check-staged.ts` checks the staged tree in a temporary worktree. Its node_modules never come from this checkout, which may have installed another lockfile.

- The staged `bun.lock`, `bunfig.toml`, `patches/`, and root and workspace `package.json` files key a frozen install under `${XDG_CACHE_HOME:-~/.cache}/vektorprogrammet/check-staged-installs`. A run with the same files reuses it; an install unused for a day is removed.
- The snapshot copies the install's link trees and links its package store. A staged lockfile that its manifests do not satisfy fails the check.
- The Bun that runs the script installs and runs the tasks. It must equal `packageManager` of the staged `package.json`; otherwise the script fails and names `devenv shell`.
- `tests/check-staged.test.ts` stages a dependency that the fixture's node_modules lack, with its own caches, lock, and slots.

## Model checks

`model.ts` runs the model checks that `just model` puts under the heavy lock.

- `check` runs Alloy 6 from nixpkgs with the command of the model header and compares each result with the command's `expect`. A name that contains `mutant` marks a mutant check.
- `validate` runs Context Mapper CLI 6.12.0 on OpenJDK 17 from nixpkgs. The CLI archive must match the SHA-256 that Maven Central publishes. The CLI exits with 0 also when it reports errors, so the script reads its output.

## Landing

`land.ts` refuses instead of forcing. It never removes a worktree with changes or untracked files, and it aborts a merge that stops.
`tests/land.test.ts` runs Git without the variables of a hook and without the user's configuration.
