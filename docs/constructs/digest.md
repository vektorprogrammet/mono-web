# digest

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Canonical JSON and SHA-256 digests that evidence and idempotency identities hash. The [index](../constructs.md) lists every category.

## `canonicalJsonValue`

The plain JSON value of a datum, with sorted object keys and non-finite numbers as `null`.

```ts
canonicalJsonValue<A>(datum: A): Schema.Json
```

- Inputs: `datum: A`
- Output: `Schema.Json`
- Errors: none
- Throws: An `Error` whose cause is the schema issue, when the datum holds anything but plain data at any depth: `undefined`, a `DateTime`, a `Date`, a class instance, or bytes. Encode such a value through its owning schema first.
- Requirements: none
- Side effects: none
- Source: [packages/domain/src/shared-kernel/canonical-json.ts:92](../../packages/domain/src/shared-kernel/canonical-json.ts#L92)

**How it works**

It accepts plain data only, at every depth: `null`, strings, booleans, numbers, arrays, and
objects whose prototype is `Object.prototype` or `null`. Object keys are sorted by UTF-16 code
unit at every depth, and `NaN` and the infinities become `null`, as `JSON.stringify` writes
them. The value is what a SQL `json` parameter stores, so a JSON column keeps the canonical form.

**Use**

```ts
sql.json(canonicalJsonValue(commandEnvelope));
```

**Avoid**

`sql.json(canonicalJson(value))`: `sql.json` encodes its argument again, so the column
stores a JSON string, and `anti-slop/no-json-text-parameter` rejects it. Give a JSON parameter
`canonicalJsonValue(value)`.

## `canonicalJson`

The canonical JSON text of a datum, to hash or compare; a SQL `json` parameter takes `canonicalJsonValue` instead.

```ts
canonicalJson<A>(datum: A): string
```

- Inputs: `datum: A`
- Output: `string`
- Errors: none
- Throws: An `Error` whose cause is the schema issue, when the datum is not plain data, as `canonicalJsonValue` throws.
- Requirements: none
- Side effects: none
- Source: [packages/domain/src/shared-kernel/canonical-json.ts:121](../../packages/domain/src/shared-kernel/canonical-json.ts#L121)

**How it works**

`JSON.stringify` of `canonicalJsonValue`: sorted object keys at every depth, non-finite numbers
as `null`, and no whitespace, so equal data always gives equal text. Command digests, lock keys,
and evidence digests hash or embed this text.

**Use**

```ts
const commandJson = canonicalJson(payload);
```

**Avoid**

Comparing or hashing `JSON.stringify(value)`: its key order follows insertion, so equal
data can give different text. Passing this text to `sql.json` stores a JSON string, which
`anti-slop/no-json-text-parameter` rejects; a JSON parameter takes `canonicalJsonValue`.

## `canonicalJsonBytes`

The UTF-8 bytes of the canonical JSON text of a datum.

```ts
canonicalJsonBytes<A>(datum: A): Uint8Array<ArrayBuffer>
```

- Inputs: `datum: A`
- Output: `Uint8Array<ArrayBuffer>`
- Errors: none
- Throws: An `Error` whose cause is the schema issue, when the datum is not plain data, as `canonicalJsonValue` throws.
- Requirements: none
- Side effects: none
- Source: [packages/domain/src/shared-kernel/canonical-json.ts:147](../../packages/domain/src/shared-kernel/canonical-json.ts#L147)

**How it works**

`TextEncoder` output of `canonicalJson`: the input that `sha256Hex` digests for command
receipts, idempotency identities, snapshot digests, and evidence hashes.

**Use**

```ts
const digest = sha256Hex(canonicalJsonBytes({ actorPersonId, command }));
```

**Avoid**

Digesting `new TextEncoder().encode(JSON.stringify(value))`: its key order follows
insertion, so equal data can digest differently. Digest `canonicalJsonBytes(value)`.

## `sha256Hex`

The lowercase hexadecimal SHA-256 digest of bytes.

```ts
sha256Hex(bytes: Uint8Array): string
```

- Inputs: `bytes: Uint8Array`
- Output: `string`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/domain/src/shared-kernel/canonical-json.ts:172](../../packages/domain/src/shared-kernel/canonical-json.ts#L172)

**How it works**

`@noble/hashes` computes the digest synchronously in plain JavaScript, so it needs no Web Crypto
or Node API and gives the same 64 characters wherever it runs.

**Use**

```ts
const payloadDigest = sha256Hex(canonicalJsonBytes(command));
```

**Avoid**

Hashing `JSON.stringify` text, or writing a digest in base64 or upper case: stored
digests compare as the lowercase hexadecimal digest of canonical JSON bytes, so any other form
never matches. Digest `canonicalJsonBytes(value)` with `sha256Hex`.
