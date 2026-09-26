# digest

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Canonical JSON and SHA-256 digests that evidence and idempotency identities hash. The [index](../constructs.md) lists every category.

## `canonicalJsonValue`

The plain JSON value of a datum, with sorted object keys and non-finite numbers as `null`.

```ts
const canonicalJsonValue
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/domain/src/shared-kernel/canonical-json.ts:72](../../packages/domain/src/shared-kernel/canonical-json.ts#L72)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `canonicalJson`

The canonical JSON text of a datum, to hash or compare; a SQL `json` parameter takes `canonicalJsonValue` instead.

```ts
const canonicalJson
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/domain/src/shared-kernel/canonical-json.ts:85](../../packages/domain/src/shared-kernel/canonical-json.ts#L85)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `canonicalJsonBytes`

The UTF-8 bytes of the canonical JSON text of a datum.

```ts
const canonicalJsonBytes
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/domain/src/shared-kernel/canonical-json.ts:92](../../packages/domain/src/shared-kernel/canonical-json.ts#L92)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `sha256Hex`

The lowercase hexadecimal SHA-256 digest of bytes.

```ts
sha256Hex(bytes: Uint8Array): string
```

- Inputs: `bytes: Uint8Array`
- Output: `string`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/domain/src/shared-kernel/canonical-json.ts:99](../../packages/domain/src/shared-kernel/canonical-json.ts#L99)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
