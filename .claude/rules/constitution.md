# Monoweb Project Conventions

## SDK Conventions

When working on `packages/sdk/`:

- Domain methods speak the ubiquitous language: `approve()` not `updateStatus("refunded")`
- Types are Schema.Class — inferred via `Schema.Schema.Type`, never hand-written interfaces
- Effect is an internal detail — consumers see plain promises via `createClient()`
- Every new domain type needs a Schema round-trip test (`encode → decode === original`)
- Adapter transforms (Hydra unwrap, status mapping, date parsing) live in `src/adapter/`
- `src/domains/` contain the domain method factories — one file per domain
- Dual export: `@vektorprogrammet/sdk` (promises) + `@vektorprogrammet/sdk/effect`
