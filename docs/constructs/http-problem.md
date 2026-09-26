# http-problem

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Answers a native HTTP request with a declared problem: failure mapping, credential classification, authorization, and decoding. The [index](../constructs.md) lists every category.

## `authorizeAdmissionPerson`

Evaluates one admission person AccessSpec.

```ts
authorizeAdmissionPerson(request: Request, input: NativePersonAuthorization)
```

- Inputs:
  - `request: Request`
  - `input: NativePersonAuthorization`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/admission/http-access.ts:36](../../apps/backend/src/admission/http-access.ts#L36)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `returningAuthorization`

Resolves the current person and authorizes one returning-assistant operation on that person's own profile.

```ts
returningAuthorization(
  request: Request,
  input: AdmissionApiHttpOptions,
  endpoint: | typeof ReadReturningAssistantOptionsEndpoint | typeof RegisterReturningAssistantEndpoint
)
```

- Inputs:
  - `request: Request`
  - `input: AdmissionApiHttpOptions`
  - `endpoint: | typeof ReadReturningAssistantOptionsEndpoint | typeof RegisterReturningAssistantEndpoint`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/admission/http-access.ts:45](../../apps/backend/src/admission/http-access.ts#L45)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `admissionActorForAuthority`

The admission actor of one department scope.

```ts
admissionActorForAuthority(authority: OrganizationPersonAuthority, departmentScope?: string)
```

- Inputs:
  - `authority: OrganizationPersonAuthority`
  - `departmentScope?: string`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/admission/http-context.ts:61](../../apps/backend/src/admission/http-context.ts#L61)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `admissionProblems`

The one answer for every admission failure.

```ts
admissionProblems<Unavailable extends "admissions.unavailable" | "dependency.unavailable" | "returning.unavailable">(
  request: Request,
  unavailable: Unavailable
)
```

- Inputs:
  - `request: Request`
  - `unavailable: Unavailable`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/admission/http-problem.ts:22](../../apps/backend/src/admission/http-problem.ts#L22)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `authorizeContentOperation`

Evaluates a content endpoint's AccessSpec for one person with the content grant scope.

```ts
authorizeContentOperation(
  input: { readonly endpoint: ContentEndpoint; readonly personId: PersonId; readonly authorizationInstant: string; readonly credential?: Extract<CredentialOutcome, { readonly _tag: "Accepted" }>; readonly request?: Request; readonly resolution: CanonicalScopeResolution<Schema.JsonObject>; readonly presentation: CredentialPresentation }
)
```

- Inputs: `input: { readonly endpoint: ContentEndpoint; readonly personId: PersonId; readonly authorizationInstant: string; readonly credential?: Extract<CredentialOutcome, { readonly _tag: "Accepted" }>; readonly request?: Request; readonly resolution: CanonicalScopeResolution<Schema.JsonObject>; readonly presentation: CredentialPresentation }`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/content/http-access.ts:28](../../apps/backend/src/content/http-access.ts#L28)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `contentProblems`

The one answer for every content domain failure.

```ts
const contentProblems
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/content/http-problem.ts:21](../../apps/backend/src/content/http-problem.ts#L21)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `contentActorProblems`

A staff person rejected after ingress is answered from the credential the request presented.

```ts
contentActorProblems(presentation: CredentialPresentation)
```

- Inputs: `presentation: CredentialPresentation`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/content/http-problem.ts:44](../../apps/backend/src/content/http-problem.ts#L44)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `problemWebResponse`

Renders one problem outside HttpApi encoding, with the encoder's body and headers.

```ts
problemWebResponse(problem: Problem): Response
```

- Inputs: `problem: Problem`
- Output: `Response`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:58](../../apps/backend/src/http-api/problem.ts#L58)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `jsonText`

The JSON text of a representation, byte for byte what `JSON.stringify` writes.

```ts
jsonText<A>(value: A): Effect.Effect<string>
```

- Inputs: `value: A`
- Output: `Effect.Effect<string>`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:72](../../apps/backend/src/http-api/problem.ts#L72)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:96](../../apps/backend/src/http-api/problem.ts#L96)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:112](../../apps/backend/src/http-api/problem.ts#L112)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `problemMapper`

Builds the one failure-to-problem mapper of a domain.

```ts
problemMapper<Failure extends TaggedFailure>()
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:146](../../apps/backend/src/http-api/problem.ts#L146)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `requireNoQuery`

An operation that accepts no query answers any query as malformed.

```ts
requireNoQuery(request: Request): Effect.Effect<void, Problem<"request.malformed">>
```

- Inputs: `request: Request`
- Output: `Effect.Effect<void, Problem<"request.malformed">>`
- Errors: `Problem<"request.malformed">`
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:183](../../apps/backend/src/http-api/problem.ts#L183)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:193](../../apps/backend/src/http-api/problem.ts#L193)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `idempotencyKeyOf`

Decodes the one Idempotency-Key a replayable mutation requires.

```ts
idempotencyKeyOf(request: Request)
```

- Inputs: `request: Request`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:213](../../apps/backend/src/http-api/problem.ts#L213)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `requiredIfMatchOf`

Decodes the one strong If-Match an item mutation requires.

```ts
requiredIfMatchOf(request: Request)
```

- Inputs: `request: Request`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:224](../../apps/backend/src/http-api/problem.ts#L224)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `httpIdentity`

Derives a command's idempotency identity; a tuple outside the frozen grammar is a request problem.

```ts
httpIdentity(identity: NativeIdempotencyIdentity)
```

- Inputs: `identity: NativeIdempotencyIdentity`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:235](../../apps/backend/src/http-api/problem.ts#L235)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:246](../../apps/backend/src/http-api/problem.ts#L246)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `conditionalJson`

Answers a conditional JSON read after authority and concealment: the representation, a bodyless 304, or precondition.failed.

```ts
conditionalJson(
  input: { readonly request: Request; readonly body: unknown; readonly etag: StrongETag; readonly cacheControl: string; readonly contentType: "application/json" | "application/json; charset=utf-8" }
)
```

- Inputs: `input: { readonly request: Request; readonly body: unknown; readonly etag: StrongETag; readonly cacheControl: string; readonly contentType: "application/json" | "application/json; charset=utf-8" }`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:260](../../apps/backend/src/http-api/problem.ts#L260)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `personPresentation`

The person credential a request presented, for a rejection answered after ingress.

```ts
personPresentation(request: Request, challenge: string = nativeUserChallenges())
```

- Inputs:
  - `request: Request`
  - `challenge: string = nativeUserChallenges()`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:306](../../apps/backend/src/http-api/problem.ts#L306)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `isSerializationConflict`

Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.

```ts
isSerializationConflict(cause: unknown, depth = 0): boolean
```

- Inputs:
  - `cause: unknown`
  - `depth = 0`
- Output: `boolean`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:319](../../apps/backend/src/http-api/problem.ts#L319)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `requestInvalid`

The request as a whole fails validation; no single member is singled out.

```ts
requestInvalid()
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:333](../../apps/backend/src/http-api/problem.ts#L333)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `decodeRequest`

Decodes one JSON request value strictly; any mismatch fails the whole request's validation.

```ts
decodeRequest<S extends Schema.ConstraintDecoder<unknown, never>>(schema: S)
```

- Inputs: `schema: S`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:341](../../apps/backend/src/http-api/problem.ts#L341)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `strictOutput`

Decodes one response value strictly.

```ts
strictOutput<S extends Schema.ConstraintDecoder<unknown, never>>(schema: S)
```

- Inputs: `schema: S`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:354](../../apps/backend/src/http-api/problem.ts#L354)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `commandReceiptProblems`

HTTP command receipts: the transport's own persistence failures.

```ts
const commandReceiptProblems
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:364](../../apps/backend/src/http-api/problem.ts#L364)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:379](../../apps/backend/src/http-api/problem.ts#L379)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:403](../../apps/backend/src/http-api/problem.ts#L403)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `authorizePerson`

A rejected person credential is answered from the ingress evidence, never by string choice.

```ts
authorizePerson(input: NativePersonAuthorization, presentation: CredentialPresentation)
```

- Inputs:
  - `input: NativePersonAuthorization`
  - `presentation: CredentialPresentation`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:419](../../apps/backend/src/http-api/problem.ts#L419)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `unreachable`

Marks problems a shared mapper can produce but this operation cannot, such as a serialization conflict inside a read-only snapshot.

```ts
unreachable<const Code extends NativeProblemCode>(code: Code, ...codes: ReadonlyArray<Code>)
```

- Inputs:
  - `code: Code`
  - `...codes: ReadonlyArray<Code>`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:441](../../apps/backend/src/http-api/problem.ts#L441)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `ProblemBoundaryLive`

The only Cause consumer.

```ts
const ProblemBoundaryLive
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/http-api/problem.ts:462](../../apps/backend/src/http-api/problem.ts#L462)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `receiptProblems`

The one answer for every receipt failure other than a rejected credential, including an unavailable store, Identity, or E2E barrier.

```ts
const receiptProblems
```

- Inputs: none
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/receipt/http-problem.ts:21](../../apps/backend/src/receipt/http-problem.ts#L21)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `receiptCredentialProblems`

A credential rejected inside a receipt handler is answered from the request's own evidence.

```ts
receiptCredentialProblems(presentation: CredentialPresentation)
```

- Inputs: `presentation: CredentialPresentation`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/receipt/http-problem.ts:67](../../apps/backend/src/receipt/http-problem.ts#L67)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `authorizeInvitationOperation`

Authorizes the holder of an invitation's response capability.

```ts
authorizeInvitationOperation(
  input: { readonly spec: AccessSpec; readonly source: RecruitmentInvitationHttpSource; readonly authorizationInstant: string }
)
```

- Inputs: `input: { readonly spec: AccessSpec; readonly source: RecruitmentInvitationHttpSource; readonly authorizationInstant: string }`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/recruitment/http-access.ts:52](../../apps/backend/src/recruitment/http-access.ts#L52)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `interviewAuthorizationInTransaction`

Resolves the current person and authorizes one interview inside the caller's transaction; a rejected credential is answered from the request's evidence.

```ts
interviewAuthorizationInTransaction<R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  endpoint: | typeof ScheduleInterviewEndpoint | typeof ReadInterviewConductEndpoint | typeof FinalizeInterviewEndpoint | typeof CancelInterviewEndpoint | typeof CorrectInterviewAssessmentEndpoint,
  allowLeader: boolean,
  input: RecruitmentApiHttpOptions<R>
)
```

- Inputs:
  - `request: Request`
  - `interviewId: RecruitmentInterviewId`
  - `endpoint: | typeof ScheduleInterviewEndpoint | typeof ReadInterviewConductEndpoint | typeof FinalizeInterviewEndpoint | typeof CancelInterviewEndpoint | typeof CorrectInterviewAssessmentEndpoint`
  - `allowLeader: boolean`
  - `input: RecruitmentApiHttpOptions<R>`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/recruitment/http-access.ts:200](../../apps/backend/src/recruitment/http-access.ts#L200)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `readRecruitmentBody`

Every recruitment request body is one bounded `application/json` document.

```ts
readRecruitmentBody(request: Request, maxBodyBytes: number)
```

- Inputs:
  - `request: Request`
  - `maxBodyBytes: number`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/recruitment/http-decode.ts:17](../../apps/backend/src/recruitment/http-decode.ts#L17)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `recruitmentProblems`

The one answer for every recruitment failure.

```ts
recruitmentProblems<const Unavailable extends "recruitment.unavailable" | "dependency.unavailable">(
  presentation: CredentialPresentation,
  unavailable: Unavailable
)
```

- Inputs:
  - `presentation: CredentialPresentation`
  - `unavailable: Unavailable`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/recruitment/http-problem.ts:30](../../apps/backend/src/recruitment/http-problem.ts#L30)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `raceProblems`

A failure that lost a serialization or deadlock race answers transaction.conflict, whatever failure carried it.

```ts
raceProblems<A, E, R>(effect: Effect.Effect<A, E, R>)
```

- Inputs: `effect: Effect.Effect<A, E, R>`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/backend/src/recruitment/http-problem.ts:108](../../apps/backend/src/recruitment/http-problem.ts#L108)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `problemUnion`

Creates a closed endpoint-specific Problem Details union.

```ts
problemUnion<const Codes extends readonly [NativeProblemCode, ...ReadonlyArray<NativeProblemCode>]>(
  identifier: string,
  codes: Codes
)
```

- Inputs:
  - `identifier: string`
  - `codes: Codes`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/http-api/src/http-semantics.ts:1129](../../packages/http-api/src/http-semantics.ts#L1129)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/http-api/src/http-semantics.ts:1231](../../packages/http-api/src/http-semantics.ts#L1231)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `isProblem`

Narrows a caught value to a `Problem`, also one that another copy of this module created.

```ts
isProblem(u: unknown): u is Problem
```

- Inputs: `u: unknown`
- Output: `u is Problem`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/http-api/src/http-semantics.ts:1319](../../packages/http-api/src/http-semantics.ts#L1319)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `problemBody`

The frozen RFC 9457 body: the registry entry, then code, instance, and validation.

```ts
problemBody(problem: Problem): ProblemWireRecord
```

- Inputs: `problem: Problem`
- Output: `ProblemWireRecord`
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/http-api/src/http-semantics.ts:1333](../../packages/http-api/src/http-semantics.ts#L1333)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

## `makeNativeProblem`

Builds one safe fixed public problem value.

```ts
makeNativeProblem<Code extends NativeProblemCode>(
  code: Code,
  expectedStatus?: number,
  instance?: string
)
```

- Inputs:
  - `code: Code`
  - `expectedStatus?: number`
  - `instance?: string`
- Output: not annotated
- Errors: none
- Requirements: none
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/http-api/src/http-semantics.ts:1504](../../packages/http-api/src/http-semantics.ts#L1504)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.
