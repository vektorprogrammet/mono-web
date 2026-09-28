# rpc-problem

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Answers a native RPC with a declared problem: failure mapping, credential classification, authorization, command outcomes, and the defect boundary. The [index](../constructs.md) lists every category.

## `authorizeAdmissionPerson`

Evaluates one admission person AccessSpec.

```ts
const authorizeAdmissionPerson: { (input: NativePersonAuthorization): (headers: Headers.Headers) => Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">>; (headers: Headers.Headers, input: NativePersonAuthorization): Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">> }
```

- Inputs: none
- Output: `{ (input: NativePersonAuthorization): (headers: Headers.Headers) => Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">>; (headers: Headers.Headers, input: NativePersonAuthorization): Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">> }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/admission/access.ts:68](../../apps/backend/src/admission/access.ts#L68)

**How it works**

It runs `authorizePerson` with the credential headers that the request presented, then
`unreachable("resource.not-found")`: every admission AccessSpec reveals its denials, so
authorization never answers resource.not-found, and a concealment would be a defect.

**Use**

```ts
yield* authorizeAdmissionPerson(headers, { spec, credential, personId, resolution, grantScopes, now });
```

**Avoid**

Calling `authorizePerson` in an admission handler and declaring resource.not-found on the
RPC: admission specs reveal their denials, so that problem never occurs. Call this.

## `returningAuthorization`

Resolves the current person and authorizes one returning-assistant operation on that person's own profile.

```ts
const returningAuthorization: { (options: NativeRpcOptions, rpc: typeof ReadReturningAssistantOptions | typeof RegisterReturningAssistant): (headers: Headers.Headers) => Effect.Effect<TransactionPersonAuthority, | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">, Database | Organization | IdentitySnapshot | OAuthCredentialAuthority>; (headers: Headers.Headers, options: NativeRpcOptions, rpc: typeof ReadReturningAssistantOptions | typeof RegisterReturningAssistant): Effect.Effect<TransactionPersonAuthority, | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">, Database | Organization | IdentitySnapshot | OAuthCredentialAuthority> }
```

- Inputs: none
- Output: `{ (options: NativeRpcOptions, rpc: typeof ReadReturningAssistantOptions | typeof RegisterReturningAssistant): (headers: Headers.Headers) => Effect.Effect<TransactionPersonAuthority, | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">, Database | Organization | IdentitySnapshot | OAuthCredentialAuthority>; (headers: Headers.Headers, options: NativeRpcOptions, rpc: typeof ReadReturningAssistantOptions | typeof RegisterReturningAssistant): Effect.Effect<TransactionPersonAuthority, | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">, Database | Organization | IdentitySnapshot | OAuthCredentialAuthority> }`
- Errors: none
- Requirements: none
- Side effects: Reads the person's session or token and organization authority in the caller's transaction.
- Source: [apps/backend/src/admission/access.ts:118](../../apps/backend/src/admission/access.ts#L118)

**How it works**

It resolves the request's person credential and organization authority in the caller's
transaction at one instant, then evaluates the RPC's AccessSpec for that person over their own
`person-profile` resource, with the resource as the grant scope. It answers the resolved
authority, whose instant the command uses for its own reads.

**Use**

```ts
const authorization = yield* returningAuthorization(headers, options, RegisterReturningAssistant);
```

**Avoid**

Authorizing a returning-assistant operation with the actor of an admission period: the
operation acts on the person's own profile, not on a department. Resolve it with this.

## `admissionActorForAuthority`

The admission actor of one department scope.

```ts
const admissionActorForAuthority: { (authority: OrganizationPersonAuthority, departmentScope?: string): Effect.Effect<AdmissionPeriodActor, AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor>; (departmentScope?: string): (authority: OrganizationPersonAuthority) => Effect.Effect<AdmissionPeriodActor, AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor> }
```

- Inputs: none
- Output: `{ (authority: OrganizationPersonAuthority, departmentScope?: string): Effect.Effect<AdmissionPeriodActor, AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor>; (departmentScope?: string): (authority: OrganizationPersonAuthority) => Effect.Effect<AdmissionPeriodActor, AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor> }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/admission/context.ts:46](../../apps/backend/src/admission/context.ts#L46)

**How it works**

It maps the organization authority of a person to the admission actor of `departmentScope`,
or to the person's own scope when none is given, and requires that actor to be active. The
mapping throws only its three denials, which become failures; anything else that it throws is a
defect.

**Use**

```ts
const actor = yield* admissionActorForAuthority(authorization.authority, request.departmentId);
```

**Avoid**

Mapping the authority with `admissionActorForDepartment` in a handler: its denials are
throws, which escape the error channel as defects. Map it with this.

## `admissionProblems`

The one answer for every admission failure.

```ts
const admissionProblems: { <Unavailable extends AdmissionUnavailable>(unavailable: Unavailable): (headers: Headers.Headers) => ProblemMapper<AdmissionFailure, AdmissionCases<Unavailable>>; <Unavailable extends AdmissionUnavailable>(headers: Headers.Headers, unavailable: Unavailable): ProblemMapper<AdmissionFailure, AdmissionCases<Unavailable>> }
```

- Inputs: none
- Output: `{ <Unavailable extends AdmissionUnavailable>(unavailable: Unavailable): (headers: Headers.Headers) => ProblemMapper<AdmissionFailure, AdmissionCases<Unavailable>>; <Unavailable extends AdmissionUnavailable>(headers: Headers.Headers, unavailable: Unavailable): ProblemMapper<AdmissionFailure, AdmissionCases<Unavailable>> }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/admission/problem.ts:127](../../apps/backend/src/admission/problem.ts#L127)

**How it works**

A failed store or dependency answers the RPC's own unavailable problem, `unavailable`: a read
answers admissions.unavailable, a command dependency.unavailable, and a returning-assistant
operation returning.unavailable. A rejected credential answers from the credential headers that
the request presented. A command that the domain does not decode answers validation.failed at
the root, and an unknown department or semester answers validation.failed at its member.

**Use**

```ts
command.pipe(admissionProblems(headers, "dependency.unavailable"));
```

**Avoid**

Mapping an admission failure in a handler: the answers of the admission RPCs drift
apart. Pipe the handler's effect through this, with the RPC's unavailable problem.

## `authorizeContentOperation`

Evaluates a content RPC's AccessSpec for one person with the content grant scope.

```ts
authorizeContentOperation(
  input: { readonly rpc: Pick<Rpc.AnyWithProps, "annotations">; readonly personId: PersonId; readonly authorizationInstant: string; readonly credential?: Extract<CredentialOutcome, { readonly _tag: "Accepted" }>; readonly request?: Request; readonly resolution: CanonicalScopeResolution<Schema.JsonObject>; readonly presentation: CredentialPresentation }
): Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">>
```

- Inputs: `input: { readonly rpc: Pick<Rpc.AnyWithProps, "annotations">; readonly personId: PersonId; readonly authorizationInstant: string; readonly credential?: Extract<CredentialOutcome, { readonly _tag: "Accepted" }>; readonly request?: Request; readonly resolution: CanonicalScopeResolution<Schema.JsonObject>; readonly presentation: CredentialPresentation }`
- Output: `Effect.Effect<void, Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">>`
- Errors: `Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">`
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/content/access.ts:51](../../apps/backend/src/content/access.ts#L51)

**How it works**

It runs `authorizePerson` with the RPC's AccessSpec, the content domain as the grant scope, and
`resolution` at `authorizationInstant`. A command passes the credential that its transaction
resolved; a read passes the credential request, from which the credential is derived. Content
access reveals every denial, so `unreachable("resource.not-found")` removes the concealment
answer.

**Use**

```ts
yield* authorizeContentOperation({ rpc: ReviseArticle, credential: actor.credential, personId: actor.personId, authorizationInstant, resolution, presentation });
```

**Avoid**

Granting a content operation from a role check in the handler: the AccessSpec of the
contract then stops being the authority for the RPC. Evaluate it with this.

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
- Source: [apps/backend/src/content/problem.ts:61](../../apps/backend/src/content/problem.ts#L61)

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

Mapping a content failure in a handler: the content RPCs then answer one failure
differently. Pipe the handler's effect through this.

## `contentActorProblems`

A staff person rejected after the credential middleware is answered from the credential the request presented.

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
- Source: [apps/backend/src/content/problem.ts:102](../../apps/backend/src/content/problem.ts#L102)

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

## `receiptProblems`

The one answer for every receipt failure other than a rejected credential, including an unavailable store, Identity, or E2E barrier.

```ts
const receiptProblems: ProblemMapper<ReceiptRpcFailure, typeof receiptCases>
```

- Inputs: none
- Output: `ProblemMapper<ReceiptRpcFailure, typeof receiptCases>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/receipt/problem.ts:80](../../apps/backend/src/receipt/problem.ts#L80)

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

Mapping a receipt failure in a handler: the receipt RPCs then answer one failure
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
- Source: [apps/backend/src/receipt/problem.ts:108](../../apps/backend/src/receipt/problem.ts#L108)

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
- Source: [apps/backend/src/recruitment/access.ts:74](../../apps/backend/src/recruitment/access.ts#L74)

**How it works**

It evaluates the invitation AccessSpec for the capability holder, with one grant of the
spec's one capability on the invitation resource, over the invitation's recruitment context
at `authorizationInstant`. The invitation AccessSpec conceals every denial as not found, so a
denial answers resource.not-found and no other rejection exists. A spec with another capability
set, or a revealed denial, is a defect.

**Use**

```ts
yield* authorizeInvitationOperation({ spec: Option.getOrThrow(reflectAccessSpec(ReadInvitationResponse)), source: snapshot.source, authorizationInstant: now });
```

**Avoid**

Checking the capability digest against the invitation in the handler: the AccessSpec of
the contract then stops being the authority, and a denial can reveal that the invitation
exists. Authorize the holder with this.

## `interviewAuthorizationInTransaction`

Resolves the current person and authorizes one interview inside the caller's transaction; a rejected credential is answered from the request's evidence.

```ts
interviewAuthorizationInTransaction(
  input: { readonly headers: Headers.Headers; readonly interviewId: RecruitmentInterviewId; readonly rpc: Pick<Rpc.AnyWithProps, "annotations">; readonly allowLeader: boolean; readonly now: (() => string) | undefined }
): Effect.Effect<InterviewAuthorization, | RecruitmentFailure | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">, Database | IdentitySnapshot | OAuthCredentialAuthority | Organization | Recruitment>
```

- Inputs: `input: { readonly headers: Headers.Headers; readonly interviewId: RecruitmentInterviewId; readonly rpc: Pick<Rpc.AnyWithProps, "annotations">; readonly allowLeader: boolean; readonly now: (() => string) | undefined }`
- Output: `Effect.Effect<InterviewAuthorization, | RecruitmentFailure | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">, Database | IdentitySnapshot | OAuthCredentialAuthority | Organization | Recruitment>`
- Errors: `| RecruitmentFailure | IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">`
- Requirements: `Database | IdentitySnapshot | OAuthCredentialAuthority | Organization | Recruitment`
- Side effects: Reads the person's credential and authority, and takes recruitment's locks in the caller's transaction.
- Source: [apps/backend/src/recruitment/access.ts:265](../../apps/backend/src/recruitment/access.ts#L265)

**How it works**

It resolves the request's person credential and organization authority at one instant, lets
recruitment prepare the interview, which takes applicant custody before interview or receipt
locks, and evaluates the RPC's AccessSpec over the interview's access context, with the
interview as the grant scope. `allowLeader` admits the department's administrator. It answers
the actor, the instant, and the interview source that the command uses.

**Use**

```ts
const authorization = yield* interviewAuthorizationInTransaction({ headers, interviewId, rpc: ScheduleInterview, allowLeader: true, now });
```

**Avoid**

Authorizing outside the command's transaction, or before recruitment prepares the
interview: the authority or the interview can change before the command writes. Call it first
inside the transaction that writes.

## `recruitmentProblems`

The one answer for every recruitment failure.

```ts
recruitmentProblems<const Unavailable extends RecruitmentUnavailable>(
  { presentation, unavailable }: { readonly presentation: CredentialPresentation; readonly unavailable: Unavailable }
): ProblemMapper<RecruitmentRpcFailure, RecruitmentCases<Unavailable>>
```

- Inputs: `{ presentation, unavailable }: { readonly presentation: CredentialPresentation; readonly unavailable: Unavailable }`
- Output: `ProblemMapper<RecruitmentRpcFailure, RecruitmentCases<Unavailable>>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/recruitment/problem.ts:123](../../apps/backend/src/recruitment/problem.ts#L123)

**How it works**

Reads answer an outage as recruitment.unavailable and mutations as dependency.unavailable,
through `unavailable`. A rejected credential answers from the request's own evidence, a denied
actor answers authority.denied, a replayed command with other content answers
idempotency.digest-conflict, and each other recruitment failure answers its recruitment
problem. What remains is a fault of recruitment itself or of a dependency's contract, and
answers internal.error.

**Use**

```ts
read.pipe(recruitmentProblems({ presentation: personPresentation(headers), unavailable: "recruitment.unavailable" }));
```

**Avoid**

Mapping a recruitment failure in a handler: the recruitment RPCs then answer one failure
differently. Pipe the handler's effect through this, with the RPC's unavailable problem.

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
- Source: [apps/backend/src/recruitment/problem.ts:162](../../apps/backend/src/recruitment/problem.ts#L162)

**How it works**

Each failure that `isSerializationConflict` classifies as a lost race becomes the
transaction.conflict problem, which a client may retry; every other failure passes unchanged.
It runs after the command executor, whose one retry reads the raw causes.

**Use**

```ts
command.pipe(raceProblems, recruitmentProblems({ presentation, unavailable: "dependency.unavailable" }));
```

**Avoid**

Mapping races before the command executor: its retry of a lost race then sees a problem
instead of the raw cause, and does not retry. Pipe this after the executor.

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
- Source: [apps/backend/src/rpc/problem.ts:64](../../apps/backend/src/rpc/problem.ts#L64)

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
- Source: [apps/backend/src/rpc/problem.ts:203](../../apps/backend/src/rpc/problem.ts#L203)

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

## `commandIdentity`

Derives a command's idempotency identity: the receipt digest and the domain command ID.

```ts
commandIdentity(identity: NativeIdempotencyIdentity): Effect.Effect<DerivedHttpIdentity>
```

- Inputs: `identity: NativeIdempotencyIdentity`
- Output: `Effect.Effect<DerivedHttpIdentity>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/rpc/problem.ts:250](../../apps/backend/src/rpc/problem.ts#L250)

**How it works**

It runs `deriveHttpIdentity` over the credential subject, the operation id, the normalized
target, and the idempotency key. The RPC payload schema has already decoded the key, and a
handler passes its operation id and the path of the HTTP route it replaced as constants, so a
tuple outside the grammar is a defect. Keeping the old path keeps the receipts and command IDs
of commands that straddle the cutover stable.

**Use**

```ts
const identity = yield* commandIdentity({ credentialSubject: `Person:${personId}`, qualifiedOperationId: "social-events.create", normalizedTarget: "/api/social-events", idempotencyKey });
```

**Avoid**

Deriving a new target from the RPC tag: a replay across the cutover then misses its
receipt, and the domain command runs twice. Pass the old route path.

## `requireCurrentETag`

Fails a mutation whose If-Match no longer names the current representation.

```ts
const requireCurrentETag: { (ifMatch: StrongETag): (current: StrongETag) => Effect.Effect<void, Problem<"precondition.failed">>; (current: StrongETag, ifMatch: StrongETag): Effect.Effect<void, Problem<"precondition.failed">> }
```

- Inputs: none
- Output: `{ (ifMatch: StrongETag): (current: StrongETag) => Effect.Effect<void, Problem<"precondition.failed">>; (current: StrongETag, ifMatch: StrongETag): Effect.Effect<void, Problem<"precondition.failed">> }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/rpc/problem.ts:278](../../apps/backend/src/rpc/problem.ts#L278)

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

## `isSerializationConflict`

Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.

```ts
isSerializationConflict(cause: unknown): boolean
```

- Inputs: `cause: unknown`
- Output: `boolean`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/rpc/problem.ts:325](../../apps/backend/src/rpc/problem.ts#L325)

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
- Source: [apps/backend/src/rpc/problem.ts:348](../../apps/backend/src/rpc/problem.ts#L348)

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
- Source: [apps/backend/src/rpc/problem.ts:371](../../apps/backend/src/rpc/problem.ts#L371)

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

Command receipts: the transport's own persistence failures.

```ts
const commandReceiptProblems: ProblemMapper<NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError, typeof commandReceiptCases>
```

- Inputs: none
- Output: `ProblemMapper<NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError, typeof commandReceiptCases>`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/rpc/problem.ts:406](../../apps/backend/src/rpc/problem.ts#L406)

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

## `personPresentation`

The credential evidence of an RPC request: which credential headers it presented.

```ts
const personPresentation: { (headers: Headers.Headers, challenge?: string): CredentialPresentation; (challenge?: string): (headers: Headers.Headers) => CredentialPresentation }
```

- Inputs: none
- Output: `{ (headers: Headers.Headers, challenge?: string): CredentialPresentation; (challenge?: string): (headers: Headers.Headers) => CredentialPresentation }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/rpc/problem.ts:430](../../apps/backend/src/rpc/problem.ts#L430)

**How it works**

`authorizePerson` answers a credential rejection from this evidence, never by string choice.

**Use**

```ts
yield* authorizePerson(input, personPresentation(headers));
```

**Avoid**

Deciding between credential.missing and credential.invalid in a handler. Pass this.

## `commandOutcome`

The value of a command receipt outcome: the committed or replayed success, or an idempotency problem.

```ts
commandOutcome<S extends Schema.Codec<unknown, unknown, never, never>>(
  success: S
): ((outcome: NativeHttpCommandOutcome) => Effect.Effect<S["Type"], | Problem<"idempotency.in-flight"> | Problem<"idempotency.digest-conflict"> | Problem<"idempotency.response-expired">>)
```

- Inputs: `success: S`
- Output: `((outcome: NativeHttpCommandOutcome) => Effect.Effect<S["Type"], | Problem<"idempotency.in-flight"> | Problem<"idempotency.digest-conflict"> | Problem<"idempotency.response-expired">>)`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/rpc/problem.ts:462](../../apps/backend/src/rpc/problem.ts#L462)

**How it works**

A committed or replayed outcome answers the success that its receipt stores, decoded with the
RPC's success schema, so a replay returns the value of the first answer. A command that still
runs under the key fails with idempotency.in-flight, a key reused for another request with
idempotency.digest-conflict, and a result that is no longer kept with
idempotency.response-expired.

**Use**

```ts
return yield* commandOutcome(SocialEventResource)(outcome);
```

**Avoid**

Rebuilding the result of a replay from the current state: a retry then sees another
answer than the first attempt. Answer every outcome through this.

## `authorizeAnonymous`

An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and its scope resolution disagree: a defect.

```ts
const authorizeAnonymous: { (resolution: CanonicalScopeResolution<Schema.JsonObject>, now: string): (spec: AccessSpec) => Effect.Effect<void>; (spec: AccessSpec, resolution: CanonicalScopeResolution<Schema.JsonObject>, now: string): Effect.Effect<void> }
```

- Inputs: none
- Output: `{ (resolution: CanonicalScopeResolution<Schema.JsonObject>, now: string): (spec: AccessSpec) => Effect.Effect<void>; (spec: AccessSpec, resolution: CanonicalScopeResolution<Schema.JsonObject>, now: string): Effect.Effect<void> }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/rpc/problem.ts:539](../../apps/backend/src/rpc/problem.ts#L539)

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
const authorizePerson: { (presentation: CredentialPresentation): (input: NativePersonAuthorization) => Effect.Effect<void, | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">>; (input: NativePersonAuthorization, presentation: CredentialPresentation): Effect.Effect<void, | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">> }
```

- Inputs: none
- Output: `{ (presentation: CredentialPresentation): (input: NativePersonAuthorization) => Effect.Effect<void, | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">>; (input: NativePersonAuthorization, presentation: CredentialPresentation): Effect.Effect<void, | Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing"> | Problem<"resource.not-found">> }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/backend/src/rpc/problem.ts:585](../../apps/backend/src/rpc/problem.ts#L585)

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
- Source: [apps/backend/src/rpc/problem.ts:652](../../apps/backend/src/rpc/problem.ts#L652)

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

## `problemUnion`

Creates the closed Problem Details union of one RPC.

```ts
const problemUnion: { <const Codes extends readonly [NativeProblemCode, ...ReadonlyArray<NativeProblemCode>]>(codes: Codes): (identifier: string) => Schema.Union<Array<ProblemBodySchema<Codes[number]>>>; <const Codes extends readonly [NativeProblemCode, ...ReadonlyArray<NativeProblemCode>]>(identifier: string, codes: Codes): Schema.Union<Array<ProblemBodySchema<Codes[number]>>> }
```

- Inputs: none
- Output: `{ <const Codes extends readonly [NativeProblemCode, ...ReadonlyArray<NativeProblemCode>]>(codes: Codes): (identifier: string) => Schema.Union<Array<ProblemBodySchema<Codes[number]>>>; <const Codes extends readonly [NativeProblemCode, ...ReadonlyArray<NativeProblemCode>]>(identifier: string, codes: Codes): Schema.Union<Array<ProblemBodySchema<Codes[number]>>> }`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/rpc/src/problem.ts:1008](../../packages/rpc/src/problem.ts#L1008)

**How it works**

It builds one wire-ordered variant per distinct code of `codes`, whose status, type, title, and
detail come from `NativeProblemRegistry`, and a validation code carries its validation
extension. The union keeps each declared code as a literal, and `identifier` names the schema.
`rpcProblems` makes it the error of an RPC.

**Use**

```ts
export const SessionUnauthorizedProblem = problemUnion("SessionUnauthorizedProblem", ["credential.missing", "credential.invalid"]);
```

**Avoid**

Writing a problem schema by hand, or giving a code its own status: the answer then
differs from the registry that clients decode. Declare an RPC's problems with this.

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
- Source: [packages/rpc/src/problem.ts:1136](../../packages/rpc/src/problem.ts#L1136)

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
- Source: [packages/rpc/src/problem.ts:1239](../../packages/rpc/src/problem.ts#L1239)

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
- Source: [packages/rpc/src/problem.ts:1268](../../packages/rpc/src/problem.ts#L1268)

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
const makeNativeProblem: { <Code extends NativeProblemCode>(code: Code, expectedStatus?: number, instance?: string): RegistryProblemBody<Code>; (expectedStatus?: number, instance?: string): <Code extends NativeProblemCode>(code: Code) => RegistryProblemBody<Code> }
```

- Inputs: none
- Output: `{ <Code extends NativeProblemCode>(code: Code, expectedStatus?: number, instance?: string): RegistryProblemBody<Code>; (expectedStatus?: number, instance?: string): <Code extends NativeProblemCode>(code: Code) => RegistryProblemBody<Code> }`
- Errors: none
- Throws: An `Error` when `expectedStatus` differs from the status that the registry freezes for `code`.
- Requirements: none
- Side effects: none
- Source: [packages/rpc/src/problem.ts:1388](../../packages/rpc/src/problem.ts#L1388)

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
