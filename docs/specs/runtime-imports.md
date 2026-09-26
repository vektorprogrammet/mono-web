# Runtime imports

Status: frozen for implementation on 2026-09-26 (operator decision). Remove this specification when the checks below run in hooks and CI and `AGENTS.md`, `docs/architecture.md`, and the effect-house overlay state the rule.

## Rule (operator decision, 2026-09-26)

Only a Layer implementation imports a runtime-specific module: `node:*`, `bun:*`, a bare Node builtin, or a provider SDK.
A composition root (a main, a CLI, or test setup) chooses Layers. It imports platform Layer packages such as `@effect/platform-bun`, never a builtin.
Every other module imports neither. Effect's platform packages are the stock Layer implementations. The repository's own adapters are the others.

This makes the infrastructure-ports rule concrete: "No module outside a Layer imports a provider SDK, a platform binding, or a runtime-specific module."

## Evidence (measured on `01db01e7`)

- 723 `node:` imports outside `apps/server`: about 35 in product source (`packages/database`, `apps/backend`), and the rest in tools, tests, and e2e runners.
- `packages/database` and `apps/backend` are declared `runtime-adapter` as whole packages, so `no-ambient-authority` stays silent there. The same `node:crypto` import fails lint in `packages/domain`.
- tsgo `node-builtin-import` covers only `fs`, `path`, `child_process`, and `http`, with or without the prefix. It does not cover `crypto`, `os`, `net`, `timers/promises`, or `async_hooks`.
- Effect `Crypto` (rc.116) offers random bytes, digests, and UUIDs. It has no HMAC, AES-GCM, HKDF, or constant-time comparison.
- Slice F added explicit `node:process` and `node:buffer` imports to 27 Bun roots to satisfy the platform declaration.

## Where each use goes

| Use | Goes through |
| --- | --- |
| random bytes, UUIDs | Effect `Crypto` |
| hash of known bytes | `@noble/hashes` as a plain function (a total calculation, not a capability) |
| HMAC, AES-GCM, HKDF, constant-time comparison | one repository service with keys as its authority; its single live Layer uses WebCrypto |
| files, paths, processes, terminal, stdio, environment | Effect `FileSystem`, `Path`, `ChildProcess`, `Terminal`, `Stdio`, `Config` |
| time, sleep | `Clock`, `Effect.sleep` |
| request-scoped state (`AsyncLocalStorage`) | Effect `Context` |
| IP parsing in the router | the HTTP adapter Layer, or a portable parser |
| `Buffer` | `Uint8Array` and Effect `Encoding` |
| test assertions (`node:assert`) | `@effect/vitest` |

An operation that no Effect API covers and no Layer can own becomes a registered exception (`just exceptions`) with a retirement trigger.

## Phases

1. **Product source.** Narrow the `runtime-adapter` groups in `packages/database` and `apps/backend` to the modules that are Layers. Every other module there becomes `effect-library`. Move the ~35 sites.
2. **Composition roots.** Measure whether the `@phibkro/oxlint-effect-plugin` `composition-root` role can reject builtins while admitting platform Layer packages. If it cannot, add that option in `/srv/share/projects/oxlint-effect-plugin`, release it, and pin it. Remove slice F's `node:process` and `node:buffer` imports and the bun `extraAllowedModules` list.
3. **Tools, tests, and runners.** First a measured inventory by module and file kind, committed into this spec. Then move each group. The e2e `.mjs` runners become typed `.ts` when they move onto Effect services.

## Done when

1. `just lint` fails on a `node:` or bare-builtin import in each of these: a non-Layer module in `packages/database`, `apps/backend`, and `packages/domain`; a composition root; a test; a tools script. It passes on the same import in a registered Layer module. Each case is recorded as a negative control.
2. A composition root that provides `BunServices.layer` passes.
3. The only remaining `node:` and `bun:` imports are in Layer modules, or are registered exceptions.
4. `just check` and the hosted Checks and Tests workflows pass.

## Order

Run after certificates, because phase 1 edits the same backend and database files. The construct-contracts and Fumadocs slices may land first. [Public surface](public-surface.md) comes after this.
