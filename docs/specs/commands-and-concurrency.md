# Commands and concurrency

Status: frozen for implementation on 2026-09-26 (operator decision). Remove this specification when the checks below run in hooks and CI, and `docs/architecture.md`, `AGENTS.md`, and the effect-house overlay state the rules.

## Problem

A deep review of main found the same defect shapes in several contexts:
- Writes spread over several transactions: OAuth client provisioning, refresh-token tracking after a provider rotation, and a draft applied as one request per row.
- I/O done before its record commits: the provider rotates a token, then local tracking fails.
- A cross-row invariant checked by one writer but not the others: an outcome or an independence flag against placements and boards.
- A second context writing another context's row and revision: team intake bumping `organization_teams.revision`.

Transactions exist, but nothing forces code to use them, and nothing stops I/O inside them. Effect gives structured concurrency, but escape hatches (`forkDaemon`, `forkDetach`, `run*` inside programs) and local mutable state bypass it.

## Goal

Make these shapes type errors or check failures, not review findings.

## Rules

### Commands and transactions

- **One transaction capability.** A write adapter requires a `Tx` service in its requirements. The only provider of `Tx` is `runCommand` in `packages/database`, the command-transaction construct. It opens the transaction, takes the command's declared locks, checks the precondition, writes the receipt and audit, and commits. A write outside a command is a type error.
- **Declared lock sets.** A command declares the locks it takes (advisory-lock keys and row locks) in its type. Commands that guard one cross-row invariant declare the same key; a test proves two such commands serialize. Where storage can hold the invariant, it is a database constraint instead.
- **No I/O inside a transaction.** `runCommand` constrains its program so that no provider, HTTP, mail, or file service can be required inside it. External work is queued as an outbox envelope inside `Tx` and runs after commit. A provider call that must happen before the commit (a third-party library owns the rotation) needs an idempotent recovery path. The spec for that case is [durable workflows](durable-workflows.md).
- **One user action is one command.** A frontend action sends one mutation request. A lint rule rejects a loop or `Promise.all` of mutations in a route action or Foldkit command.
- **A context writes only its own tables.** The context map (`contexts.cml`) lists each context's tables, and a check rejects a database adapter that writes another context's table.

### Structured concurrency

- Background work runs as `Effect.forkScoped` inside a `Layer`, or in `FiberSet`, `FiberMap`, or `FiberHandle`. `Effect.forkDaemon` and `Effect.forkDetach` are banned outside composition roots.
- `Effect.run*` is allowed only in composition roots and the registered runtime bridge (enforced partly today, by `no-premature-execution` and tsgo `run-effect-inside-effect`).
- A `Fiber` value is not stored in a variable or field; use the scoped collections.
- Shared mutable state uses `Ref`, `SynchronizedRef`, or the `Tx*` STM types. `let` is banned in core code (`packages/domain`, `packages/database`, `packages/http-api`, `apps/backend`) and in Foldkit update code. A local accumulator becomes a fold.

## Evidence (measured on `9cb12743`)

- 174 transaction call sites in `packages/database/src` and `apps/backend/src`.
- 6 escape-hatch sites in product source: 3 in `apps/backend/src/main.ts` (a composition root), 1 in `packages/http-api/src/receipt-upload.ts`, 2 in CLI and config roots.
- 0 module-level `let`, and 158 local `let` in core source.
- Exactly one frontend action issues several mutations: `dashboard.assistenter._index.tsx` ApplyDraft, fixed by the placements review slice.

## Phases

1. **Pilot on Placements**, after the placements review fixes land. Build the `Tx` capability, `runCommand` with declared lock sets and the no-I/O constraint, then move every Placements write onto it. Record what felt awkward and adjust the rules before phase 2.
2. Move the remaining contexts' writes, one context per slice.
3. Checks: the escape-hatch bans, the `let` ban, the one-mutation-per-action rule, and table ownership, each with a negative control.

## Done when

1. A write adapter called outside `runCommand` fails `tsc` (negative control), and so does a program inside `runCommand` that requires a mail or HTTP service.
2. Two commands that declare the same lock serialize, shown by a concurrent test on PostgreSQL.
3. `just lint` fails on `forkDaemon` in a Layer module, on `let` in core, and on two mutation calls in one route action (negative controls).
4. A context's adapter writing another context's table fails the check (negative control).
5. Every write in the repository goes through `runCommand`, and `just check` and the hosted workflows pass.
