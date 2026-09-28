# http-transport

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Derives the transport facts that commands keep across the cutover from HTTP: command identities, request digests, preconditions, and entity tags. The [index](../constructs.md) lists every category.

## `encodePathIdentity`

Encodes one decoded identity as an uppercase RFC 3986 path segment.

```ts
encodePathIdentity(identity: string): string
```

- Inputs: `identity: string`
- Output: `string`
- Errors: none
- Throws: The `Problem` request.malformed when `identity` is not a string of Unicode scalar values, such as one with a lone surrogate.
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-semantics.ts:393](../../apps/backend/src/http-semantics.ts#L393)

**How it works**

`encodeURIComponent` escapes every character but the RFC 3986 unreserved ones and `!'()*`, and
it escapes those four too, so the segment holds only unreserved characters and uppercase
percent escapes. Equal identities give equal segments, which the normalized target of an
idempotency identity and a `Location` rely on.

**Use**

```ts
const location = `/api/admission-periods/${encodePathIdentity(period.id)}`;
```

**Avoid**

Interpolating a raw identity into a path, or escaping it with `encodeURI`: the path of one
resource then has several spellings, and their idempotency identities differ. Encode each
identity with this.

## `normalizeTarget`

Fills a route template with its encoded identities; a missing identity is a malformed request.

```ts
normalizeTarget(identities: Readonly<Record<string, string>>): (routeTemplate: string) => string
normalizeTarget(routeTemplate: string, identities: Readonly<Record<string, string>>): string
```

- Inputs:
  - `routeTemplate: string`
  - `identities: Readonly<Record<string, string>>`
- Output: `string`
- Errors: none
- Throws: The `Problem` request.malformed when `identities` lacks a name of the template, or an identity is not a string of Unicode scalar values.
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-semantics.ts:425](../../apps/backend/src/http-semantics.ts#L425)

**How it works**

Each `{name}` of `routeTemplate` becomes `encodePathIdentity(identities[name])`, and the rest of
the template stays as written. The result is the normalized target of an idempotency identity,
so one command on one resource derives one identity, however the client spelled the path.

**Use**

```ts
normalizeTarget("/api/teams/{teamId}/applications", { teamId });
```

**Avoid**

Taking the target from the request URL: two spellings of one path then derive two
identities, and a retry runs the command twice. Fill the route template of the endpoint.

## `deriveHttpIdentity`

Derives the private storage digest and domain command ID from the identity tuple.

```ts
deriveHttpIdentity(identity: NativeIdempotencyIdentity): DerivedHttpIdentity
```

- Inputs: `identity: NativeIdempotencyIdentity`
- Output: `DerivedHttpIdentity`
- Errors: none
- Throws: The `Problem` request.malformed when the subject, operation id, or target is outside its grammar, and idempotency-key.invalid when the key is.
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-semantics.ts:476](../../apps/backend/src/http-semantics.ts#L476)

**How it works**

The tuple is the credential subject, the qualified operation id, the normalized target, and the
Idempotency-Key. It checks each against its grammar, hashes the RFC 8785 canonical JSON of the
tuple with SHA-256, and answers the digest as lowercase hexadecimal, `identitySha256`, and as
`httpv2_` followed by its unpadded base64url, `commandId`. The same tuple always derives the
same pair, and a different subject, operation, target, or key derives another.

**Use**

```ts
const identity = deriveHttpIdentity({ credentialSubject: `Person:${personId}`, qualifiedOperationId: "recruitment.maintainRecruitment", normalizedTarget: "/api/recruitment/maintenance/commands", idempotencyKey });
```

**Avoid**

Hashing the request bytes, or building a key by hand: the body or header spelling then
changes the identity of one command. Derive it from the tuple, and digest the semantic request
apart from it with `semanticRequestDigest`.
