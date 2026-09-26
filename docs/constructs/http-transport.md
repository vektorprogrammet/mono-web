# http-transport

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Reads native HTTP requests and writes their representations: bounded JSON, preconditions, idempotency keys, entity tags, and cache headers. The [index](../constructs.md) lists every category.

## `jsonResponse`

One JSON representation that no cache stores.

```ts
jsonResponse(body: Schema.Json): Response
```

- Inputs: `body: Schema.Json`
- Output: `Response`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/admission/http-representation.ts:11](../../apps/backend/src/admission/http-representation.ts#L11)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `conditionalCollection`

Answers a conditional read of one admission collection, tagged by the versions of its items.

```ts
conditionalCollection(
  input: { readonly request: Request; readonly body: unknown; readonly representationKind: string; readonly version: ETagVersionSource; readonly cacheControl: string }
)
```

- Inputs: `input: { readonly request: Request; readonly body: unknown; readonly representationKind: string; readonly version: ETagVersionSource; readonly cacheControl: string }`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/admission/http-representation.ts:25](../../apps/backend/src/admission/http-representation.ts#L25)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `readBoundedJson`

Bound bytes while reading, including requests without Content-Length.

```ts
readBoundedJson(request: Request, maxBytes: number): Effect.Effect<Schema.Json, ReadJsonProblem>
```

- Inputs:
  - `request: Request`
  - `maxBytes: number`
- Output: `Effect.Effect<Schema.Json, ReadJsonProblem>`
- Errors: `ReadJsonProblem`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/read-json.ts:17](../../apps/backend/src/http-api/read-json.ts#L17)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `jcsBytes`

Encodes one I-JSON value with the repository RFC 8785 encoder.

```ts
jcsBytes(value: Schema.Json): Uint8Array
```

- Inputs: `value: Schema.Json`
- Output: `Uint8Array`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:119](../../apps/backend/src/http-semantics.ts#L119)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `parseJsonWithoutDuplicateMembers`

Decodes UTF-8 JSON while rejecting duplicate member names before schema decoding.

```ts
parseJsonWithoutDuplicateMembers(bytes: Uint8Array): Schema.Json
```

- Inputs: `bytes: Uint8Array`
- Output: `Schema.Json`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:130](../../apps/backend/src/http-semantics.ts#L130)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `interpretMergePatchSource`

Preserves absence, value, and explicit deletion before typed merge-patch decoding.

```ts
interpretMergePatchSource<const Fields extends ReadonlyArray<string>>(
  source: Schema.Json,
  allowedFields: Fields
): MergePatchInterpretation<Fields[number]>
```

- Inputs:
  - `source: Schema.Json`
  - `allowedFields: Fields`
- Output: `MergePatchInterpretation<Fields[number]>`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:180](../../apps/backend/src/http-semantics.ts#L180)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `parseIdempotencyKey`

Decodes one non-combinable Idempotency-Key field.

```ts
parseIdempotencyKey(values: ReadonlyArray<string>): IdempotencyKey
```

- Inputs: `values: ReadonlyArray<string>`
- Output: `IdempotencyKey`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:259](../../apps/backend/src/http-semantics.ts#L259)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `parseRequiredIfMatch`

Decodes the required single strong If-Match value for an item mutation.

```ts
parseRequiredIfMatch(values: ReadonlyArray<string>): StrongETag
```

- Inputs: `values: ReadonlyArray<string>`
- Output: `StrongETag`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:276](../../apps/backend/src/http-semantics.ts#L276)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `parseReadIfMatch`

Canonicalizes an optional read If-Match wildcard or entity-tag list.

```ts
parseReadIfMatch(values: ReadonlyArray<string>): CanonicalIfMatch | null
```

- Inputs: `values: ReadonlyArray<string>`
- Output: `CanonicalIfMatch | null`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:359](../../apps/backend/src/http-semantics.ts#L359)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `parseIfNoneMatch`

Canonicalizes an optional If-None-Match wildcard or entity-tag list.

```ts
parseIfNoneMatch(values: ReadonlyArray<string>): CanonicalIfNoneMatch | null
```

- Inputs: `values: ReadonlyArray<string>`
- Output: `CanonicalIfNoneMatch | null`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:367](../../apps/backend/src/http-semantics.ts#L367)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `encodePathIdentity`

Encodes one decoded identity as an uppercase RFC 3986 path segment.

```ts
encodePathIdentity(identity: string): string
```

- Inputs: `identity: string`
- Output: `string`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:375](../../apps/backend/src/http-semantics.ts#L375)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `normalizeTarget`

Fills a route template with its encoded identities; a missing identity is a malformed request.

```ts
normalizeTarget(routeTemplate: string, identities: Readonly<Record<string, string>>): string
```

- Inputs:
  - `routeTemplate: string`
  - `identities: Readonly<Record<string, string>>`
- Output: `string`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:389](../../apps/backend/src/http-semantics.ts#L389)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `deriveHttpIdentity`

Derives the private storage digest and domain command ID from the identity tuple.

```ts
deriveHttpIdentity(identity: NativeIdempotencyIdentity): DerivedHttpIdentity
```

- Inputs: `identity: NativeIdempotencyIdentity`
- Output: `DerivedHttpIdentity`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-semantics.ts:418](../../apps/backend/src/http-semantics.ts#L418)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `jsonResponse`

A JSON body under the receipt cache policy the caller names.

```ts
jsonResponse(
  body: Schema.Json,
  status = 200,
  cacheControl: "no-store" | "private, no-store" = "no-store"
): Response
```

- Inputs:
  - `body: Schema.Json`
  - `status = 200`
  - `cacheControl: "no-store" | "private, no-store" = "no-store"`
- Output: `Response`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/receipt/http-representation.ts:25](../../apps/backend/src/receipt/http-representation.ts#L25)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `privateJsonResponse`

A JSON body private to the caller, varying by Origin.

```ts
privateJsonResponse(body: Schema.Json, status = 200): Response
```

- Inputs:
  - `body: Schema.Json`
  - `status = 200`
- Output: `Response`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/receipt/http-representation.ts:43](../../apps/backend/src/receipt/http-representation.ts#L43)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `receiptMutationCapsule`

The replayable response of one receipt mutation.

```ts
receiptMutationCapsule(receipt: Receipt, response: ReceiptMutationStatus): NativeHttpResponseCapsule
```

- Inputs:
  - `receipt: Receipt`
  - `response: ReceiptMutationStatus`
- Output: `NativeHttpResponseCapsule`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/receipt/http-representation.ts:164](../../apps/backend/src/receipt/http-representation.ts#L164)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `readPrivateReceiptFile`

Answers verified private bytes with their exact headers; unreadable bytes are the receipt store failing.

```ts
readPrivateReceiptFile(
  file: ReceiptFile,
  fileStore: ReceiptFileStore,
  maxFileBytes: number,
  extraHeaders: Readonly<Record<string, string>> = {}
)
```

- Inputs:
  - `file: ReceiptFile`
  - `fileStore: ReceiptFileStore`
  - `maxFileBytes: number`
  - `extraHeaders: Readonly<Record<string, string>> = {}`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/receipt/http-representation.ts:216](../../apps/backend/src/receipt/http-representation.ts#L216)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
