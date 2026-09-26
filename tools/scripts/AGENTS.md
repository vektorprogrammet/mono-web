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

## Model checks

`model.ts` runs the model checks that `just model` puts under the heavy lock.

- `check` runs Alloy 6 from nixpkgs with the command of the model header and compares each result with the command's `expect`. A name that contains `mutant` marks a mutant check.
- `validate` runs Context Mapper CLI 6.12.0 on OpenJDK 17 from nixpkgs. The CLI archive must match the SHA-256 that Maven Central publishes. The CLI exits with 0 also when it reports errors, so the script reads its output.
