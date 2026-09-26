# http-transport

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Reads native HTTP requests and writes their representations: bounded JSON, preconditions, idempotency keys, entity tags, and cache headers. The [index](../constructs.md) lists every category.

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
- Source: [apps/backend/src/http-semantics.ts:361](../../apps/backend/src/http-semantics.ts#L361)

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
- Source: [apps/backend/src/http-semantics.ts:375](../../apps/backend/src/http-semantics.ts#L375)

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
- Source: [apps/backend/src/http-semantics.ts:404](../../apps/backend/src/http-semantics.ts#L404)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
