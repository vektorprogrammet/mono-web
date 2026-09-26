[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/domain/src/shared-kernel

This folder holds code that several bounded contexts share.
The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.

## Entry points

| Import                                   | Module               |
| ---------------------------------------- | -------------------- |
| `@vektorprogrammet/domain/shared-kernel` | [index.ts](index.ts) |

## Constructs

The shared constructs defined here. Each name links to its contract; [docs/constructs.md](../../../../docs/constructs.md) indexes them all.

- [`canonicalJsonValue`](../../../../docs/constructs/digest.md#canonicaljsonvalue) (digest): The plain JSON value of a datum, with sorted object keys and non-finite numbers as `null`.
- [`canonicalJson`](../../../../docs/constructs/digest.md#canonicaljson) (digest): The canonical JSON text of a datum, to hash or compare; a SQL `json` parameter takes `canonicalJsonValue` instead.
- [`canonicalJsonBytes`](../../../../docs/constructs/digest.md#canonicaljsonbytes) (digest): The UTF-8 bytes of the canonical JSON text of a datum.
- [`sha256Hex`](../../../../docs/constructs/digest.md#sha256hex) (digest): The lowercase hexadecimal SHA-256 digest of bytes.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
