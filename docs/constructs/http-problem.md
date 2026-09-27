# http-problem

[//]: # "constructs: generated from the @construct tags and their JSDoc by just docs generate; do not edit"

Answers a native HTTP request with a declared problem: failure mapping, credential classification, authorization, and decoding. The [index](../constructs.md) lists every category.

## `authorizeAdmissionPerson`

Evaluates one admission person AccessSpec.

```ts
authorizeAdmissionPerson(
  request: Request,
  input: NativePersonAuthorization
): Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">>
```

- Inputs:
  - `request: Request`
  - `input: NativePersonAuthorization`
- Output: `Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">>`
- Errors: `Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/admission/http-access.ts:65](../../apps/backend/src/admission/http-access.ts#L65)

**How it works**

It runs `authorizePerson` with the credential that the request presented, then
`unreachable("resource.not-found")`: every admission AccessSpec reveals its denials, so
authorization never answers 404, and a concealment would be a defect.

**Use**

```ts
yield* authorizeAdmissionPerson(request, { spec, credential, personId, resolution, grantScopes, now });
```

**Avoid**

Calling `authorizePerson` in an admission handler and declaring resource.not-found on the
endpoint: admission specs reveal their denials, so that problem never occurs. Call this.

## `returningAuthorization`

Resolves the current person and authorizes one returning-assistant operation on that person's own profile.

```ts
returningAuthorization(
  request: Request,
  input: AdmissionApiHttpOptions,
  endpoint: | typeof ReadReturningAssistantOptionsEndpoint | typeof RegisterReturningAssistantEndpoint
): Effect.Effect<TransactionPersonAuthority, | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">, Database | Organization | IdentitySnapshot | OAuthCredentialAuthority>
```

- Inputs:
  - `request: Request`
  - `input: AdmissionApiHttpOptions`
  - `endpoint: | typeof ReadReturningAssistantOptionsEndpoint | typeof RegisterReturningAssistantEndpoint`
- Output: `Effect.Effect<TransactionPersonAuthority, | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">, Database | Organization | IdentitySnapshot | OAuthCredentialAuthority>`
- Errors: `| IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">`
- Requirements: `Database | Organization | IdentitySnapshot | OAuthCredentialAuthority`
- Side effects: Reads the person's session or token and organization authority in the caller's transaction.
- Source: [apps/backend/src/admission/http-access.ts:96](../../apps/backend/src/admission/http-access.ts#L96)

**How it works**

It resolves the request's person credential and organization authority in the caller's
transaction at one instant, then evaluates the endpoint's AccessSpec for that person over their
own `person-profile` resource, with the resource as the grant scope. It answers the resolved
authority, whose instant the command uses for its own reads.

**Use**

```ts
const authorization = yield* returningAuthorization(request, input, RegisterReturningAssistantEndpoint);
```

**Avoid**

Authorizing a returning-assistant operation with the actor of an admission period: the
operation acts on the person's own profile, not on a department. Resolve it with this.

## `admissionActorForAuthority`

The admission actor of one department scope.

```ts
admissionActorForAuthority(
  authority: OrganizationPersonAuthority,
  departmentScope?: string
): Effect.Effect<AdmissionPeriodActor, AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor>
```

- Inputs:
  - `authority: OrganizationPersonAuthority`
  - `departmentScope?: string`
- Output: `Effect.Effect<AdmissionPeriodActor, AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor>`
- Errors: `AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/admission/http-context.ts:76](../../apps/backend/src/admission/http-context.ts#L76)

**How it works**

It maps the organization authority of a person to the admission actor of `departmentScope`,
or to the person's own scope when none is given, and requires that actor to be active. The
mapping throws only its three denials, which become failures; anything else that it throws is a
defect.

**Use**

```ts
const actor = yield* admissionActorForAuthority(authorization.authority, payload.departmentId);
```

**Avoid**

Mapping the authority with `admissionActorForDepartment` in a handler: its denials are
throws, which escape the error channel as defects. Map it with this.

## `admissionProblems`

The one answer for every admission failure.

```ts
admissionProblems<Unavailable extends AdmissionUnavailable>(
  request: Request,
  unavailable: Unavailable
): ProblemMapper<AdmissionFailure, AdmissionCases<Unavailable>>
```

- Inputs:
  - `request: Request`
  - `unavailable: Unavailable`
- Output: `ProblemMapper<AdmissionFailure, AdmissionCases<Unavailable>>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/admission/http-problem.ts:125](../../apps/backend/src/admission/http-problem.ts#L125)

**How it works**

A failed store or dependency answers the endpoint's own unavailable problem, `unavailable`: a
read answers admissions.unavailable, a command dependency.unavailable, and a returning-assistant
operation returning.unavailable. A rejected credential answers from the credential that the
request presented. A command that does not decode answers validation.failed at the root, and an
unknown department or semester answers validation.failed at its member.

**Use**

```ts
command.pipe(admissionProblems(request, "dependency.unavailable"));
```

**Avoid**

Mapping an admission failure in a handler: the answers of the admission endpoints drift
apart. Pipe the handler's effect through this, with the endpoint's unavailable problem.

## `authorizeContentOperation`

Evaluates a content endpoint's AccessSpec for one person with the content grant scope.

```ts
authorizeContentOperation(
  input: { readonly endpoint: ContentEndpoint; readonly personId: PersonId; readonly authorizationInstant: string; readonly credential?: Extract<CredentialOutcome, { readonly _tag: "Accepted" }>; readonly request?: Request; readonly resolution: CanonicalScopeResolution<Schema.JsonObject>; readonly presentation: CredentialPresentation }
): Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">>
```

- Inputs: `input: { readonly endpoint: ContentEndpoint; readonly personId: PersonId; readonly authorizationInstant: string; readonly credential?: Extract<CredentialOutcome, { readonly _tag: "Accepted" }>; readonly request?: Request; readonly resolution: CanonicalScopeResolution<Schema.JsonObject>; readonly presentation: CredentialPresentation }`
- Output: `Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">>`
- Errors: `Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/content/http-access.ts:43](../../apps/backend/src/content/http-access.ts#L43)

**How it works**

It runs `authorizePerson` with the endpoint's AccessSpec, the content domain as the grant scope,
and `resolution` at `authorizationInstant`. A command passes the credential that its
transaction resolved; a read passes the request, from which the credential is derived. Content
access reveals every denial, so `unreachable("resource.not-found")` removes the concealment
answer.

**Use**

```ts
yield* authorizeContentOperation({ endpoint: ReviseArticleEndpoint, credential: actor.credential, personId: actor.personId, authorizationInstant, resolution, presentation });
```

**Avoid**

Granting a content operation from a role check in the handler: the AccessSpec of the
contract then stops being the authority for the endpoint. Evaluate it with this.

## `contentProblems`

The one answer for every content domain failure.

```ts
const contentProblems: ProblemMapper<ContentFailure, typeof contentCases>
```

- Inputs: none
- Output: `ProblemMapper<ContentFailure, typeof contentCases>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/content/http-problem.ts:61](../../apps/backend/src/content/http-problem.ts#L61)

**How it works**

An inactive authority, a department outside the actor's scope, a missing publisher role, and
another author's draft answer authority.denied. The article, slug, department, and lifecycle
failures answer their content problems, an unavailable store answers content.unavailable, and a
stored value that does not decode answers internal.error.

**Use**

```ts
read.pipe(contentProblems, contentActorProblems(presentation));
```

**Avoid**

Mapping a content failure in a handler: the content endpoints then answer one failure
differently. Pipe the handler's effect through this.

## `contentActorProblems`

A staff person rejected after ingress is answered from the credential the request presented.

```ts
contentActorProblems(
  presentation: CredentialPresentation
): ProblemMapper<ContentActorFailure, ContentActorCases>
```

- Inputs: `presentation: CredentialPresentation`
- Output: `ProblemMapper<ContentActorFailure, ContentActorCases>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/content/http-problem.ts:101](../../apps/backend/src/content/http-problem.ts#L101)

**How it works**

A rejected staff person answers `Problem.unauthenticated(presentation)`: credential.missing or
credential.invalid, as the request's evidence says. An unavailable identity or organization
projection answers internal.error.

**Use**

```ts
read.pipe(contentProblems, contentActorProblems(presentation));
```

**Avoid**

Answering a rejected staff person with a fixed credential code: a request that presented
a rejected session would be told that it presented none. Pipe the actor resolution through this.

## `problemWebResponse`

Renders one problem outside HttpApi encoding, with the encoder's body and headers.

```ts
problemWebResponse(problem: Problem): Response
```

- Inputs: `problem: Problem`
- Output: `Response`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:77](../../apps/backend/src/http-api/problem.ts#L77)

**How it works**

The body is the JSON text of `problemBody(problem)`, the status is `problem.status`, and the
headers are those of `problemHeaders(problem)` with `content-type: application/problem+json`:
the answer that HttpApiBuilder encodes for a declared problem. It answers where no endpoint
encodes: an origin denial, a method outside the allowed set, an unknown path, and the internal
error of `ProblemBoundaryLive`.

**Use**

```ts
const response = problemWebResponse(Problem.make("method.not-allowed"));
```

**Avoid**

Building a problem response by hand: its body or headers drift from the frozen encoding
that clients decode. Render the `Problem` with this.

## `jsonText`

The JSON text of a representation, byte for byte what `JSON.stringify` writes.

```ts
jsonText<A>(value: A): Effect.Effect<string>
```

- Inputs: `value: A`
- Output: `Effect.Effect<string>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:105](../../apps/backend/src/http-api/problem.ts#L105)

**How it works**

It encodes `value` with `Schema.fromJsonString(Schema.Unknown)`. A value that JSON cannot
represent, such as a `bigint`, fails the encoding, and the failure becomes a defect, which
`ProblemBoundaryLive` answers as internal.error.

**Use**

```ts
return new Response(yield* jsonText(body), { headers: { "content-type": "application/json" } });
```

**Avoid**

`JSON.stringify` in a handler: it throws outside the error channel, and
`effecttsgo/prefer-schema-over-json` rejects it. Write the text with `jsonText`.

## `webHandler`

Runs one Effect-native Web transport operation.

```ts
webHandler<E, R>(
  request: HttpServerRequest.HttpServerRequest,
  handle: (request: Request) => Effect.Effect<Response, E, R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
```

- Inputs:
  - `request: HttpServerRequest.HttpServerRequest`
  - `handle: (request: Request) => Effect.Effect<Response, E, R>`
- Output: `Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>`
- Errors: `E`
- Requirements: `R`
- Side effects: none of its own; it runs `handle`.
- Source: [apps/backend/src/http-api/problem.ts:143](../../apps/backend/src/http-api/problem.ts#L143)

**How it works**

It converts the HttpApi request to a Web `Request`, runs `handle`, and converts the `Response`
back; a request that does not convert is a defect. The typed failures of `handle` stay in the
error channel, where HttpApiBuilder encodes each against the endpoint's declared problems, so a
problem that the endpoint does not declare fails its type check.

**Use**

```ts
.handleRaw("readTeamApplication", ({ request, params }) => webHandler(request, (webRequest) => readApplication(webRequest, params.applicationId)))
```

**Avoid**

Answering a failure inside `handle` with a hand-built `Response`: HttpApiBuilder then
cannot check it against the endpoint's declared problems. Fail with the `Problem`.

## `semanticProblem`

Runs a throwing semantic parser.

```ts
semanticProblem<A, const Code extends PlainProblemCode>(
  parse: () => A,
  codes: ReadonlyArray<Code>
): Effect.Effect<A, Problem<Code>>
```

- Inputs:
  - `parse: () => A`
  - `codes: ReadonlyArray<Code>`
- Output: `Effect.Effect<A, Problem<Code>>`
- Errors: `Problem<Code>`
- Requirements: none
- Side effects: none of its own; it runs `parse`.
- Source: [apps/backend/src/http-api/problem.ts:174](../../apps/backend/src/http-api/problem.ts#L174)

**How it works**

`parse` runs when the effect runs. A thrown `Problem` whose code is in `codes` becomes a failure
with that code; any other throw, a problem of another code included, is a defect. The HTTP
semantic parsers, such as `normalizeTarget`, throw their problems, so an Effect handler calls
them through this.

**Use**

```ts
const normalizedTarget = yield* semanticProblem(() => normalizeTarget(routeTemplate, identities), ["request.malformed"]);
```

**Avoid**

`Effect.try` with a hand-written catch around a parser: an unexpected throw then becomes
a failure that the endpoint does not declare. List the codes that the endpoint declares here.

## `problemMapper`

Builds the one failure-to-problem mapper of a domain.

```ts
problemMapper<Failure extends TaggedFailure>(): (<const Cases extends ProblemCases<Failure>>(cases: ExactCases<Failure, Cases>) => ProblemMapper<Failure, Cases>)
```

- Inputs: none
- Output: `(<const Cases extends ProblemCases<Failure>>(cases: ExactCases<Failure, Cases>) => ProblemMapper<Failure, Cases>)`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:251](../../apps/backend/src/http-api/problem.ts#L251)

**How it works**

`problemMapper<Failure>()(cases)` takes one case per tag of `Failure` and no other key. The
mapper maps each failure of an effect whose tag has a case to the problem that its case
returns, and it passes every other failure through unchanged, so an unmapped failure still
reaches, and fails, the endpoint's type check. The mapped error channel keeps only the problems
that the effect's own failures map to. A mapper constant declares its type as
`ProblemMapper<Failure, typeof cases>`, with its cases in a constant that `satisfies`
`ProblemCases<Failure>`. A mapper that a function builds per request adds `CredentialCases`
and `OutageCases` to its constant cases, for the answers that depend on its arguments.

**Use**

```ts
const storedReceiptProblems = problemMapper<ReceiptDecodeError>()({ ReceiptDecodeError: () => Problem.make("receipts.unavailable") });
```

**Avoid**

Mapping a domain's failures with `Effect.mapError` or `Effect.catchTag` in each handler:
the copies drift apart, so one failure gets different problems on different endpoints. Map each
domain once and pipe its mapper.

## `requireNoQuery`

An operation that accepts no query answers any query as malformed.

```ts
requireNoQuery(request: Request): Effect.Effect<void, Problem<"request.malformed">>
```

- Inputs: `request: Request`
- Output: `Effect.Effect<void, Problem<"request.malformed">>`
- Errors: `Problem<"request.malformed">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:305](../../apps/backend/src/http-api/problem.ts#L305)

**How it works**

A request whose URL has a non-empty query fails with request.malformed, so an operation that
declares no query parameter never answers as if it had applied one.

**Use**

```ts
yield* requireNoQuery(request);
```

**Avoid**

Ignoring an unexpected query: a client that sends a filter that the operation does not
know gets an unfiltered answer that looks filtered. Call it first in an operation without query
parameters.

## `readJsonBody`

Reads a bounded JSON body of the one media type `mediaType` accepts.

```ts
readJsonBody(
  request: Request,
  mediaType: RegExp,
  maxBytes: number
): Effect.Effect<Schema.Json, | Problem<"media-type.unsupported"> | Problem<"request.malformed"> | Problem<"request.too-large"> | Problem<"internal.error">>
```

- Inputs:
  - `request: Request`
  - `mediaType: RegExp`
  - `maxBytes: number`
- Output: `Effect.Effect<Schema.Json, | Problem<"media-type.unsupported"> | Problem<"request.malformed"> | Problem<"request.too-large"> | Problem<"internal.error">>`
- Errors: `| Problem<"media-type.unsupported"> | Problem<"request.malformed"> | Problem<"request.too-large"> | Problem<"internal.error">`
- Requirements: none
- Side effects: Reads and consumes the request body.
- Source: [apps/backend/src/http-api/problem.ts:333](../../apps/backend/src/http-api/problem.ts#L333)

**How it works**

A `content-type` that `mediaType` does not match fails with media-type.unsupported before a
byte is read. `readBoundedJson` then reads the body: a malformed or too large Content-Length
fails at once, the bytes are counted as they arrive and fail with request.too-large past
`maxBytes`, and the JSON parses without duplicate member names, else request.malformed. A body
that cannot be read is internal.error. It takes the body reader when it is called, not when
the effect runs.

**Use**

```ts
const body = yield* readJsonBody(request, /^application\/json(?:\s*;|$)/iu, MAX_SUBMISSION_BYTES);
```

**Avoid**

`request.json()`: it reads without a bound, accepts duplicate member names, and throws
outside the error channel. Read the body with this.

## `idempotencyKeyOf`

Decodes the one Idempotency-Key a replayable mutation requires.

```ts
idempotencyKeyOf(
  request: Request
): Effect.Effect<IdempotencyKey, Problem<"idempotency-key.invalid">>
```

- Inputs: `request: Request`
- Output: `Effect.Effect<IdempotencyKey, Problem<"idempotency-key.invalid">>`
- Errors: `Problem<"idempotency-key.invalid">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:368](../../apps/backend/src/http-api/problem.ts#L368)

**How it works**

`parseIdempotencyKey` decodes the Idempotency-Key field: exactly one field, with no comma, of
the frozen key grammar. A missing, repeated, or malformed key fails with
idempotency-key.invalid.

**Use**

```ts
const idempotencyKey = yield* idempotencyKeyOf(request);
```

**Avoid**

Reading the field with `request.headers.get` and trimming it: a repeated or malformed key
then reaches the command identity. Decode it with this before `httpIdentity`.

## `requiredIfMatchOf`

Decodes the one strong If-Match an item mutation requires.

```ts
requiredIfMatchOf(
  request: Request
): Effect.Effect<StrongETag, Problem<"precondition.invalid" | "precondition.required">>
```

- Inputs: `request: Request`
- Output: `Effect.Effect<StrongETag, Problem<"precondition.invalid" | "precondition.required">>`
- Errors: `Problem<"precondition.invalid" | "precondition.required">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:396](../../apps/backend/src/http-api/problem.ts#L396)

**How it works**

`parseRequiredIfMatch` decodes the If-Match field: no field fails with precondition.required,
and anything but one strong entity tag, such as a weak tag, a list, or `*`, fails with
precondition.invalid.

**Use**

```ts
const ifMatch = yield* requiredIfMatchOf(request);
```

**Avoid**

Treating a missing If-Match as a match: a client that never read the representation
overwrites a concurrent change. Require it, and compare it with `requireCurrentETag`.

## `httpIdentity`

Derives a command's idempotency identity; a tuple outside the frozen grammar is a request problem.

```ts
httpIdentity(
  identity: NativeIdempotencyIdentity
): Effect.Effect<DerivedHttpIdentity, Problem<"idempotency-key.invalid" | "request.malformed">>
```

- Inputs: `identity: NativeIdempotencyIdentity`
- Output: `Effect.Effect<DerivedHttpIdentity, Problem<"idempotency-key.invalid" | "request.malformed">>`
- Errors: `Problem<"idempotency-key.invalid" | "request.malformed">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:425](../../apps/backend/src/http-api/problem.ts#L425)

**How it works**

It runs `deriveHttpIdentity` through `semanticProblem`: a credential subject, operation id, or
target outside its grammar fails with request.malformed, and a key outside its grammar with
idempotency-key.invalid. `commandId` and `identitySha256` key the command receipt of the
mutation.

**Use**

```ts
const identity = yield* httpIdentity({ credentialSubject: `Person:${personId}`, qualifiedOperationId: operationId, normalizedTarget, idempotencyKey });
```

**Avoid**

Calling `deriveHttpIdentity` directly in an Effect handler: its throw escapes the error
channel and becomes a defect, internal.error, instead of the declared request problem.

## `requireCurrentETag`

Fails a mutation whose If-Match no longer names the current representation.

```ts
requireCurrentETag(
  current: StrongETag,
  ifMatch: StrongETag
): Effect.Effect<void, Problem<"precondition.failed">>
```

- Inputs:
  - `current: StrongETag`
  - `ifMatch: StrongETag`
- Output: `Effect.Effect<void, Problem<"precondition.failed">>`
- Errors: `Problem<"precondition.failed">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:454](../../apps/backend/src/http-api/problem.ts#L454)

**How it works**

`evaluateMutationPrecondition` compares the strong tag of the current representation with the
one that If-Match named: equal tags proceed, and different ones fail with precondition.failed.
A command runs it in its transaction, after authorization and concealment, on the state that
it is about to change.

**Use**

```ts
service.reviseIntake(command, staff.principal, (current) => requireCurrentETag(intakeETag(teamId, current.revision), ifMatch));
```

**Avoid**

Comparing tags before the transaction, as a preflight read: a concurrent change can
commit between the check and the write. Compare inside the transaction that writes.

## `conditionalJson`

Answers a conditional JSON read after authority and concealment: the representation, a bodyless 304, or precondition.failed.

```ts
conditionalJson(
  input: { readonly request: Request; readonly body: unknown; readonly etag: StrongETag; readonly cacheControl: string; readonly contentType: "application/json" | "application/json; charset=utf-8" }
): Effect.Effect<Response, Problem<"precondition.failed"> | Problem<"precondition.invalid">>
```

- Inputs: `input: { readonly request: Request; readonly body: unknown; readonly etag: StrongETag; readonly cacheControl: string; readonly contentType: "application/json" | "application/json; charset=utf-8" }`
- Output: `Effect.Effect<Response, Problem<"precondition.failed"> | Problem<"precondition.invalid">>`
- Errors: `Problem<"precondition.failed"> | Problem<"precondition.invalid">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:485](../../apps/backend/src/http-api/problem.ts#L485)

**How it works**

It parses If-Match and If-None-Match, and a field outside their grammar fails with
precondition.invalid. An If-Match without the current strong tag fails with
precondition.failed. An If-None-Match that names the current tag, or `*`, answers a bodyless 304
with the tag, the cache policy, and `Vary: Origin`. Otherwise it answers 200 with the JSON text
of `body` and the same headers.

**Use**

```ts
return yield* conditionalJson({ request, body, etag, cacheControl: PRIVATE_NO_STORE, contentType: "application/json" });
```

**Avoid**

Evaluating the conditions before authorization and concealment: a 304 or 412 then tells a
caller that a resource it may not see exists. Answer the read with this, last.

## `personPresentation`

The person credential a request presented, for a rejection answered after ingress.

```ts
personPresentation(
  request: Request,
  challenge: string = nativeUserChallenges()
): CredentialPresentation
```

- Inputs:
  - `request: Request`
  - `challenge: string = nativeUserChallenges()`
- Output: `CredentialPresentation`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:549](../../apps/backend/src/http-api/problem.ts#L549)

**How it works**

It classifies the raw request once: an Authorization field or a Better Auth session cookie
counts as presented, whatever its validity. `Problem.unauthenticated` answers this evidence with
credential.missing for an absent credential and credential.invalid for a presented one, with
`challenge` in `WWW-Authenticate`; the default challenge names the native session cookie and
bearer tokens.

**Use**

```ts
const presentation = personPresentation(request);
```

**Avoid**

Choosing credential.missing or credential.invalid by string: a request that sent a
rejected token would be told that it sent none. Answer a rejected credential from this evidence
with `Problem.unauthenticated`.

## `isSerializationConflict`

Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.

```ts
isSerializationConflict(cause: unknown, depth: number = 0): boolean
```

- Inputs:
  - `cause: unknown`
  - `depth: number = 0`
- Output: `boolean`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:580](../../apps/backend/src/http-api/problem.ts#L580)

**How it works**

It follows `cause` through its `cause` members, at most eight levels deep. A `code` of SQLSTATE
40001 (serialization failure) or 40P01 (deadlock detected), or a `reason` tagged
`SerializationError` or `DeadlockError`, is such a race.

**Use**

```ts
isSerializationConflict(failure) ? Problem.make("transaction.conflict") : failure;
```

**Avoid**

Matching SQLSTATEs or messages in each handler: a race that a wrapper carries one level
deeper then answers internal.error instead of a retryable conflict. Classify it with this.

## `requestInvalid`

The request as a whole fails validation; no single member is singled out.

```ts
requestInvalid(): Problem<"validation.failed">
```

- Inputs: none
- Output: `Problem<"validation.failed">`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:609](../../apps/backend/src/http-api/problem.ts#L609)

**How it works**

It is validation.failed with one diagnostic, code `invalid`, at the root pointer `""`. A domain
that decodes a whole command at once cannot name the member that failed, so it answers this.

**Use**

```ts
AdmissionPeriodDecodeError: requestInvalid,
```

**Avoid**

Echoing the schema issue, or pointing at a guessed member: the answer then leaks decoding
internals or misleads the client. Answer the whole request with this, or build
`Problem.validation` with the pointers that the decoder knows.

## `decodeRequest`

Decodes one JSON request value strictly; any mismatch fails the whole request's validation.

```ts
decodeRequest<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S
): ((value: Schema.Json) => Effect.Effect<S["Type"], Problem<"validation.failed">, S["DecodingServices"]>)
```

- Inputs: `schema: S`
- Output: `((value: Schema.Json) => Effect.Effect<S["Type"], Problem<"validation.failed">, S["DecodingServices"]>)`
- Errors: none
- Requirements: none
- Side effects: none of its own; it runs the decoding services of `schema`.
- Source: [apps/backend/src/http-api/problem.ts:632](../../apps/backend/src/http-api/problem.ts#L632)

**How it works**

It decodes `value` with `schema` and rejects excess properties (`onExcessProperty: "error"`).
Any mismatch fails with `requestInvalid()`: one validation.failed problem for the request.

**Use**

```ts
const body = yield* decodeRequest(CreateSocialEventRequest)(json);
```

**Avoid**

Decoding a request with the default options of `Schema.decodeUnknownEffect`: excess
properties then pass silently, and the schema error is a failure that the endpoint does not
declare. Decode request values with this.

## `strictOutput`

Decodes one response value strictly.

```ts
strictOutput<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S
): ((value: S["Type"]) => Effect.Effect<S["Type"], never, S["DecodingServices"]>)
```

- Inputs: `schema: S`
- Output: `((value: S["Type"]) => Effect.Effect<S["Type"], never, S["DecodingServices"]>)`
- Errors: none
- Requirements: none
- Side effects: none of its own; it runs the decoding services of `schema`.
- Source: [apps/backend/src/http-api/problem.ts:663](../../apps/backend/src/http-api/problem.ts#L663)

**How it works**

It decodes the value that a handler is about to answer with the response schema and rejects
excess properties, so a private field that the domain value carries cannot reach the response.
A mismatch is a defect, which `ProblemBoundaryLive` answers as internal.error.

**Use**

```ts
return yield* strictOutput(SocialEventListResource)(body);
```

**Avoid**

Answering a domain value as it is, or through a spread: its private fields then reach the
client. Decode it with the response schema first.

## `commandReceiptProblems`

HTTP command receipts: the transport's own persistence failures.

```ts
const commandReceiptProblems: ProblemMapper<NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError, typeof commandReceiptCases>
```

- Inputs: none
- Output: `ProblemMapper<NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError, typeof commandReceiptCases>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:698](../../apps/backend/src/http-api/problem.ts#L698)

**How it works**

An invalid stored receipt answers internal.error. A receipt persistence failure answers
transaction.conflict when it lost a serialization race, and idempotency.unavailable otherwise.
A replayable mutation pipes its command effect through its domain mapper, then through this.

**Use**

```ts
command.pipe(teamApplicationProblems, commandReceiptProblems);
```

**Avoid**

Mapping receipt failures in a domain mapper: each domain would answer the transport's own
failures differently. Pipe this after the domain's mapper.

## `commandOutcomeResponse`

Answers a command receipt outcome: committed and replayed results, or an idempotency problem.

```ts
commandOutcomeResponse(
  outcome: NativeHttpCommandOutcome
): Effect.Effect<Response, | Problem<"idempotency.in-flight"> | Problem<"idempotency.digest-conflict"> | Problem<"idempotency.response-expired">>
```

- Inputs: `outcome: NativeHttpCommandOutcome`
- Output: `Effect.Effect<Response, | Problem<"idempotency.in-flight"> | Problem<"idempotency.digest-conflict"> | Problem<"idempotency.response-expired">>`
- Errors: `| Problem<"idempotency.in-flight"> | Problem<"idempotency.digest-conflict"> | Problem<"idempotency.response-expired">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:727](../../apps/backend/src/http-api/problem.ts#L727)

**How it works**

A committed or replayed outcome answers its stored response capsule with
`Cache-Control: no-store`, so a replay returns the status, bytes, and headers of the first
answer. A command that still runs under the key fails with idempotency.in-flight, a key reused
for another request with idempotency.digest-conflict, and a response that is no longer kept
with idempotency.response-expired.

**Use**

```ts
return yield* commandOutcomeResponse(outcome);
```

**Avoid**

Rebuilding the response of a replay from the current state: a retry then sees another
answer than the first attempt. Answer every outcome through this.

## `authorizeAnonymous`

An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and its scope resolution disagree: a defect.

```ts
authorizeAnonymous(
  spec: AccessSpec,
  resolution: CanonicalScopeResolution<Schema.JsonObject>,
  now: string
): Effect.Effect<void>
```

- Inputs:
  - `spec: AccessSpec`
  - `resolution: CanonicalScopeResolution<Schema.JsonObject>`
  - `now: string`
- Output: `Effect.Effect<void>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:766](../../apps/backend/src/http-api/problem.ts#L766)

**How it works**

It evaluates `spec` for the anonymous principal, with no grants, over `resolution` at `now`. A
public operation calls it with the scope that it resolved, so the AccessSpec of the contract
stays the one authority. A denial dies with the HTTP status of the evaluation.

**Use**

```ts
yield* authorizeAnonymous(Option.getOrThrow(reflectAccessSpec(ReadTeamApplicationIntakeEndpoint)), resolution, instant);
```

**Avoid**

Skipping the evaluation because the operation is public: the declared AccessSpec and the
handler then drift apart unnoticed. Evaluate it, so that a mismatch is a defect.

## `authorizePerson`

A rejected person credential is answered from the ingress evidence, never by string choice.

```ts
authorizePerson(
  input: NativePersonAuthorization,
  presentation: CredentialPresentation
): Effect.Effect<void, | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">>
```

- Inputs:
  - `input: NativePersonAuthorization`
  - `presentation: CredentialPresentation`
- Output: `Effect.Effect<void, | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">>`
- Errors: `| Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:799](../../apps/backend/src/http-api/problem.ts#L799)

**How it works**

It evaluates the AccessSpec of `input` for the person, with a grant for each capability of the
spec in each grant scope. An evaluation of 401 answers `Problem.unauthenticated(presentation)`,
404 answers resource.not-found for a concealed resource, and 403 answers authority.denied. An
operation whose spec reveals every denial pipes `unreachable("resource.not-found")` after it.

**Use**

```ts
yield* authorizePerson({ spec, credential: authorization.credential, personId, resolution, grantScopes, now }, personPresentation(request));
```

**Avoid**

Choosing the answer to a denial in the handler: a concealed resource would answer 403
and reveal that it exists, or a credential answer would ignore the ingress evidence. Map the
evaluation with this.

## `unreachable`

Marks problems a shared mapper can produce but this operation cannot, such as a serialization conflict inside a read-only snapshot.

```ts
unreachable<const Code extends NativeProblemCode>(
  code: Code,
  ...codes: ReadonlyArray<Code>
): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, Exclude<E, Extract<E, Problem<Code>>>, R>)
```

- Inputs:
  - `code: Code`
  - `...codes: ReadonlyArray<Code>`
- Output: `(<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, Exclude<E, Extract<E, Problem<Code>>>, R>)`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/http-api/problem.ts:841](../../apps/backend/src/http-api/problem.ts#L841)

**How it works**

It turns each failure that is a problem with one of the listed codes into a defect, which
`ProblemBoundaryLive` answers as internal.error, and removes those problems from the error
channel, so the endpoint need not declare them. At least one code is required: an empty list
would widen `Code` to every code and erase every problem.

**Use**

```ts
authorizePerson(input, presentation).pipe(unreachable("resource.not-found"));
```

**Avoid**

Declaring a problem on an endpoint only because a shared mapper can produce it: the
contract then promises an answer that the operation never gives. Mark it unreachable here.

## `ProblemBoundaryLive`

The only Cause consumer.

```ts
const ProblemBoundaryLive: Layer.Layer<never, never, HttpRouter.HttpRouter>
```

- Inputs: none
- Output: `Layer.Layer<never, never, HttpRouter.HttpRouter>`
- Errors: none
- Requirements: `HttpRouter.HttpRouter`
- Side effects: Reports each cause that it answers through `ErrorReporter`.
- Source: [apps/backend/src/http-api/problem.ts:884](../../apps/backend/src/http-api/problem.ts#L884)

**How it works**

A global router middleware. HttpApiBuilder has already answered every declared typed failure, so
a cause that reaches this boundary is a defect, an interrupt, or a failure that no endpoint
declared. It reports the cause through `ErrorReporter` and answers the frozen internal.error
problem. A cause of interrupts only that a client abort annotates passes through unanswered,
because the client is gone.

**Use**

```ts
return Layer.mergeAll(nativeRoutes, notFound, ProblemBoundaryLive);
```

**Avoid**

Catching defects or rendering causes in a handler or another middleware: a cause then
reaches the client, or a fault goes unreported. Leave causes to this boundary.

## `receiptProblems`

The one answer for every receipt failure other than a rejected credential, including an unavailable store, Identity, or E2E barrier.

```ts
const receiptProblems: ProblemMapper<ReceiptHttpFailure, typeof receiptCases>
```

- Inputs: none
- Output: `ProblemMapper<ReceiptHttpFailure, typeof receiptCases>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/receipt/http-problem.ts:80](../../apps/backend/src/receipt/http-problem.ts#L80)

**How it works**

An inactive actor, a denied owner, scope, or authority, and an ambiguous or failed authority
requirement answer authority.denied. The receipt, settlement, file, and idempotency failures
answer their receipt problems, and a command that does not decode answers validation.failed at
the root. The store, the file store, Identity, SQL, and a timeout of the E2E barrier answer
receipts.unavailable.

**Use**

```ts
command.pipe(receiptProblems, commandReceiptProblems, receiptCredentialProblems(presentation));
```

**Avoid**

Mapping a receipt failure in a handler: the receipt endpoints then answer one failure
differently. Pipe the handler's effect through this.

## `receiptCredentialProblems`

A credential rejected inside a receipt handler is answered from the request's own evidence.

```ts
receiptCredentialProblems(
  presentation: CredentialPresentation
): ProblemMapper<UnauthenticatedActor, CredentialCases<"UnauthenticatedActor">>
```

- Inputs: `presentation: CredentialPresentation`
- Output: `ProblemMapper<UnauthenticatedActor, CredentialCases<"UnauthenticatedActor">>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/receipt/http-problem.ts:110](../../apps/backend/src/receipt/http-problem.ts#L110)

**How it works**

The rejection answers `Problem.unauthenticated(presentation)`: credential.missing when the
request presented no credential, and credential.invalid when it presented one that was
rejected.

**Use**

```ts
command.pipe(receiptProblems, commandReceiptProblems, receiptCredentialProblems(presentation));
```

**Avoid**

Answering a rejected credential with a fixed code: a request that presented a rejected
credential would be told that it presented none. Pipe the handler's effect through this.

## `authorizeInvitationOperation`

Authorizes the holder of an invitation's response capability.

```ts
authorizeInvitationOperation(
  input: { readonly spec: AccessSpec; readonly source: RecruitmentInvitationHttpSource; readonly authorizationInstant: string }
): Effect.Effect<void, Problem<"resource.not-found">>
```

- Inputs: `input: { readonly spec: AccessSpec; readonly source: RecruitmentInvitationHttpSource; readonly authorizationInstant: string }`
- Output: `Effect.Effect<void, Problem<"resource.not-found">>`
- Errors: `Problem<"resource.not-found">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/recruitment/http-access.ts:79](../../apps/backend/src/recruitment/http-access.ts#L79)

**How it works**

It evaluates the invitation AccessSpec for the capability holder, with one grant of the
spec's one capability on the invitation resource, over the invitation's recruitment context
at `authorizationInstant`. The invitation AccessSpec conceals every denial as not found, so a
denial answers resource.not-found and no other rejection exists. A spec with another capability
set, or a revealed denial, is a defect.

**Use**

```ts
yield* authorizeInvitationOperation({ spec: Option.getOrThrow(reflectAccessSpec(ReadInvitationResponseEndpoint)), source: snapshot.source, authorizationInstant: now });
```

**Avoid**

Checking the capability digest against the invitation in the handler: the AccessSpec of
the contract then stops being the authority, and a denial can reveal that the invitation
exists. Authorize the holder with this.

## `interviewAuthorizationInTransaction`

Resolves the current person and authorizes one interview inside the caller's transaction; a rejected credential is answered from the request's evidence.

```ts
interviewAuthorizationInTransaction<R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  endpoint: | typeof ScheduleInterviewEndpoint | typeof ReadInterviewConductEndpoint | typeof FinalizeInterviewEndpoint | typeof CancelInterviewEndpoint | typeof CorrectInterviewAssessmentEndpoint,
  allowLeader: boolean,
  input: RecruitmentApiHttpOptions<R>
): Effect.Effect<InterviewAuthorization, | RecruitmentFailure | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">, Database | IdentitySnapshot | OAuthCredentialAuthority | Organization | Recruitment>
```

- Inputs:
  - `request: Request`
  - `interviewId: RecruitmentInterviewId`
  - `endpoint: | typeof ScheduleInterviewEndpoint | typeof ReadInterviewConductEndpoint | typeof FinalizeInterviewEndpoint | typeof CancelInterviewEndpoint | typeof CorrectInterviewAssessmentEndpoint`
  - `allowLeader: boolean`
  - `input: RecruitmentApiHttpOptions<R>`
- Output: `Effect.Effect<InterviewAuthorization, | RecruitmentFailure | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">, Database | IdentitySnapshot | OAuthCredentialAuthority | Organization | Recruitment>`
- Errors: `| RecruitmentFailure | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">`
- Requirements: `Database | IdentitySnapshot | OAuthCredentialAuthority | Organization | Recruitment`
- Side effects: Reads the person's credential and authority, and takes recruitment's locks in the caller's transaction.
- Source: [apps/backend/src/recruitment/http-access.ts:253](../../apps/backend/src/recruitment/http-access.ts#L253)

**How it works**

It resolves the request's person credential and organization authority at one instant, lets
recruitment prepare the interview, which takes applicant custody before interview or receipt
locks, and evaluates the endpoint's AccessSpec over the interview's access context, with the
interview as the grant scope. `allowLeader` admits the department's administrator. It answers
the actor, the instant, and the interview source that the command uses.

**Use**

```ts
const authorization = yield* interviewAuthorizationInTransaction(request, interviewId, ScheduleInterviewEndpoint, true, input);
```

**Avoid**

Authorizing outside the command's transaction, or before recruitment prepares the
interview: the authority or the interview can change before the command writes. Call it first
inside the transaction that writes.

## `readRecruitmentBody`

Every recruitment request body is one bounded `application/json` document.

```ts
readRecruitmentBody(
  request: Request,
  maxBodyBytes: number
): Effect.Effect<Schema.Json, | Problem<"internal.error"> | Problem<"media-type.unsupported"> | Problem<"request.malformed"> | Problem<"request.too-large">>
```

- Inputs:
  - `request: Request`
  - `maxBodyBytes: number`
- Output: `Effect.Effect<Schema.Json, | Problem<"internal.error"> | Problem<"media-type.unsupported"> | Problem<"request.malformed"> | Problem<"request.too-large">>`
- Errors: `| Problem<"internal.error"> | Problem<"media-type.unsupported"> | Problem<"request.malformed"> | Problem<"request.too-large">`
- Requirements: none
- Side effects: Reads and consumes the request body when the effect runs.
- Source: [apps/backend/src/recruitment/http-decode.ts:32](../../apps/backend/src/recruitment/http-decode.ts#L32)

**How it works**

It reads the body with `readJsonBody` for the media type `application/json`, with or without
parameters, up to `maxBodyBytes`. `Effect.suspend` takes the body reader when the effect runs,
not when it is built, so a handler that builds the effect and never runs it leaves the body
unread.

**Use**

```ts
const body = yield* readRecruitmentBody(request, input.config.maxBodyBytes);
```

**Avoid**

A recruitment handler that reads its body with its own media type pattern or bound: the
recruitment endpoints then accept different bodies. Read it with this.

## `recruitmentProblems`

The one answer for every recruitment failure.

```ts
recruitmentProblems<const Unavailable extends RecruitmentUnavailable>(
  presentation: CredentialPresentation,
  unavailable: Unavailable
): ProblemMapper<RecruitmentHttpFailure, RecruitmentCases<Unavailable>>
```

- Inputs:
  - `presentation: CredentialPresentation`
  - `unavailable: Unavailable`
- Output: `ProblemMapper<RecruitmentHttpFailure, RecruitmentCases<Unavailable>>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/recruitment/http-problem.ts:126](../../apps/backend/src/recruitment/http-problem.ts#L126)

**How it works**

Reads answer an outage as recruitment.unavailable and mutations as dependency.unavailable,
through `unavailable`. A rejected credential answers from the request's own evidence, a denied
actor answers authority.denied, a replayed command with other content answers
idempotency.digest-conflict, and each other recruitment failure answers its recruitment
problem. What remains is a fault of recruitment itself or of a dependency's contract, and
answers internal.error.

**Use**

```ts
read.pipe(recruitmentProblems(personPresentation(request), "recruitment.unavailable"));
```

**Avoid**

Mapping a recruitment failure in a handler: the recruitment endpoints then answer one
failure differently. Pipe the handler's effect through this, with the endpoint's unavailable
problem.

## `raceProblems`

A failure that lost a serialization or deadlock race answers transaction.conflict, whatever failure carried it.

```ts
raceProblems<A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | Problem<"transaction.conflict">, R>
```

- Inputs: `effect: Effect.Effect<A, E, R>`
- Output: `Effect.Effect<A, E | Problem<"transaction.conflict">, R>`
- Errors: `E | Problem<"transaction.conflict">`
- Requirements: `R`
- Side effects: none
- Source: [apps/backend/src/recruitment/http-problem.ts:162](../../apps/backend/src/recruitment/http-problem.ts#L162)

**How it works**

Each failure that `isSerializationConflict` classifies as a lost race becomes the
transaction.conflict problem, which a client may retry; every other failure passes unchanged.
It runs after the command executor, whose one retry reads the raw causes.

**Use**

```ts
command.pipe(raceProblems, recruitmentProblems(presentation, "dependency.unavailable"));
```

**Avoid**

Mapping races before the command executor: its retry of a lost race then sees a problem
instead of the raw cause, and does not retry. Pipe this after the executor.

## `problemUnion`

Creates a closed endpoint-specific Problem Details union.

```ts
problemUnion<const Codes extends readonly [NativeProblemCode, ...ReadonlyArray<NativeProblemCode>]>(
  identifier: string,
  codes: Codes
): Schema.Union<Array<ProblemBodySchema<Codes[number]>>>
```

- Inputs:
  - `identifier: string`
  - `codes: Codes`
- Output: `Schema.Union<Array<ProblemBodySchema<Codes[number]>>>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/http-api/src/http-semantics.ts:1144](../../packages/http-api/src/http-semantics.ts#L1144)

**How it works**

It builds one wire-ordered variant per distinct code of `codes`, whose status, type, title, and
detail come from `NativeProblemRegistry`, and a validation code carries its validation
extension. The union keeps each declared code as a literal, and `identifier` names it in the
OpenAPI document. `endpointProblemResponses` splits it into one response per status.

**Use**

```ts
export const SessionUnauthorizedProblem = problemUnion("SessionUnauthorizedProblem", ["credential.missing", "credential.invalid"]);
```

**Avoid**

Writing a problem schema by hand, or giving a code its own status: the answer then
differs from the registry that clients decode. Declare an endpoint's problems with this.

## `Problem`

One RFC 9457 failure in an Effect error channel.

```ts
class Problem<const Code extends NativeProblemCode = NativeProblemCode> extends Data.Error<ProblemMembers<Code>> {
  readonly _tag = "Problem";;
  readonly [ProblemTypeId] = ProblemTypeId;;
  get status(): (typeof NativeProblemRegistry)[Code]["status"];
  get [ErrorReporter.ignore](): boolean;
  static make<const C extends PlainProblemCode>(
    code: C,
    options?: { readonly instance?: string }
  ): Problem<C>;
  static validation<const C extends ValidationProblemCode>(
    code: C,
    errors: ReadonlyArray<NativeValidationError>
  ): Problem<C>;
  static rateLimited(retryAfterSeconds: number): Problem<CodesAtStatus<429>>;
  static credentialMissing(evidence: CredentialAbsent): Problem<"credential.missing">;
  static credentialInvalid(evidence: CredentialPresented): Problem<"credential.invalid">;
  static unauthenticated(
    presentation: CredentialPresentation
  ): Problem<"credential.missing"> | Problem<"credential.invalid">;
  static fromWire<const C extends NativeProblemCode>(
    body: WireProblemBody<C>,
    headers: WireProblemHeaders
  ): Problem<C>;
}
```

- Inputs: none
- Output: `Problem<Code>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/http-api/src/http-semantics.ts:1263](../../packages/http-api/src/http-semantics.ts#L1263)

**How it works**

The registry owns its type, title, status, and detail, so a problem carries only its code and
the members that the code needs: an instance, the challenge of a credential problem, the delay
of a rate limit, or validation diagnostics. The static constructors require exactly those
members: `make` for a plain code, `validation` for a validation code, `rateLimited`,
`credentialMissing` and `credentialInvalid` for the ingress evidence of each, and
`unauthenticated`, which answers from that evidence. A problem below status 500 is an answered
client failure, which `ErrorReporter` ignores.

**Use**

```ts
return yield* Problem.make("precondition.failed");
```

**Avoid**

Failing with a status, a plain `Error`, or a body built by hand: the registry then no
longer decides the answer, and an endpoint cannot declare the failure. Fail with a `Problem`
that one of its constructors built.

## `isProblem`

Narrows a caught value to a `Problem`, also one that another copy of this module created.

```ts
isProblem(u: unknown): u is Problem
```

- Inputs: `u: unknown`
- Output: `u is Problem`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/http-api/src/http-semantics.ts:1366](../../packages/http-api/src/http-semantics.ts#L1366)

**How it works**

It checks for the `Problem` type identifier property, not the class, so a problem that a
second copy of the module constructed, as a bundle or a test runner can load one, still
matches.

**Use**

```ts
const code = isProblem(cause) ? codes.find((declared) => declared === cause.code) : undefined;
```

**Avoid**

`cause instanceof Problem`: a problem from another copy of the module fails it and is
treated as a defect. Narrow with this.

## `problemBody`

The frozen RFC 9457 body: the registry entry, then code, instance, and validation.

```ts
problemBody(problem: Problem): ProblemWireRecord
```

- Inputs: `problem: Problem`
- Output: `ProblemWireRecord`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/http-api/src/http-semantics.ts:1395](../../packages/http-api/src/http-semantics.ts#L1395)

**How it works**

The body starts with the registry entry of the problem's code, its type, title, status, and
detail, then adds the code, and the instance and validation diagnostics when the problem has
them. Its members keep that order, so the JSON text is the same for every rendering.

**Use**

```ts
new Response(JSON.stringify(problemBody(problem)), { status: problem.status });
```

**Avoid**

Spreading a problem into a body: its constructor members, such as the challenge, then
leak into the body, and the registry members go missing. Render the body with this.

## `makeNativeProblem`

Builds one safe fixed public problem value.

```ts
makeNativeProblem<Code extends NativeProblemCode>(
  code: Code,
  expectedStatus?: number,
  instance?: string
): (typeof NativeProblemRegistry)[Code] & { readonly code: Code; readonly instance?: string }
```

- Inputs:
  - `code: Code`
  - `expectedStatus?: number`
  - `instance?: string`
- Output: `(typeof NativeProblemRegistry)[Code] & { readonly code: Code; readonly instance?: string }`
- Errors: none
- Throws: An `Error` when `expectedStatus` differs from the status that the registry freezes for `code`.
- Requirements: none
- Side effects: none
- Source: [packages/http-api/src/http-semantics.ts:1584](../../packages/http-api/src/http-semantics.ts#L1584)

**How it works**

It answers the registry entry of `code`, with `code` and, when given, `instance`: the body that
a server answers. When `expectedStatus` is given and differs from the registry status of the
code, it throws, so a fixture cannot pair a code with another status.

**Use**

```ts
return Response.json(makeNativeProblem("content.article-not-found", 404), { status: 404 });
```

**Avoid**

Writing a problem body by hand in a test or a fixture: its title or status then drifts
from the registry that clients decode. Build it with this.
