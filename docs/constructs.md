# Shared constructs

[//]: # "constructs: generated from the @construct tags and the import graph by just constructs write; do not edit"

A shared construct is an export that owns logic that several call sites share. Use it instead of writing the logic again.
Its JSDoc carries a `@construct <category>` line, and its module opens with a header comment: purpose, when to use, and details.
Tag a new construct only when at least two call sites share its logic.
Consumers are the modules that import a construct, directly or through re-exports.
`just constructs` checks this page against the tags and the imports. It also lists untagged functions that 3 or more modules outside their app or package import.

| Category                          | Constructs | Holds                                                                                                                                       |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [http-transport](#http-transport) | 17         | Reads native HTTP requests and writes their representations: bounded JSON, preconditions, idempotency keys, entity tags, and cache headers. |
| [http-problem](#http-problem)     | 59         | Answers a native HTTP request with a declared problem: failure mapping, credential classification, authorization, and decoding.             |
| [sql-lock](#sql-lock)             | 5          | Transaction-scoped PostgreSQL advisory locks under registered keys.                                                                         |
| [sql-lifecycle](#sql-lifecycle)   | 8          | Claim-fenced row lifecycles in PostgreSQL, such as outbox claims and account access.                                                        |
| [delivery](#delivery)             | 1          | Delivers committed effects to providers after the transaction.                                                                              |
| [worker](#worker)                 | 1          | Runs background workers on the Effect clock.                                                                                                |
| [runtime-bridge](#runtime-bridge) | 1          | Runs the Effect programs behind Promise callbacks that a third-party library calls, inside the scope of the layer that owns the library.    |
| [pagination](#pagination)         | 4          | Keyset cursors and pages over ordered PostgreSQL reads.                                                                                     |
| [digest](#digest)                 | 4          | Canonical JSON and SHA-256 digests that evidence and idempotency identities hash.                                                           |
| [test-harness](#test-harness)     | 12         | Starts and drives disposable infrastructure for tests, proofs, and journeys: PostgreSQL clusters, loopback ports, and the local backend.    |
| [request-ledger](#request-ledger) | 2          | Classifies the requests that journey recorders observe by whole path segments: native contract operations and legacy routes.                |

## http-transport

Reads native HTTP requests and writes their representations: bounded JSON, preconditions, idempotency keys, entity tags, and cache headers.

- `jsonResponse`: One JSON representation that no cache stores.
  [apps/backend/src/admission/http-representation.ts:11](../apps/backend/src/admission/http-representation.ts#L11), 1 consumer:
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
- `conditionalCollection`: Answers a conditional read of one admission collection, tagged by the versions of its items.
  [apps/backend/src/admission/http-representation.ts:25](../apps/backend/src/admission/http-representation.ts#L25), 1 consumer:
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
- `readBoundedJson`: Bound bytes while reading, including requests without Content-Length.
  [apps/backend/src/http-api/read-json.ts:17](../apps/backend/src/http-api/read-json.ts#L17), 1 consumer:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
- `jcsBytes`: Encodes one I-JSON value with the repository RFC 8785 encoder.
  [apps/backend/src/http-semantics.ts:119](../apps/backend/src/http-semantics.ts#L119), no consumers.
- `parseJsonWithoutDuplicateMembers`: Decodes UTF-8 JSON while rejecting duplicate member names before schema decoding.
  [apps/backend/src/http-semantics.ts:130](../apps/backend/src/http-semantics.ts#L130), 2 consumers:
  - [apps/backend/src/http-api/read-json.ts](../apps/backend/src/http-api/read-json.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
- `interpretMergePatchSource`: Preserves absence, value, and explicit deletion before typed merge-patch decoding.
  [apps/backend/src/http-semantics.ts:177](../apps/backend/src/http-semantics.ts#L177), no consumers.
- `parseIdempotencyKey`: Decodes one non-combinable Idempotency-Key field.
  [apps/backend/src/http-semantics.ts:256](../apps/backend/src/http-semantics.ts#L256), 2 consumers:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
- `parseRequiredIfMatch`: Decodes the required single strong If-Match value for an item mutation.
  [apps/backend/src/http-semantics.ts:273](../apps/backend/src/http-semantics.ts#L273), 2 consumers:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
- `parseReadIfMatch`: Canonicalizes an optional read If-Match wildcard or entity-tag list.
  [apps/backend/src/http-semantics.ts:356](../apps/backend/src/http-semantics.ts#L356), 2 consumers:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
- `parseIfNoneMatch`: Canonicalizes an optional If-None-Match wildcard or entity-tag list.
  [apps/backend/src/http-semantics.ts:364](../apps/backend/src/http-semantics.ts#L364), 2 consumers:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
- `encodePathIdentity`: Encodes one decoded identity as an uppercase RFC 3986 path segment.
  [apps/backend/src/http-semantics.ts:372](../apps/backend/src/http-semantics.ts#L372), 7 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
  - [apps/dashboard/e2e/run-real-admission-period-management.mjs](../apps/dashboard/e2e/run-real-admission-period-management.mjs)
- `normalizeTarget`: Fills a route template with its encoded identities; a missing identity is a malformed request.
  [apps/backend/src/http-semantics.ts:386](../apps/backend/src/http-semantics.ts#L386), 8 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `deriveHttpIdentity`: Derives the private storage digest and domain command ID from the identity tuple.
  [apps/backend/src/http-semantics.ts:415](../apps/backend/src/http-semantics.ts#L415), 7 consumers:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
  - [apps/backend/src/receipt/http.test.ts](../apps/backend/src/receipt/http.test.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/dashboard/e2e/run-real-admission-period-management.mjs](../apps/dashboard/e2e/run-real-admission-period-management.mjs)
  - [apps/dashboard/e2e/run-real-native-organization-administration.mjs](../apps/dashboard/e2e/run-real-native-organization-administration.mjs)
  - [apps/dashboard/e2e/run-real-receipt-owner.mjs](../apps/dashboard/e2e/run-real-receipt-owner.mjs)
- `jsonResponse`: A JSON body under the receipt cache policy the caller names.
  [apps/backend/src/receipt/http-representation.ts:25](../apps/backend/src/receipt/http-representation.ts#L25), 1 consumer:
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
- `privateJsonResponse`: A JSON body private to the caller, varying by Origin.
  [apps/backend/src/receipt/http-representation.ts:43](../apps/backend/src/receipt/http-representation.ts#L43), 1 consumer:
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
- `receiptMutationCapsule`: The replayable response of one receipt mutation.
  [apps/backend/src/receipt/http-representation.ts:164](../apps/backend/src/receipt/http-representation.ts#L164), 1 consumer:
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
- `readPrivateReceiptFile`: Answers verified private bytes with their exact headers; unreadable bytes are the receipt store failing.
  [apps/backend/src/receipt/http-representation.ts:216](../apps/backend/src/receipt/http-representation.ts#L216), 1 consumer:
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)

## http-problem

Answers a native HTTP request with a declared problem: failure mapping, credential classification, authorization, and decoding.

- `authorizeAdmissionPerson`: Evaluates one admission person AccessSpec.
  [apps/backend/src/admission/http-access.ts:36](../apps/backend/src/admission/http-access.ts#L36), 2 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
- `returningAuthorization`: Resolves the current person and authorizes one returning-assistant operation on that person's own profile.
  [apps/backend/src/admission/http-access.ts:45](../apps/backend/src/admission/http-access.ts#L45), 2 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
- `admissionActorForAuthority`: The admission actor of one department scope.
  [apps/backend/src/admission/http-context.ts:61](../apps/backend/src/admission/http-context.ts#L61), 2 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/router.ts](../apps/backend/src/router.ts)
- `decodeJson`: Reads and decodes one bounded JSON body.
  [apps/backend/src/admission/http-decode.ts:53](../apps/backend/src/admission/http-decode.ts#L53), 1 consumer:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
- `decodeAdmissionPeriodPatch`: Reads and decodes one bounded admission period merge patch.
  [apps/backend/src/admission/http-decode.ts:69](../apps/backend/src/admission/http-decode.ts#L69), 1 consumer:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
- `admissionProblems`: The one answer for every admission failure.
  [apps/backend/src/admission/http-problem.ts:22](../apps/backend/src/admission/http-problem.ts#L22), 2 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
- `submissionProblems`: Problems only a public application submission answers.
  [apps/backend/src/admission/http-problem.ts:100](../apps/backend/src/admission/http-problem.ts#L100), 1 consumer:
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
- `periodCommandProblems`: Problems only an admission period command answers.
  [apps/backend/src/admission/http-problem.ts:118](../apps/backend/src/admission/http-problem.ts#L118), 1 consumer:
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
- `authorizeContentOperation`: Evaluates a content endpoint's AccessSpec for one person with the content grant scope.
  [apps/backend/src/content/http-access.ts:28](../apps/backend/src/content/http-access.ts#L28), 2 consumers:
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
- `authorizedActor`: Resolves the staff person of a snapshot read and its content actor at the person's authorization instant.
  [apps/backend/src/content/http-context.ts:52](../apps/backend/src/content/http-context.ts#L52), 1 consumer:
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
- `authorizedActorInTransaction`: Resolves the staff person of a command, its credential, and its content actor inside the command's transaction.
  [apps/backend/src/content/http-context.ts:89](../apps/backend/src/content/http-context.ts#L89), 1 consumer:
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
- `departmentQuery`: A workspace or news listing accepts at most one department filter and no other parameter.
  [apps/backend/src/content/http-decode.ts:13](../apps/backend/src/content/http-decode.ts#L13), 1 consumer:
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
- `versionFromQuery`: A news article read accepts at most one positive published version and no other parameter.
  [apps/backend/src/content/http-decode.ts:29](../apps/backend/src/content/http-decode.ts#L29), 1 consumer:
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
- `contentProblems`: The one answer for every content domain failure.
  [apps/backend/src/content/http-problem.ts:21](../apps/backend/src/content/http-problem.ts#L21), 2 consumers:
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
- `contentActorProblems`: A staff person rejected after ingress is answered from the credential the request presented.
  [apps/backend/src/content/http-problem.ts:44](../apps/backend/src/content/http-problem.ts#L44), 2 consumers:
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
- `problemWebResponse`: Renders one problem outside HttpApi encoding, with the encoder's body and headers.
  [apps/backend/src/http-api/problem.ts:58](../apps/backend/src/http-api/problem.ts#L58), 3 consumers:
  - [apps/backend/src/http-api/transport.ts](../apps/backend/src/http-api/transport.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/router.ts](../apps/backend/src/router.ts)
- `jsonText`: The JSON text of a representation, byte for byte what `JSON.stringify` writes.
  [apps/backend/src/http-api/problem.ts:72](../apps/backend/src/http-api/problem.ts#L72), 14 consumers:
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
  - [apps/backend/src/content/http.test.ts](../apps/backend/src/content/http.test.ts)
  - [apps/backend/src/onboarding/claim.http.test.ts](../apps/backend/src/onboarding/claim.http.test.ts)
  - [apps/backend/src/organization/http.test.ts](../apps/backend/src/organization/http.test.ts)
  - [apps/backend/src/placements/http.test.ts](../apps/backend/src/placements/http.test.ts)
  - [apps/backend/src/receipt/r2.ts](../apps/backend/src/receipt/r2.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http.test.ts](../apps/backend/src/recruitment/http.test.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
- `classifyCredential`: Records, from the raw request only, whether person credential material was presented.
  [apps/backend/src/http-api/problem.ts:80](../apps/backend/src/http-api/problem.ts#L80), 1 consumer:
  - [apps/backend/src/http-api/transport.ts](../apps/backend/src/http-api/transport.ts)
- `webHandler`: Runs one Effect-native Web transport operation.
  [apps/backend/src/http-api/problem.ts:98](../apps/backend/src/http-api/problem.ts#L98), 14 consumers:
  - [apps/backend/src/admission/http.ts](../apps/backend/src/admission/http.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/contact/http.ts](../apps/backend/src/contact/http.ts)
  - [apps/backend/src/content/http.ts](../apps/backend/src/content/http.ts)
  - [apps/backend/src/directory/http.ts](../apps/backend/src/directory/http.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http.ts](../apps/backend/src/receipt/http.ts)
  - [apps/backend/src/recruitment/http.ts](../apps/backend/src/recruitment/http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `semanticProblem`: Runs a throwing semantic parser.
  [apps/backend/src/http-api/problem.ts:114](../apps/backend/src/http-api/problem.ts#L114), 4 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/http-decode.ts](../apps/backend/src/admission/http-decode.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
- `problemMapper`: Builds the one failure-to-problem mapper of a domain.
  [apps/backend/src/http-api/problem.ts:148](../apps/backend/src/http-api/problem.ts#L148), 15 consumers:
  - [apps/backend/src/admission/http-problem.ts](../apps/backend/src/admission/http-problem.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/contact/http.ts](../apps/backend/src/contact/http.ts)
  - [apps/backend/src/content/http-problem.ts](../apps/backend/src/content/http-problem.ts)
  - [apps/backend/src/directory/http.ts](../apps/backend/src/directory/http.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-problem.ts](../apps/backend/src/receipt/http-problem.ts)
  - [apps/backend/src/recruitment/http-problem.ts](../apps/backend/src/recruitment/http-problem.ts)
  - [apps/backend/src/schools/http.ts](../apps/backend/src/schools/http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `headerValues`: The values of one request header; an absent header has none.
  [apps/backend/src/http-api/problem.ts:176](../apps/backend/src/http-api/problem.ts#L176), no consumers.
- `requireNoQuery`: An operation that accepts no query answers any query as malformed.
  [apps/backend/src/http-api/problem.ts:187](../apps/backend/src/http-api/problem.ts#L187), 17 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `readJsonBody`: Reads a bounded JSON body of the one media type `mediaType` accepts.
  [apps/backend/src/http-api/problem.ts:197](../apps/backend/src/http-api/problem.ts#L197), 11 consumers:
  - [apps/backend/src/admission/http-decode.ts](../apps/backend/src/admission/http-decode.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/contact/http.ts](../apps/backend/src/contact/http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/receipt/http-decode.ts](../apps/backend/src/receipt/http-decode.ts)
  - [apps/backend/src/recruitment/http-decode.ts](../apps/backend/src/recruitment/http-decode.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `idempotencyKeyOf`: Decodes the one Idempotency-Key a replayable mutation requires.
  [apps/backend/src/http-api/problem.ts:217](../apps/backend/src/http-api/problem.ts#L217), 14 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `requiredIfMatchOf`: Decodes the one strong If-Match an item mutation requires.
  [apps/backend/src/http-api/problem.ts:228](../apps/backend/src/http-api/problem.ts#L228), 9 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `httpIdentity`: Derives a command's idempotency identity; a tuple outside the frozen grammar is a request problem.
  [apps/backend/src/http-api/problem.ts:239](../apps/backend/src/http-api/problem.ts#L239), 13 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `requireCurrentETag`: Fails a mutation whose If-Match no longer names the current representation.
  [apps/backend/src/http-api/problem.ts:250](../apps/backend/src/http-api/problem.ts#L250), 9 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `conditionalJson`: Answers a conditional JSON read after authority and concealment: the representation, a bodyless 304, or precondition.failed.
  [apps/backend/src/http-api/problem.ts:264](../apps/backend/src/http-api/problem.ts#L264), 6 consumers:
  - [apps/backend/src/admission/http-representation.ts](../apps/backend/src/admission/http-representation.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
- `personPresentation`: The person credential a request presented, for a rejection answered after ingress.
  [apps/backend/src/http-api/problem.ts:310](../apps/backend/src/http-api/problem.ts#L310), 21 consumers:
  - [apps/backend/src/admission/http-access.ts](../apps/backend/src/admission/http-access.ts)
  - [apps/backend/src/admission/http-problem.ts](../apps/backend/src/admission/http-problem.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
  - [apps/backend/src/directory/http.ts](../apps/backend/src/directory/http.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
  - [apps/backend/src/recruitment/http-access.ts](../apps/backend/src/recruitment/http-access.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/schools/http.ts](../apps/backend/src/schools/http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `isSerializationConflict`: Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.
  [apps/backend/src/http-api/problem.ts:323](../apps/backend/src/http-api/problem.ts#L323), 4 consumers:
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/recruitment/http-problem.ts](../apps/backend/src/recruitment/http-problem.ts)
- `requestInvalid`: The request as a whole fails validation; no single member is singled out.
  [apps/backend/src/http-api/problem.ts:337](../apps/backend/src/http-api/problem.ts#L337), 6 consumers:
  - [apps/backend/src/admission/http-problem.ts](../apps/backend/src/admission/http-problem.ts)
  - [apps/backend/src/contact/http.ts](../apps/backend/src/contact/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-decode.ts](../apps/backend/src/receipt/http-decode.ts)
  - [apps/backend/src/receipt/http-problem.ts](../apps/backend/src/receipt/http-problem.ts)
- `decodeRequest`: Decodes one JSON request value strictly; any mismatch fails the whole request's validation.
  [apps/backend/src/http-api/problem.ts:345](../apps/backend/src/http-api/problem.ts#L345), 11 consumers:
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/contact/http.ts](../apps/backend/src/contact/http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/receipt/http-decode.ts](../apps/backend/src/receipt/http-decode.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-decode.ts](../apps/backend/src/recruitment/http-decode.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
- `strictOutput`: Decodes one response value strictly.
  [apps/backend/src/http-api/problem.ts:358](../apps/backend/src/http-api/problem.ts#L358), 9 consumers:
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
- `commandReceiptProblems`: HTTP command receipts: the transport's own persistence failures.
  [apps/backend/src/http-api/problem.ts:368](../apps/backend/src/http-api/problem.ts#L368), 14 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `commandOutcomeResponse`: Answers a command receipt outcome: committed and replayed results, or an idempotency problem.
  [apps/backend/src/http-api/problem.ts:383](../apps/backend/src/http-api/problem.ts#L383), 14 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `authorizeAnonymous`: An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and its scope resolution disagree: a defect.
  [apps/backend/src/http-api/problem.ts:407](../apps/backend/src/http-api/problem.ts#L407), 6 consumers:
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `authorizePerson`: A rejected person credential is answered from the ingress evidence, never by string choice.
  [apps/backend/src/http-api/problem.ts:423](../apps/backend/src/http-api/problem.ts#L423), 17 consumers:
  - [apps/backend/src/admission/http-access.ts](../apps/backend/src/admission/http-access.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/content/http-access.ts](../apps/backend/src/content/http-access.ts)
  - [apps/backend/src/directory/http.ts](../apps/backend/src/directory/http.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/recruitment/http-access.ts](../apps/backend/src/recruitment/http-access.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
  - [apps/backend/src/schools/http.ts](../apps/backend/src/schools/http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `unreachable`: Marks problems a shared mapper can produce but this operation cannot, such as a serialization conflict inside a read-only snapshot.
  [apps/backend/src/http-api/problem.ts:445](../apps/backend/src/http-api/problem.ts#L445), 17 consumers:
  - [apps/backend/src/admission/http-access.ts](../apps/backend/src/admission/http-access.ts)
  - [apps/backend/src/admission/http-commands.ts](../apps/backend/src/admission/http-commands.ts)
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
  - [apps/backend/src/content/http-access.ts](../apps/backend/src/content/http-access.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-reads.ts](../apps/backend/src/content/http-reads.ts)
  - [apps/backend/src/directory/http.ts](../apps/backend/src/directory/http.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
  - [apps/backend/src/schools/http.ts](../apps/backend/src/schools/http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
- `ProblemBoundaryLive`: The only Cause consumer.
  [apps/backend/src/http-api/problem.ts:466](../apps/backend/src/http-api/problem.ts#L466), 2 consumers:
  - [apps/backend/src/router.ts](../apps/backend/src/router.ts)
  - [apps/backend/src/test/native-http.ts](../apps/backend/src/test/native-http.ts)
- `NativeAccessRejected`: An AccessSpec evaluation that did not grant the operation.
  [apps/backend/src/native-operation.ts:45](../apps/backend/src/native-operation.ts#L45), no consumers.
- `receiptProblems`: The one answer for every receipt failure other than a rejected credential, including an unavailable store, Identity, or E2E barrier.
  [apps/backend/src/receipt/http-problem.ts:21](../apps/backend/src/receipt/http-problem.ts#L21), 2 consumers:
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
- `storedReceiptProblems`: A stored receipt value a read cannot decode is the receipt store failing, not the request.
  [apps/backend/src/receipt/http-problem.ts:60](../apps/backend/src/receipt/http-problem.ts#L60), 1 consumer:
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
- `receiptCredentialProblems`: A credential rejected inside a receipt handler is answered from the request's own evidence.
  [apps/backend/src/receipt/http-problem.ts:69](../apps/backend/src/receipt/http-problem.ts#L69), 2 consumers:
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
- `projected`: Projects stored rows onto response items.
  [apps/backend/src/receipt/http-representation.ts:56](../apps/backend/src/receipt/http-representation.ts#L56), 1 consumer:
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
- `authorizeInvitationOperation`: Authorizes the holder of an invitation's response capability.
  [apps/backend/src/recruitment/http-access.ts:52](../apps/backend/src/recruitment/http-access.ts#L52), 2 consumers:
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
- `interviewAuthorizationInTransaction`: Resolves the current person and authorizes one interview inside the caller's transaction; a rejected credential is answered from the request's evidence.
  [apps/backend/src/recruitment/http-access.ts:200](../apps/backend/src/recruitment/http-access.ts#L200), 2 consumers:
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
- `readRecruitmentBody`: Every recruitment request body is one bounded `application/json` document.
  [apps/backend/src/recruitment/http-decode.ts:17](../apps/backend/src/recruitment/http-decode.ts#L17), 2 consumers:
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
- `recruitmentProblems`: The one answer for every recruitment failure.
  [apps/backend/src/recruitment/http-problem.ts:30](../apps/backend/src/recruitment/http-problem.ts#L30), 3 consumers:
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
- `raceProblems`: A failure that lost a serialization or deadlock race answers transaction.conflict, whatever failure carried it.
  [apps/backend/src/recruitment/http-problem.ts:108](../apps/backend/src/recruitment/http-problem.ts#L108), 2 consumers:
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
- `maintenanceProblems`: The maintenance API answers its own failures, an unknown interview, and an identity outage in its own vocabulary; everything else as recruitment does.
  [apps/backend/src/recruitment/http-problem.ts:119](../apps/backend/src/recruitment/http-problem.ts#L119), 1 consumer:
  - [apps/backend/src/recruitment/maintenance-http.ts](../apps/backend/src/recruitment/maintenance-http.ts)
- `schoolsProblems`: The one answer for every Schools failure.
  [apps/backend/src/schools/http.ts:57](../apps/backend/src/schools/http.ts#L57), 1 consumer:
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
- `schoolsCredentialProblems`: A person credential rejected after ingress is answered from the request's own evidence; an unavailable identity provider leaves Schools unavailable.
  [apps/backend/src/schools/http.ts:87](../apps/backend/src/schools/http.ts#L87), 1 consumer:
  - [apps/backend/src/schools/administration-http.ts](../apps/backend/src/schools/administration-http.ts)
- `problemUnion`: Creates a closed endpoint-specific Problem Details union.
  [packages/http-api/src/http-semantics.ts:1110](../packages/http-api/src/http-semantics.ts#L1110), 11 consumers:
  - [packages/http-api/src/admission-outcomes.ts](../packages/http-api/src/admission-outcomes.ts)
  - [packages/http-api/src/common.ts](../packages/http-api/src/common.ts)
  - [packages/http-api/src/contact.ts](../packages/http-api/src/contact.ts)
  - [packages/http-api/src/directory.ts](../packages/http-api/src/directory.ts)
  - [packages/http-api/src/endpoint-problems.ts](../packages/http-api/src/endpoint-problems.ts)
  - [packages/http-api/src/onboarding.ts](../packages/http-api/src/onboarding.ts)
  - [packages/http-api/src/organization.ts](../packages/http-api/src/organization.ts)
  - [packages/http-api/src/placements.ts](../packages/http-api/src/placements.ts)
  - [packages/http-api/src/recruitment.ts](../packages/http-api/src/recruitment.ts)
  - [packages/http-api/src/social-events.ts](../packages/http-api/src/social-events.ts)
  - [packages/http-api/src/team-application.ts](../packages/http-api/src/team-application.ts)
- `Problem`: One RFC 9457 failure in an Effect error channel.
  [packages/http-api/src/http-semantics.ts:1212](../packages/http-api/src/http-semantics.ts#L1212), 39 consumers:
  - [apps/backend/src/admission/http-decode.ts](../apps/backend/src/admission/http-decode.ts)
  - [apps/backend/src/admission/http-problem.ts](../apps/backend/src/admission/http-problem.ts)
  - [apps/backend/src/admission/http-reads.ts](../apps/backend/src/admission/http-reads.ts)
  - [apps/backend/src/admission/outcome-http.ts](../apps/backend/src/admission/outcome-http.ts)
  - [apps/backend/src/contact/http.ts](../apps/backend/src/contact/http.ts)
  - [apps/backend/src/content/http-commands.ts](../apps/backend/src/content/http-commands.ts)
  - [apps/backend/src/content/http-context.ts](../apps/backend/src/content/http-context.ts)
  - [apps/backend/src/content/http-decode.ts](../apps/backend/src/content/http-decode.ts)
  - [apps/backend/src/content/http-problem.ts](../apps/backend/src/content/http-problem.ts)
  - [apps/backend/src/directory/http.ts](../apps/backend/src/directory/http.ts)
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
  - [apps/backend/src/http-api/read-json.ts](../apps/backend/src/http-api/read-json.ts)
  - [apps/backend/src/http-api/system.ts](../apps/backend/src/http-api/system.ts)
  - [apps/backend/src/http-api/transport.test.ts](../apps/backend/src/http-api/transport.test.ts)
  - [apps/backend/src/http-api/transport.ts](../apps/backend/src/http-api/transport.ts)
  - [apps/backend/src/http-semantics.test.ts](../apps/backend/src/http-semantics.test.ts)
  - [apps/backend/src/http-semantics.ts](../apps/backend/src/http-semantics.ts)
  - [apps/backend/src/onboarding/http.ts](../apps/backend/src/onboarding/http.ts)
  - [apps/backend/src/organization/http.ts](../apps/backend/src/organization/http.ts)
  - [apps/backend/src/placements/http.ts](../apps/backend/src/placements/http.ts)
  - [apps/backend/src/profile/http.ts](../apps/backend/src/profile/http.ts)
  - [apps/backend/src/receipt/e2e-support.test.ts](../apps/backend/src/receipt/e2e-support.test.ts)
  - [apps/backend/src/receipt/e2e-support.ts](../apps/backend/src/receipt/e2e-support.ts)
  - [apps/backend/src/receipt/http-commands.ts](../apps/backend/src/receipt/http-commands.ts)
  - [apps/backend/src/receipt/http-decode.ts](../apps/backend/src/receipt/http-decode.ts)
  - [apps/backend/src/receipt/http-problem.ts](../apps/backend/src/receipt/http-problem.ts)
  - [apps/backend/src/receipt/http-reads.ts](../apps/backend/src/receipt/http-reads.ts)
  - [apps/backend/src/receipt/http-representation.ts](../apps/backend/src/receipt/http-representation.ts)
  - [apps/backend/src/recruitment/http-access.ts](../apps/backend/src/recruitment/http-access.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/backend/src/recruitment/http-decode.ts](../apps/backend/src/recruitment/http-decode.ts)
  - [apps/backend/src/recruitment/http-problem.ts](../apps/backend/src/recruitment/http-problem.ts)
  - [apps/backend/src/recruitment/http-reads.ts](../apps/backend/src/recruitment/http-reads.ts)
  - [apps/backend/src/router.ts](../apps/backend/src/router.ts)
  - [apps/backend/src/schools/http.ts](../apps/backend/src/schools/http.ts)
  - [apps/backend/src/social-events/http.ts](../apps/backend/src/social-events/http.ts)
  - [apps/backend/src/team-application/http.ts](../apps/backend/src/team-application/http.ts)
  - [apps/dashboard/app/lib/admission-period-view.test.ts](../apps/dashboard/app/lib/admission-period-view.test.ts)
  - [apps/dashboard/app/lib/native-problem.test.ts](../apps/dashboard/app/lib/native-problem.test.ts)
- `isProblem`: Narrows a caught value to a `Problem`, also one that another copy of this module created.
  [packages/http-api/src/http-semantics.ts:1300](../packages/http-api/src/http-semantics.ts#L1300), 10 consumers:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
  - [apps/backend/src/http-semantics.ts](../apps/backend/src/http-semantics.ts)
  - [apps/backend/src/receipt/e2e-support.test.ts](../apps/backend/src/receipt/e2e-support.test.ts)
  - [apps/backend/src/recruitment/http-commands.ts](../apps/backend/src/recruitment/http-commands.ts)
  - [apps/dashboard/app/lib/native-problem.ts](../apps/dashboard/app/lib/native-problem.ts)
  - [apps/homepage/src/lib/contact-message.server.ts](../apps/homepage/src/lib/contact-message.server.ts)
  - [apps/homepage/src/lib/news.server.ts](../apps/homepage/src/lib/news.server.ts)
  - [apps/homepage/src/lib/public-application.ts](../apps/homepage/src/lib/public-application.ts)
  - [apps/homepage/src/lib/public-team-application.ts](../apps/homepage/src/lib/public-team-application.ts)
  - [tools/acceptance/substitute-outcome-check.ts](../tools/acceptance/substitute-outcome-check.ts)
- `problemBody`: The frozen RFC 9457 body: the registry entry, then code, instance, and validation.
  [packages/http-api/src/http-semantics.ts:1314](../packages/http-api/src/http-semantics.ts#L1314), 5 consumers:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
  - [apps/dashboard/app/lib/native-problem.ts](../apps/dashboard/app/lib/native-problem.ts)
  - [apps/homepage/src/lib/public-application.ts](../apps/homepage/src/lib/public-application.ts)
  - [apps/homepage/src/lib/public-team-application.ts](../apps/homepage/src/lib/public-team-application.ts)
  - [tools/acceptance/substitute-outcome-check.ts](../tools/acceptance/substitute-outcome-check.ts)
- `problemHeaders`: The response headers of one problem: `no-store`, its challenge, and its retry delay.
  [packages/http-api/src/http-semantics.ts:1339](../packages/http-api/src/http-semantics.ts#L1339), 1 consumer:
  - [apps/backend/src/http-api/problem.ts](../apps/backend/src/http-api/problem.ts)
- `makeNativeProblem`: Builds one safe fixed public problem value.
  [packages/http-api/src/http-semantics.ts:1487](../packages/http-api/src/http-semantics.ts#L1487), 8 consumers:
  - [apps/dashboard/app/foldkit/team-applications/update.test.ts](../apps/dashboard/app/foldkit/team-applications/update.test.ts)
  - [apps/dashboard/app/lib/auth.server.test.ts](../apps/dashboard/app/lib/auth.server.test.ts)
  - [apps/dashboard/app/lib/native-problem.test.ts](../apps/dashboard/app/lib/native-problem.test.ts)
  - [apps/dashboard/test/native-http.ts](../apps/dashboard/test/native-http.ts)
  - [apps/homepage/test/contact-message.test.ts](../apps/homepage/test/contact-message.test.ts)
  - [apps/homepage/test/news.test.ts](../apps/homepage/test/news.test.ts)
  - [apps/homepage/test/public-application.test.ts](../apps/homepage/test/public-application.test.ts)
  - [apps/homepage/test/public-team-application.test.ts](../apps/homepage/test/public-team-application.test.ts)

## sql-lock

Transaction-scoped PostgreSQL advisory locks under registered keys.

- `AdvisoryLockKey`: The registered advisory-lock keys, one constructor per namespace.
  [packages/database/src/advisory-lock.ts:40](../packages/database/src/advisory-lock.ts#L40), 24 consumers:
  - [apps/backend/src/http-api/receipt-transaction.test.ts](../apps/backend/src/http-api/receipt-transaction.test.ts)
  - [apps/backend/src/http-api/receipt-transaction.ts](../apps/backend/src/http-api/receipt-transaction.ts)
  - [packages/database/src/admission-period/postgres.ts](../packages/database/src/admission-period/postgres.ts)
  - [packages/database/src/application/postgres.ts](../packages/database/src/application/postgres.ts)
  - [packages/database/src/application/returning-postgres.ts](../packages/database/src/application/returning-postgres.ts)
  - [packages/database/src/authz/delegation-postgres.ts](../packages/database/src/authz/delegation-postgres.ts)
  - [packages/database/src/authz/disposable-backfill.ts](../packages/database/src/authz/disposable-backfill.ts)
  - [packages/database/src/authz/postgres.ts](../packages/database/src/authz/postgres.ts)
  - [packages/database/src/content/postgres.ts](../packages/database/src/content/postgres.ts)
  - [packages/database/src/onboarding/postgres.ts](../packages/database/src/onboarding/postgres.ts)
  - [packages/database/src/organization/administration-postgres.ts](../packages/database/src/organization/administration-postgres.ts)
  - [packages/database/src/organization/authority-postgres.ts](../packages/database/src/organization/authority-postgres.ts)
  - [packages/database/src/organization/lifecycle-postgres.ts](../packages/database/src/organization/lifecycle-postgres.ts)
  - [packages/database/src/profile/postgres.ts](../packages/database/src/profile/postgres.ts)
  - [packages/database/src/receipt/postgres.ts](../packages/database/src/receipt/postgres.ts)
  - [packages/database/src/receipt/reviewed-cohort.ts](../packages/database/src/receipt/reviewed-cohort.ts)
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)
  - [packages/database/src/recruitment/conduct-postgres.ts](../packages/database/src/recruitment/conduct-postgres.ts)
  - [packages/database/src/recruitment/invitation-response-postgres.ts](../packages/database/src/recruitment/invitation-response-postgres.ts)
  - [packages/database/src/recruitment/maintenance-postgres.ts](../packages/database/src/recruitment/maintenance-postgres.ts)
  - [packages/database/src/recruitment/postgres.ts](../packages/database/src/recruitment/postgres.ts)
  - [packages/database/src/recruitment/scheduling-postgres.ts](../packages/database/src/recruitment/scheduling-postgres.ts)
  - [packages/database/src/schools/administration.ts](../packages/database/src/schools/administration.ts)
  - [packages/database/src/team-application/postgres.ts](../packages/database/src/team-application/postgres.ts)
- `lockAdvisory`: Waits for the advisory lock on `key` until the current transaction ends.
  [packages/database/src/advisory-lock.ts:128](../packages/database/src/advisory-lock.ts#L128), 23 consumers:
  - [apps/backend/src/http-api/receipt-transaction.test.ts](../apps/backend/src/http-api/receipt-transaction.test.ts)
  - [packages/database/src/admission-period/postgres.ts](../packages/database/src/admission-period/postgres.ts)
  - [packages/database/src/application/postgres.ts](../packages/database/src/application/postgres.ts)
  - [packages/database/src/application/returning-postgres.ts](../packages/database/src/application/returning-postgres.ts)
  - [packages/database/src/authz/delegation-postgres.ts](../packages/database/src/authz/delegation-postgres.ts)
  - [packages/database/src/authz/disposable-backfill.ts](../packages/database/src/authz/disposable-backfill.ts)
  - [packages/database/src/authz/postgres.ts](../packages/database/src/authz/postgres.ts)
  - [packages/database/src/content/postgres.ts](../packages/database/src/content/postgres.ts)
  - [packages/database/src/onboarding/postgres.ts](../packages/database/src/onboarding/postgres.ts)
  - [packages/database/src/organization/administration-postgres.ts](../packages/database/src/organization/administration-postgres.ts)
  - [packages/database/src/organization/authority-postgres.ts](../packages/database/src/organization/authority-postgres.ts)
  - [packages/database/src/organization/lifecycle-postgres.ts](../packages/database/src/organization/lifecycle-postgres.ts)
  - [packages/database/src/profile/postgres.ts](../packages/database/src/profile/postgres.ts)
  - [packages/database/src/receipt/postgres.ts](../packages/database/src/receipt/postgres.ts)
  - [packages/database/src/receipt/reviewed-cohort.ts](../packages/database/src/receipt/reviewed-cohort.ts)
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)
  - [packages/database/src/recruitment/conduct-postgres.ts](../packages/database/src/recruitment/conduct-postgres.ts)
  - [packages/database/src/recruitment/invitation-response-postgres.ts](../packages/database/src/recruitment/invitation-response-postgres.ts)
  - [packages/database/src/recruitment/maintenance-postgres.ts](../packages/database/src/recruitment/maintenance-postgres.ts)
  - [packages/database/src/recruitment/postgres.ts](../packages/database/src/recruitment/postgres.ts)
  - [packages/database/src/recruitment/scheduling-postgres.ts](../packages/database/src/recruitment/scheduling-postgres.ts)
  - [packages/database/src/schools/administration.ts](../packages/database/src/schools/administration.ts)
  - [packages/database/src/team-application/postgres.ts](../packages/database/src/team-application/postgres.ts)
- `tryLockAdvisory`: Takes the exclusive advisory lock on `key` until the current transaction ends when no other transaction holds it.
  [packages/database/src/advisory-lock.ts:144](../packages/database/src/advisory-lock.ts#L144), 1 consumer:
  - [apps/backend/src/http-api/receipt-transaction.ts](../apps/backend/src/http-api/receipt-transaction.ts)
- `lockOrganizationAdministratorSet`: Acquire before any person lock when changing the usable administrator set.
  [packages/database/src/organization/authority-postgres.ts:36](../packages/database/src/organization/authority-postgres.ts#L36), 1 consumer:
  - [packages/database/src/organization/lifecycle-postgres.ts](../packages/database/src/organization/lifecycle-postgres.ts)
- `lockPersonAuthorization`: Serializes one person's protected command with person-keyed authority writers.
  [packages/database/src/organization/authority-postgres.ts:44](../packages/database/src/organization/authority-postgres.ts#L44), 9 consumers:
  - [packages/database/src/authz/delegation-postgres.ts](../packages/database/src/authz/delegation-postgres.ts)
  - [packages/database/src/organization/lifecycle-postgres.ts](../packages/database/src/organization/lifecycle-postgres.ts)
  - [packages/database/src/organization/postgres.ts](../packages/database/src/organization/postgres.ts)
  - [packages/database/src/receipt/authority-postgres.ts](../packages/database/src/receipt/authority-postgres.ts)
  - [packages/database/src/receipt/postgres.ts](../packages/database/src/receipt/postgres.ts)
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)
  - [packages/database/src/recruitment/maintenance-postgres.ts](../packages/database/src/recruitment/maintenance-postgres.ts)
  - [packages/database/src/schools/administration.ts](../packages/database/src/schools/administration.ts)
  - [packages/database/src/team-application/postgres.ts](../packages/database/src/team-application/postgres.ts)

## sql-lifecycle

Claim-fenced row lifecycles in PostgreSQL, such as outbox claims and account access.

- `accountAccessEnabled`: Whether the native account of `personId` exists and is not disabled.
  [packages/database/src/identity-access.ts:17](../packages/database/src/identity-access.ts#L17), 4 consumers:
  - [packages/database/src/authz/delegation-postgres.ts](../packages/database/src/authz/delegation-postgres.ts)
  - [packages/database/src/organization/lifecycle-postgres.ts](../packages/database/src/organization/lifecycle-postgres.ts)
  - [packages/database/src/recruitment/maintenance-postgres.ts](../packages/database/src/recruitment/maintenance-postgres.ts)
  - [packages/database/src/schools/administration.ts](../packages/database/src/schools/administration.ts)
- `outboxClaimAssignments`: SET list for the aggregate's claim UPDATE; `targetAlias` names the updated outbox row.
  [packages/database/src/outbox-lifecycle.ts:123](../packages/database/src/outbox-lifecycle.ts#L123), 8 consumers:
  - [packages/database/src/application/outbox.ts](../packages/database/src/application/outbox.ts)
  - [packages/database/src/outbox-lifecycle.test.ts](../packages/database/src/outbox-lifecycle.test.ts)
  - [packages/database/src/placements/outbox.ts](../packages/database/src/placements/outbox.ts)
  - [packages/database/src/receipt/outbox.ts](../packages/database/src/receipt/outbox.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/team-application/outbox.ts](../packages/database/src/team-application/outbox.ts)
- `markOutboxDelivered`: Settles the claimed row as Delivered, with delivery evidence when the table records it.
  [packages/database/src/outbox-lifecycle.ts:138](../packages/database/src/outbox-lifecycle.ts#L138), 8 consumers:
  - [packages/database/src/application/outbox.ts](../packages/database/src/application/outbox.ts)
  - [packages/database/src/outbox-lifecycle.test.ts](../packages/database/src/outbox-lifecycle.test.ts)
  - [packages/database/src/placements/outbox.ts](../packages/database/src/placements/outbox.ts)
  - [packages/database/src/receipt/outbox.ts](../packages/database/src/receipt/outbox.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/team-application/outbox.ts](../packages/database/src/team-application/outbox.ts)
- `markOutboxFailed`: Settles the claimed row as Failed with its failure tag, so a later claim retries it.
  [packages/database/src/outbox-lifecycle.ts:168](../packages/database/src/outbox-lifecycle.ts#L168), 8 consumers:
  - [packages/database/src/application/outbox.ts](../packages/database/src/application/outbox.ts)
  - [packages/database/src/outbox-lifecycle.test.ts](../packages/database/src/outbox-lifecycle.test.ts)
  - [packages/database/src/placements/outbox.ts](../packages/database/src/placements/outbox.ts)
  - [packages/database/src/receipt/outbox.ts](../packages/database/src/receipt/outbox.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/team-application/outbox.ts](../packages/database/src/team-application/outbox.ts)
- `quarantineOutboxClaim`: Settles the claimed row as Quarantined, a terminal status, with its failure tag.
  [packages/database/src/outbox-lifecycle.ts:182](../packages/database/src/outbox-lifecycle.ts#L182), 8 consumers:
  - [packages/database/src/application/outbox.ts](../packages/database/src/application/outbox.ts)
  - [packages/database/src/outbox-lifecycle.test.ts](../packages/database/src/outbox-lifecycle.test.ts)
  - [packages/database/src/placements/outbox.ts](../packages/database/src/placements/outbox.ts)
  - [packages/database/src/receipt/outbox.ts](../packages/database/src/receipt/outbox.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/team-application/outbox.ts](../packages/database/src/team-application/outbox.ts)
- `releaseOutboxClaim`: Returns an interrupted claim to Pending without a provider outcome; a lost claim needs none.
  [packages/database/src/outbox-lifecycle.ts:203](../packages/database/src/outbox-lifecycle.ts#L203), 6 consumers:
  - [packages/database/src/application/outbox.ts](../packages/database/src/application/outbox.ts)
  - [packages/database/src/outbox-lifecycle.test.ts](../packages/database/src/outbox-lifecycle.test.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/team-application/outbox.ts](../packages/database/src/team-application/outbox.ts)
- `recoverStaleOutboxClaims`: Recovers every Processing row claimed before `claimedBefore`.
  [packages/database/src/outbox-lifecycle.ts:221](../packages/database/src/outbox-lifecycle.ts#L221), 7 consumers:
  - [packages/database/src/application/outbox.ts](../packages/database/src/application/outbox.ts)
  - [packages/database/src/outbox-lifecycle.test.ts](../packages/database/src/outbox-lifecycle.test.ts)
  - [packages/database/src/placements/outbox.ts](../packages/database/src/placements/outbox.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/team-application/outbox.ts](../packages/database/src/team-application/outbox.ts)
- `recoverStaleOutboxClaim`: Recovers the rows of one claim when that claim was taken before `claimedBefore`.
  [packages/database/src/outbox-lifecycle.ts:234](../packages/database/src/outbox-lifecycle.ts#L234), 1 consumer:
  - [packages/database/src/receipt/outbox.ts](../packages/database/src/receipt/outbox.ts)

## delivery

Delivers committed effects to providers after the transaction.

- `deliverJson`: Shared acknowledged JSON transport; deliberately no retry on ambiguous acceptance.
  [apps/backend/src/delivery/http.ts:32](../apps/backend/src/delivery/http.ts#L32), 10 consumers:
  - [apps/backend/src/application/effects.ts](../apps/backend/src/application/effects.ts)
  - [apps/backend/src/contact/http.ts](../apps/backend/src/contact/http.ts)
  - [apps/backend/src/mail/http.ts](../apps/backend/src/mail/http.ts)
  - [apps/backend/src/onboarding/delivery.ts](../apps/backend/src/onboarding/delivery.ts)
  - [apps/backend/src/placements/notification.ts](../apps/backend/src/placements/notification.ts)
  - [apps/backend/src/receipt/delivery.test.ts](../apps/backend/src/receipt/delivery.test.ts)
  - [apps/backend/src/receipt/delivery.ts](../apps/backend/src/receipt/delivery.ts)
  - [apps/backend/src/recruitment/delivery.ts](../apps/backend/src/recruitment/delivery.ts)
  - [tools/acceptance/recommendation-check.ts](../tools/acceptance/recommendation-check.ts)
  - [tools/verification/completion-receipt-postgres-proof-main.ts](../tools/verification/completion-receipt-postgres-proof-main.ts)

## worker

Runs background workers on the Effect clock.

- `pollForever`: Runs `tick` at once, then again after each success.
  [apps/backend/src/worker-support.ts:24](../apps/backend/src/worker-support.ts#L24), 8 consumers:
  - [apps/backend/src/application/worker.ts](../apps/backend/src/application/worker.ts)
  - [apps/backend/src/onboarding/delivery.ts](../apps/backend/src/onboarding/delivery.ts)
  - [apps/backend/src/password-recovery/worker.ts](../apps/backend/src/password-recovery/worker.ts)
  - [apps/backend/src/placements/notification.ts](../apps/backend/src/placements/notification.ts)
  - [apps/backend/src/receipt/worker.ts](../apps/backend/src/receipt/worker.ts)
  - [apps/backend/src/recruitment/worker.ts](../apps/backend/src/recruitment/worker.ts)
  - [apps/backend/src/team-application/worker.ts](../apps/backend/src/team-application/worker.ts)
  - [apps/backend/src/worker-support.test.ts](../apps/backend/src/worker-support.test.ts)

## runtime-bridge

Runs the Effect programs behind Promise callbacks that a third-party library calls, inside the scope of the layer that owns the library.

- `makeBetterAuthCallbackRunner`: Creates the runner for Better Auth's Promise callbacks: it forks each program into a fiber set that the current scope owns, so closing the scope interrupts the callbacks still running.
  [packages/database/src/auth-engine.ts:39](../packages/database/src/auth-engine.ts#L39), no consumers.

## pagination

Keyset cursors and pages over ordered PostgreSQL reads.

- `CursorPositioned`: A row with the ordering text that `receiptCursorTimestamp` selects.
  [packages/database/src/receipt/cursor.ts:22](../packages/database/src/receipt/cursor.ts#L22), 2 consumers:
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)
  - [packages/database/src/service-principal-grants-live.ts](../packages/database/src/service-principal-grants-live.ts)
- `receiptCursorTimestamp`: Selects the ordering column as microsecond UTC text so cursor positions compare exactly.
  [packages/database/src/receipt/cursor.ts:29](../packages/database/src/receipt/cursor.ts#L29), 2 consumers:
  - [packages/database/src/receipt/projections.ts](../packages/database/src/receipt/projections.ts)
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)
- `withoutCursorTimestamp`: Drops the ordering text from a row before the row leaves the adapter.
  [packages/database/src/receipt/cursor.ts:40](../packages/database/src/receipt/cursor.ts#L40), 1 consumer:
  - [packages/database/src/service-principal-grants-live.ts](../packages/database/src/service-principal-grants-live.ts)
- `receiptCursorPage`: Keeps one page of the rows, encodes the next cursor when a further row was read, and drops the ordering text.
  [packages/database/src/receipt/cursor.ts:51](../packages/database/src/receipt/cursor.ts#L51), 3 consumers:
  - [packages/database/src/receipt/postgres.ts](../packages/database/src/receipt/postgres.ts)
  - [packages/database/src/receipt/projections.ts](../packages/database/src/receipt/projections.ts)
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)

## digest

Canonical JSON and SHA-256 digests that evidence and idempotency identities hash.

- `canonicalJsonValue`: The plain JSON value of a datum, with sorted object keys and non-finite numbers as `null`.
  [packages/domain/src/shared-kernel/canonical-json.ts:18](../packages/domain/src/shared-kernel/canonical-json.ts#L18), 13 consumers:
  - [packages/database/runtime/historical-service-cohort-rehearsal.ts](../packages/database/runtime/historical-service-cohort-rehearsal.ts)
  - [packages/database/src/admission-period/postgres.ts](../packages/database/src/admission-period/postgres.ts)
  - [packages/database/src/application/returning-postgres.ts](../packages/database/src/application/returning-postgres.ts)
  - [packages/database/src/auth-live.ts](../packages/database/src/auth-live.ts)
  - [packages/database/src/organization/postgres.ts](../packages/database/src/organization/postgres.ts)
  - [packages/database/src/profile/postgres.ts](../packages/database/src/profile/postgres.ts)
  - [packages/database/src/recruitment/postgres.ts](../packages/database/src/recruitment/postgres.ts)
  - [packages/domain/runtime/tutor-d1-proof-main.ts](../packages/domain/runtime/tutor-d1-proof-main.ts)
  - [tools/e2e/legacy-receipt-snapshot.ts](../tools/e2e/legacy-receipt-snapshot.ts)
  - [tools/verification/current-assignment-cohort-rehearsal.ts](../tools/verification/current-assignment-cohort-rehearsal.ts)
  - [tools/verification/organization-import-rehearsal-main.ts](../tools/verification/organization-import-rehearsal-main.ts)
  - [tools/verification/organization-import-rehearsal-postgres.ts](../tools/verification/organization-import-rehearsal-postgres.ts)
  - [tools/verification/receipt-import-rehearsal.ts](../tools/verification/receipt-import-rehearsal.ts)
- `canonicalJson`: The canonical JSON text of a datum, to hash or compare; a SQL `json` parameter takes `canonicalJsonValue` instead.
  [packages/domain/src/shared-kernel/canonical-json.ts:62](../packages/domain/src/shared-kernel/canonical-json.ts#L62), 57 consumers:
  - [apps/backend/src/http-semantics.ts](../apps/backend/src/http-semantics.ts)
  - [packages/database/runtime/authorization-rules-postgres-proof-main.ts](../packages/database/runtime/authorization-rules-postgres-proof-main.ts)
  - [packages/database/runtime/identity-postgres-proof-main.ts](../packages/database/runtime/identity-postgres-proof-main.ts)
  - [packages/database/runtime/invitation-response-postgres-proof-main.ts](../packages/database/runtime/invitation-response-postgres-proof-main.ts)
  - [packages/database/runtime/organization-postgres-proof-main.ts](../packages/database/runtime/organization-postgres-proof-main.ts)
  - [packages/database/runtime/profile-postgres-proof-main.ts](../packages/database/runtime/profile-postgres-proof-main.ts)
  - [packages/database/runtime/receipt-postgres-proof-main.ts](../packages/database/runtime/receipt-postgres-proof-main.ts)
  - [packages/database/runtime/scheduling-postgres-proof-main.ts](../packages/database/runtime/scheduling-postgres-proof-main.ts)
  - [packages/database/runtime/schools-postgres-proof-main.ts](../packages/database/runtime/schools-postgres-proof-main.ts)
  - [packages/database/src/admission-period/postgres.ts](../packages/database/src/admission-period/postgres.ts)
  - [packages/database/src/advisory-lock.ts](../packages/database/src/advisory-lock.ts)
  - [packages/database/src/application/postgres.ts](../packages/database/src/application/postgres.ts)
  - [packages/database/src/application/returning-postgres.ts](../packages/database/src/application/returning-postgres.ts)
  - [packages/database/src/authz/disposable-backfill.ts](../packages/database/src/authz/disposable-backfill.ts)
  - [packages/database/src/content/postgres.ts](../packages/database/src/content/postgres.ts)
  - [packages/database/src/historical-service-cohort.ts](../packages/database/src/historical-service-cohort.ts)
  - [packages/database/src/identity-cohort-cli.ts](../packages/database/src/identity-cohort-cli.ts)
  - [packages/database/src/identity-cohort.ts](../packages/database/src/identity-cohort.ts)
  - [packages/database/src/person-cohort-accepted-mappings.test.ts](../packages/database/src/person-cohort-accepted-mappings.test.ts)
  - [packages/database/src/person-cohort.ts](../packages/database/src/person-cohort.ts)
  - [packages/database/src/placements/current-assignment-cohort.test.ts](../packages/database/src/placements/current-assignment-cohort.test.ts)
  - [packages/database/src/placements/current-assignment-cohort.ts](../packages/database/src/placements/current-assignment-cohort.ts)
  - [packages/database/src/placements/current-assignment-import.test.ts](../packages/database/src/placements/current-assignment-import.test.ts)
  - [packages/database/src/placements/outbox.ts](../packages/database/src/placements/outbox.ts)
  - [packages/database/src/profile/postgres.ts](../packages/database/src/profile/postgres.ts)
  - [packages/database/src/receipt/file-proof.ts](../packages/database/src/receipt/file-proof.ts)
  - [packages/database/src/receipt/postgres.ts](../packages/database/src/receipt/postgres.ts)
  - [packages/database/src/receipt/reviewed-cohort.ts](../packages/database/src/receipt/reviewed-cohort.ts)
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/conduct-postgres.ts](../packages/database/src/recruitment/conduct-postgres.ts)
  - [packages/database/src/recruitment/invitation-response-postgres.ts](../packages/database/src/recruitment/invitation-response-postgres.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/postgres.ts](../packages/database/src/recruitment/postgres.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/recruitment/scheduling-postgres.ts](../packages/database/src/recruitment/scheduling-postgres.ts)
  - [packages/database/src/rule-reconciliation-postgres-tracer-main.ts](../packages/database/src/rule-reconciliation-postgres-tracer-main.ts)
  - [packages/database/src/test-support/disposable-authz-backfill.test.ts](../packages/database/src/test-support/disposable-authz-backfill.test.ts)
  - [packages/database/src/test-support/disposable-person-authority-backfill.ts](../packages/database/src/test-support/disposable-person-authority-backfill.ts)
  - [packages/domain/runtime/tutor-d1-proof-main.ts](../packages/domain/runtime/tutor-d1-proof-main.ts)
  - [packages/domain/runtime/tutor-d1.ts](../packages/domain/runtime/tutor-d1.ts)
  - [packages/domain/src/admission-period/digest.ts](../packages/domain/src/admission-period/digest.ts)
  - [packages/domain/src/organization/import.test.ts](../packages/domain/src/organization/import.test.ts)
  - [packages/domain/src/organization/import.ts](../packages/domain/src/organization/import.ts)
  - [packages/domain/src/organization/review-classification.ts](../packages/domain/src/organization/review-classification.ts)
  - [packages/domain/src/receipt/import.test.ts](../packages/domain/src/receipt/import.test.ts)
  - [packages/domain/src/shared-kernel/canonical-json.test.ts](../packages/domain/src/shared-kernel/canonical-json.test.ts)
  - [packages/domain/src/tutor/d1-proof.ts](../packages/domain/src/tutor/d1-proof.ts)
  - [packages/domain/src/tutor/evidence.ts](../packages/domain/src/tutor/evidence.ts)
  - [packages/domain/src/tutor/main.ts](../packages/domain/src/tutor/main.ts)
  - [packages/domain/src/tutor/tracer.ts](../packages/domain/src/tutor/tracer.ts)
  - [tools/acceptance/applicant-progress-0107.ts](../tools/acceptance/applicant-progress-0107.ts)
  - [tools/acceptance/recommendation-preupgrade-fixture.ts](../tools/acceptance/recommendation-preupgrade-fixture.ts)
  - [tools/e2e/legacy-cutover-references.ts](../tools/e2e/legacy-cutover-references.ts)
  - [tools/e2e/run-legacy-backup-person-rehearsal.ts](../tools/e2e/run-legacy-backup-person-rehearsal.ts)
  - [tools/verification/organization-import-rehearsal-main.ts](../tools/verification/organization-import-rehearsal-main.ts)
  - [tools/verification/organization-import-rehearsal.ts](../tools/verification/organization-import-rehearsal.ts)
- `canonicalJsonBytes`: The UTF-8 bytes of the canonical JSON text of a datum.
  [packages/domain/src/shared-kernel/canonical-json.ts:69](../packages/domain/src/shared-kernel/canonical-json.ts#L69), 59 consumers:
  - [apps/backend/src/http-semantics.ts](../apps/backend/src/http-semantics.ts)
  - [apps/backend/src/receipt/import-snapshot.ts](../apps/backend/src/receipt/import-snapshot.ts)
  - [packages/database/runtime/authorization-rules-postgres-proof-main.ts](../packages/database/runtime/authorization-rules-postgres-proof-main.ts)
  - [packages/database/runtime/identity-postgres-proof-main.ts](../packages/database/runtime/identity-postgres-proof-main.ts)
  - [packages/database/runtime/invitation-response-postgres-proof-main.ts](../packages/database/runtime/invitation-response-postgres-proof-main.ts)
  - [packages/database/runtime/organization-postgres-proof-main.ts](../packages/database/runtime/organization-postgres-proof-main.ts)
  - [packages/database/runtime/profile-postgres-proof-main.ts](../packages/database/runtime/profile-postgres-proof-main.ts)
  - [packages/database/runtime/receipt-postgres-proof-main.ts](../packages/database/runtime/receipt-postgres-proof-main.ts)
  - [packages/database/runtime/scheduling-postgres-proof-main.ts](../packages/database/runtime/scheduling-postgres-proof-main.ts)
  - [packages/database/runtime/schools-postgres-proof-main.ts](../packages/database/runtime/schools-postgres-proof-main.ts)
  - [packages/database/src/authz/delegation-postgres.ts](../packages/database/src/authz/delegation-postgres.ts)
  - [packages/database/src/authz/disposable-backfill.test.ts](../packages/database/src/authz/disposable-backfill.test.ts)
  - [packages/database/src/authz/disposable-backfill.ts](../packages/database/src/authz/disposable-backfill.ts)
  - [packages/database/src/content/postgres.ts](../packages/database/src/content/postgres.ts)
  - [packages/database/src/organization/lifecycle-postgres.ts](../packages/database/src/organization/lifecycle-postgres.ts)
  - [packages/database/src/profile/postgres.ts](../packages/database/src/profile/postgres.ts)
  - [packages/database/src/receipt/postgres-proof.ts](../packages/database/src/receipt/postgres-proof.ts)
  - [packages/database/src/receipt/postgres.ts](../packages/database/src/receipt/postgres.ts)
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/conduct-postgres.ts](../packages/database/src/recruitment/conduct-postgres.ts)
  - [packages/database/src/recruitment/invitation-response-postgres.ts](../packages/database/src/recruitment/invitation-response-postgres.ts)
  - [packages/database/src/recruitment/maintenance-postgres.ts](../packages/database/src/recruitment/maintenance-postgres.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/postgres.ts](../packages/database/src/recruitment/postgres.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/recruitment/scheduling-postgres.ts](../packages/database/src/recruitment/scheduling-postgres.ts)
  - [packages/database/src/schools/administration.ts](../packages/database/src/schools/administration.ts)
  - [packages/database/src/social-events/postgres.ts](../packages/database/src/social-events/postgres.ts)
  - [packages/database/src/team-application/postgres.ts](../packages/database/src/team-application/postgres.ts)
  - [packages/database/src/test-support/disposable-person-authority-backfill.ts](../packages/database/src/test-support/disposable-person-authority-backfill.ts)
  - [packages/domain/runtime/tutor-d1-proof-main.ts](../packages/domain/runtime/tutor-d1-proof-main.ts)
  - [packages/domain/runtime/tutor-d1.ts](../packages/domain/runtime/tutor-d1.ts)
  - [packages/domain/src/admission-period/digest.ts](../packages/domain/src/admission-period/digest.ts)
  - [packages/domain/src/application/digest.ts](../packages/domain/src/application/digest.ts)
  - [packages/domain/src/organization/administration.ts](../packages/domain/src/organization/administration.ts)
  - [packages/domain/src/organization/review.ts](../packages/domain/src/organization/review.ts)
  - [packages/domain/src/receipt/auxiliary-service.ts](../packages/domain/src/receipt/auxiliary-service.ts)
  - [packages/domain/src/receipt/file-service.ts](../packages/domain/src/receipt/file-service.ts)
  - [packages/domain/src/receipt/review.ts](../packages/domain/src/receipt/review.ts)
  - [tools/acceptance/applicant-progress-0107.ts](../tools/acceptance/applicant-progress-0107.ts)
  - [tools/acceptance/recommendation-preupgrade-fixture.ts](../tools/acceptance/recommendation-preupgrade-fixture.ts)
  - [tools/e2e/golden-harness-self-test.ts](../tools/e2e/golden-harness-self-test.ts)
  - [tools/e2e/golden-harness.ts](../tools/e2e/golden-harness.ts)
  - [tools/e2e/golden-team-application-evidence.ts](../tools/e2e/golden-team-application-evidence.ts)
  - [tools/e2e/golden-team-application.ts](../tools/e2e/golden-team-application.ts)
  - [tools/e2e/legacy-current-assignment-snapshot.ts](../tools/e2e/legacy-current-assignment-snapshot.ts)
  - [tools/e2e/legacy-cutover-references.ts](../tools/e2e/legacy-cutover-references.ts)
  - [tools/e2e/legacy-organization-rehearsal-runtime.ts](../tools/e2e/legacy-organization-rehearsal-runtime.ts)
  - [tools/e2e/legacy-organization-snapshot.ts](../tools/e2e/legacy-organization-snapshot.ts)
  - [tools/e2e/run-legacy-backup-person-rehearsal.ts](../tools/e2e/run-legacy-backup-person-rehearsal.ts)
  - [tools/e2e/run-legacy-current-assignment-rehearsal.ts](../tools/e2e/run-legacy-current-assignment-rehearsal.ts)
  - [tools/e2e/run-legacy-service-cutover.ts](../tools/e2e/run-legacy-service-cutover.ts)
  - [tools/verification/current-assignment-cohort-rehearsal.ts](../tools/verification/current-assignment-cohort-rehearsal.ts)
  - [tools/verification/organization-import-rehearsal-main.ts](../tools/verification/organization-import-rehearsal-main.ts)
  - [tools/verification/organization-import-rehearsal-postgres.ts](../tools/verification/organization-import-rehearsal-postgres.ts)
  - [tools/verification/organization-import-rehearsal.test.ts](../tools/verification/organization-import-rehearsal.test.ts)
  - [tools/verification/organization-import-rehearsal.ts](../tools/verification/organization-import-rehearsal.ts)
  - [tools/verification/receipt-import-rehearsal.ts](../tools/verification/receipt-import-rehearsal.ts)
- `sha256Hex`: The lowercase hexadecimal SHA-256 digest of bytes.
  [packages/domain/src/shared-kernel/canonical-json.ts:76](../packages/domain/src/shared-kernel/canonical-json.ts#L76), 63 consumers:
  - [apps/backend/src/receipt/import-snapshot.ts](../apps/backend/src/receipt/import-snapshot.ts)
  - [packages/database/runtime/authorization-rules-postgres-proof-main.ts](../packages/database/runtime/authorization-rules-postgres-proof-main.ts)
  - [packages/database/runtime/identity-postgres-proof-main.ts](../packages/database/runtime/identity-postgres-proof-main.ts)
  - [packages/database/runtime/invitation-response-postgres-proof-main.ts](../packages/database/runtime/invitation-response-postgres-proof-main.ts)
  - [packages/database/runtime/organization-postgres-proof-main.ts](../packages/database/runtime/organization-postgres-proof-main.ts)
  - [packages/database/runtime/profile-postgres-proof-main.ts](../packages/database/runtime/profile-postgres-proof-main.ts)
  - [packages/database/runtime/receipt-postgres-proof-main.ts](../packages/database/runtime/receipt-postgres-proof-main.ts)
  - [packages/database/runtime/scheduling-postgres-proof-main.ts](../packages/database/runtime/scheduling-postgres-proof-main.ts)
  - [packages/database/runtime/schools-postgres-proof-main.ts](../packages/database/runtime/schools-postgres-proof-main.ts)
  - [packages/database/src/application/returning-postgres.ts](../packages/database/src/application/returning-postgres.ts)
  - [packages/database/src/authz/delegation-postgres.ts](../packages/database/src/authz/delegation-postgres.ts)
  - [packages/database/src/authz/disposable-backfill.ts](../packages/database/src/authz/disposable-backfill.ts)
  - [packages/database/src/content/postgres.ts](../packages/database/src/content/postgres.ts)
  - [packages/database/src/organization/lifecycle-postgres.ts](../packages/database/src/organization/lifecycle-postgres.ts)
  - [packages/database/src/profile/postgres.ts](../packages/database/src/profile/postgres.ts)
  - [packages/database/src/receipt-settlement.test.ts](../packages/database/src/receipt-settlement.test.ts)
  - [packages/database/src/receipt/postgres-proof.ts](../packages/database/src/receipt/postgres-proof.ts)
  - [packages/database/src/receipt/postgres.ts](../packages/database/src/receipt/postgres.ts)
  - [packages/database/src/receipt/settlement.ts](../packages/database/src/receipt/settlement.ts)
  - [packages/database/src/recruitment/completion-outbox.ts](../packages/database/src/recruitment/completion-outbox.ts)
  - [packages/database/src/recruitment/conduct-postgres.ts](../packages/database/src/recruitment/conduct-postgres.ts)
  - [packages/database/src/recruitment/http-postgres.test.ts](../packages/database/src/recruitment/http-postgres.test.ts)
  - [packages/database/src/recruitment/http-postgres.ts](../packages/database/src/recruitment/http-postgres.ts)
  - [packages/database/src/recruitment/invitation-response-postgres.ts](../packages/database/src/recruitment/invitation-response-postgres.ts)
  - [packages/database/src/recruitment/maintenance-postgres.ts](../packages/database/src/recruitment/maintenance-postgres.ts)
  - [packages/database/src/recruitment/outbox.ts](../packages/database/src/recruitment/outbox.ts)
  - [packages/database/src/recruitment/postgres.ts](../packages/database/src/recruitment/postgres.ts)
  - [packages/database/src/recruitment/response-outbox.ts](../packages/database/src/recruitment/response-outbox.ts)
  - [packages/database/src/recruitment/scheduling-postgres.ts](../packages/database/src/recruitment/scheduling-postgres.ts)
  - [packages/database/src/schools/administration.ts](../packages/database/src/schools/administration.ts)
  - [packages/database/src/social-events/postgres.ts](../packages/database/src/social-events/postgres.ts)
  - [packages/database/src/team-application/postgres.ts](../packages/database/src/team-application/postgres.ts)
  - [packages/database/src/test-support/disposable-person-authority-backfill.ts](../packages/database/src/test-support/disposable-person-authority-backfill.ts)
  - [packages/domain/runtime/tutor-d1-proof-main.ts](../packages/domain/runtime/tutor-d1-proof-main.ts)
  - [packages/domain/runtime/tutor-d1.ts](../packages/domain/runtime/tutor-d1.ts)
  - [packages/domain/src/admission-period/digest.ts](../packages/domain/src/admission-period/digest.ts)
  - [packages/domain/src/application/digest.ts](../packages/domain/src/application/digest.ts)
  - [packages/domain/src/organization/administration.ts](../packages/domain/src/organization/administration.ts)
  - [packages/domain/src/organization/import.ts](../packages/domain/src/organization/import.ts)
  - [packages/domain/src/organization/review.ts](../packages/domain/src/organization/review.ts)
  - [packages/domain/src/receipt/auxiliary-service.ts](../packages/domain/src/receipt/auxiliary-service.ts)
  - [packages/domain/src/receipt/file-service.ts](../packages/domain/src/receipt/file-service.ts)
  - [packages/domain/src/receipt/review.ts](../packages/domain/src/receipt/review.ts)
  - [packages/domain/src/tutor/evidence.ts](../packages/domain/src/tutor/evidence.ts)
  - [tools/acceptance/applicant-progress-0107.ts](../tools/acceptance/applicant-progress-0107.ts)
  - [tools/acceptance/recommendation-preupgrade-fixture.ts](../tools/acceptance/recommendation-preupgrade-fixture.ts)
  - [tools/e2e/golden-harness-self-test.ts](../tools/e2e/golden-harness-self-test.ts)
  - [tools/e2e/golden-harness.ts](../tools/e2e/golden-harness.ts)
  - [tools/e2e/golden-team-application-evidence.ts](../tools/e2e/golden-team-application-evidence.ts)
  - [tools/e2e/golden-team-application.ts](../tools/e2e/golden-team-application.ts)
  - [tools/e2e/legacy-current-assignment-snapshot.ts](../tools/e2e/legacy-current-assignment-snapshot.ts)
  - [tools/e2e/legacy-cutover-references.ts](../tools/e2e/legacy-cutover-references.ts)
  - [tools/e2e/legacy-organization-rehearsal-runtime.ts](../tools/e2e/legacy-organization-rehearsal-runtime.ts)
  - [tools/e2e/legacy-organization-snapshot.ts](../tools/e2e/legacy-organization-snapshot.ts)
  - [tools/e2e/run-legacy-backup-person-rehearsal.ts](../tools/e2e/run-legacy-backup-person-rehearsal.ts)
  - [tools/e2e/run-legacy-current-assignment-rehearsal.ts](../tools/e2e/run-legacy-current-assignment-rehearsal.ts)
  - [tools/e2e/run-legacy-service-cutover.ts](../tools/e2e/run-legacy-service-cutover.ts)
  - [tools/verification/current-assignment-cohort-rehearsal.ts](../tools/verification/current-assignment-cohort-rehearsal.ts)
  - [tools/verification/organization-import-rehearsal-main.ts](../tools/verification/organization-import-rehearsal-main.ts)
  - [tools/verification/organization-import-rehearsal-postgres.ts](../tools/verification/organization-import-rehearsal-postgres.ts)
  - [tools/verification/organization-import-rehearsal.test.ts](../tools/verification/organization-import-rehearsal.test.ts)
  - [tools/verification/organization-import-rehearsal.ts](../tools/verification/organization-import-rehearsal.ts)
  - [tools/verification/receipt-import-rehearsal.ts](../tools/verification/receipt-import-rehearsal.ts)

## test-harness

Starts and drives disposable infrastructure for tests, proofs, and journeys: PostgreSQL clusters, loopback ports, and the local backend.

- `ReceiptE2EBarrierArrival`: `false` for unprobed requests; `true` once all three lanes are synchronized.
  [apps/backend/src/receipt/e2e-support.ts:17](../apps/backend/src/receipt/e2e-support.ts#L17), no consumers.
- `selectDatabaseMigration`: Selects the registered migration `id` and the migrations that run before it; an absent id throws and names the nearest registered ids.
  [packages/database/src/migrations.ts:658](../packages/database/src/migrations.ts#L658), 8 consumers:
  - [packages/database/runtime/schema-boundary-postgres-proof-main.ts](../packages/database/runtime/schema-boundary-postgres-proof-main.ts)
  - [packages/database/src/database.test.ts](../packages/database/src/database.test.ts)
  - [packages/database/src/migration-registry.test.ts](../packages/database/src/migration-registry.test.ts)
  - [packages/database/src/migrations.test.ts](../packages/database/src/migrations.test.ts)
  - [packages/database/src/oauth-refresh-window.test.ts](../packages/database/src/oauth-refresh-window.test.ts)
  - [packages/database/src/person-cohort-accepted-mappings.test.ts](../packages/database/src/person-cohort-accepted-mappings.test.ts)
  - [packages/database/src/rule-reconciliation-migration-postgres-proof.ts](../packages/database/src/rule-reconciliation-migration-postgres-proof.ts)
  - [packages/database/src/schema-calendar-arithmetic.test.ts](../packages/database/src/schema-calendar-arithmetic.test.ts)
- `journeyClock`: A journey clock at a reference instant that the caller pins.
  [tools/e2e/journey-clock.ts:32](../tools/e2e/journey-clock.ts#L32), 7 consumers:
  - [apps/dashboard/e2e/dashboard-list-type-boundary.spec.ts](../apps/dashboard/e2e/dashboard-list-type-boundary.spec.ts)
  - [apps/dashboard/e2e/run-real-interview-response.mjs](../apps/dashboard/e2e/run-real-interview-response.mjs)
  - [apps/dashboard/e2e/run-real-native-receipt-settlement.mjs](../apps/dashboard/e2e/run-real-native-receipt-settlement.mjs)
  - [apps/dashboard/e2e/run-real-native-recruitment-interview-scheduling.mjs](../apps/dashboard/e2e/run-real-native-recruitment-interview-scheduling.mjs)
  - [tools/verification/application-worker.test.ts](../tools/verification/application-worker.test.ts)
  - [tools/verification/current-assignment-cohort-rehearsal.ts](../tools/verification/current-assignment-cohort-rehearsal.ts)
  - [tools/verification/organization-import-rehearsal.ts](../tools/verification/organization-import-rehearsal.ts)
- `admissionJourneyClock`: The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the current time.
  [tools/e2e/journey-clock.ts:52](../tools/e2e/journey-clock.ts#L52), 7 consumers:
  - [apps/dashboard/e2e/native-conduct-journey-seed.mjs](../apps/dashboard/e2e/native-conduct-journey-seed.mjs)
  - [apps/dashboard/e2e/native-recruitment-journey-seed.mjs](../apps/dashboard/e2e/native-recruitment-journey-seed.mjs)
  - [apps/dashboard/e2e/real-interview-response.spec.ts](../apps/dashboard/e2e/real-interview-response.spec.ts)
  - [tools/acceptance/applicant-progress-0107.ts](../tools/acceptance/applicant-progress-0107.ts)
  - [tools/acceptance/co-interviewer-correction-0106.ts](../tools/acceptance/co-interviewer-correction-0106.ts)
  - [tools/acceptance/returning-assistant-journey.ts](../tools/acceptance/returning-assistant-journey.ts)
  - [tools/e2e/placement-check.ts](../tools/e2e/placement-check.ts)
- `localBackendEnvironment`: The environment of a disposable local native backend for one composition.
  [tools/e2e/local-backend-environment.ts:25](../tools/e2e/local-backend-environment.ts#L25), 8 consumers:
  - [apps/dashboard/e2e/run-real-admission-period-management.mjs](../apps/dashboard/e2e/run-real-admission-period-management.mjs)
  - [apps/dashboard/e2e/run-real-native-content-publication.mjs](../apps/dashboard/e2e/run-real-native-content-publication.mjs)
  - [apps/dashboard/e2e/run-real-native-identity-browser.mjs](../apps/dashboard/e2e/run-real-native-identity-browser.mjs)
  - [apps/dashboard/e2e/run-real-native-organization-administration.mjs](../apps/dashboard/e2e/run-real-native-organization-administration.mjs)
  - [apps/dashboard/e2e/run-real-native-profile-self-edit.mjs](../apps/dashboard/e2e/run-real-native-profile-self-edit.mjs)
  - [apps/dashboard/e2e/run-real-receipt-owner.mjs](../apps/dashboard/e2e/run-real-receipt-owner.mjs)
  - [apps/homepage/e2e/run-real-public-applicant-admission.mjs](../apps/homepage/e2e/run-real-public-applicant-admission.mjs)
  - [tools/acceptance/substitute-outcome-check.ts](../tools/acceptance/substitute-outcome-check.ts)
- `selectedPostgresMajor`: The major that `VEKTOR_POSTGRES_MAJOR` selects, or the default.
  [tools/postgres/index.ts:94](../tools/postgres/index.ts#L94), no consumers.
- `postgresProgram`: Absolute path of a client program of the selected PostgreSQL major.
  [tools/postgres/index.ts:160](../tools/postgres/index.ts#L160), 19 consumers:
  - [apps/dashboard/e2e/receipt-approval.spec.ts](../apps/dashboard/e2e/receipt-approval.spec.ts)
  - [apps/dashboard/e2e/run-real-admission-period-management.mjs](../apps/dashboard/e2e/run-real-admission-period-management.mjs)
  - [apps/dashboard/e2e/run-real-interview-response.mjs](../apps/dashboard/e2e/run-real-interview-response.mjs)
  - [apps/dashboard/e2e/run-real-native-identity-browser.mjs](../apps/dashboard/e2e/run-real-native-identity-browser.mjs)
  - [apps/dashboard/e2e/run-real-native-organization-administration.mjs](../apps/dashboard/e2e/run-real-native-organization-administration.mjs)
  - [apps/dashboard/e2e/run-real-native-profile-self-edit.mjs](../apps/dashboard/e2e/run-real-native-profile-self-edit.mjs)
  - [apps/dashboard/e2e/run-real-native-recruitment-interview-conduct.mjs](../apps/dashboard/e2e/run-real-native-recruitment-interview-conduct.mjs)
  - [apps/dashboard/e2e/run-real-native-recruitment-interview-scheduling.mjs](../apps/dashboard/e2e/run-real-native-recruitment-interview-scheduling.mjs)
  - [apps/dashboard/e2e/run-real-receipt-approval.mjs](../apps/dashboard/e2e/run-real-receipt-approval.mjs)
  - [apps/dashboard/e2e/run-real-receipt-owner.mjs](../apps/dashboard/e2e/run-real-receipt-owner.mjs)
  - [apps/homepage/e2e/run-real-public-applicant-admission.mjs](../apps/homepage/e2e/run-real-public-applicant-admission.mjs)
  - [packages/database/runtime/historical-service-cohort-rehearsal.ts](../packages/database/runtime/historical-service-cohort-rehearsal.ts)
  - [tools/e2e/run-legacy-backup-person-rehearsal.ts](../tools/e2e/run-legacy-backup-person-rehearsal.ts)
  - [tools/e2e/run-legacy-candidate-rehearsal.ts](../tools/e2e/run-legacy-candidate-rehearsal.ts)
  - [tools/e2e/run-legacy-receipt-rehearsal.ts](../tools/e2e/run-legacy-receipt-rehearsal.ts)
  - [tools/e2e/run-real-native-recruitment-assignment.mjs](../tools/e2e/run-real-native-recruitment-assignment.mjs)
  - [tools/verification/current-assignment-cohort-rehearsal.ts](../tools/verification/current-assignment-cohort-rehearsal.ts)
  - [tools/verification/identity-cohort-rehearsal.ts](../tools/verification/identity-cohort-rehearsal.ts)
  - [tools/verification/receipt-import-rehearsal.ts](../tools/verification/receipt-import-rehearsal.ts)
- `postgresVersion`: The `postgres --version` line of the selected major, such as `postgres (PostgreSQL) 18.6`, for evidence that names the toolchain whether or not a cluster started.
  [tools/postgres/index.ts:168](../tools/postgres/index.ts#L168), 3 consumers:
  - [tools/e2e/golden-harness.ts](../tools/e2e/golden-harness.ts)
  - [tools/e2e/golden-reimbursement.mjs](../tools/e2e/golden-reimbursement.mjs)
  - [tools/e2e/placement-check.ts](../tools/e2e/placement-check.ts)
- `loopbackPortFree`: Whether a listener can bind `port` on loopback now.
  [tools/postgres/index.ts:211](../tools/postgres/index.ts#L211), 7 consumers:
  - [tools/acceptance/onboarding-check.ts](../tools/acceptance/onboarding-check.ts)
  - [tools/acceptance/password-recovery-check.ts](../tools/acceptance/password-recovery-check.ts)
  - [tools/acceptance/recommendation-check.ts](../tools/acceptance/recommendation-check.ts)
  - [tools/e2e/golden-harness.ts](../tools/e2e/golden-harness.ts)
  - [tools/e2e/golden-reimbursement.mjs](../tools/e2e/golden-reimbursement.mjs)
  - [tools/e2e/placement-check.ts](../tools/e2e/placement-check.ts)
  - [tools/verification/unattended-delivery-recovery.ts](../tools/verification/unattended-delivery-recovery.ts)
- `reserveLoopbackPorts`: Reserves `count` distinct loopback ports for the servers that a journey starts: its backend, dashboard, receivers, and clusters.
  [tools/postgres/index.ts:243](../tools/postgres/index.ts#L243), 22 consumers:
  - [apps/dashboard/e2e/run-real-admission-period-management.mjs](../apps/dashboard/e2e/run-real-admission-period-management.mjs)
  - [apps/dashboard/e2e/run-real-interview-response.mjs](../apps/dashboard/e2e/run-real-interview-response.mjs)
  - [apps/dashboard/e2e/run-real-native-content-publication.mjs](../apps/dashboard/e2e/run-real-native-content-publication.mjs)
  - [apps/dashboard/e2e/run-real-native-identity-browser.mjs](../apps/dashboard/e2e/run-real-native-identity-browser.mjs)
  - [apps/dashboard/e2e/run-real-native-organization-administration.mjs](../apps/dashboard/e2e/run-real-native-organization-administration.mjs)
  - [apps/dashboard/e2e/run-real-native-recruitment-interview-scheduling.mjs](../apps/dashboard/e2e/run-real-native-recruitment-interview-scheduling.mjs)
  - [apps/dashboard/e2e/run-real-receipt-approval.mjs](../apps/dashboard/e2e/run-real-receipt-approval.mjs)
  - [apps/dashboard/e2e/run-real-receipt-owner.mjs](../apps/dashboard/e2e/run-real-receipt-owner.mjs)
  - [apps/homepage/e2e/run-native-contact.mjs](../apps/homepage/e2e/run-native-contact.mjs)
  - [apps/homepage/e2e/run-real-public-applicant-admission.mjs](../apps/homepage/e2e/run-real-public-applicant-admission.mjs)
  - [tools/acceptance/onboarding-check.ts](../tools/acceptance/onboarding-check.ts)
  - [tools/acceptance/password-recovery-check.ts](../tools/acceptance/password-recovery-check.ts)
  - [tools/acceptance/recommendation-check.ts](../tools/acceptance/recommendation-check.ts)
  - [tools/acceptance/substitute-outcome-check.ts](../tools/acceptance/substitute-outcome-check.ts)
  - [tools/e2e/golden-harness.ts](../tools/e2e/golden-harness.ts)
  - [tools/e2e/golden-reimbursement.mjs](../tools/e2e/golden-reimbursement.mjs)
  - [tools/e2e/placement-check.ts](../tools/e2e/placement-check.ts)
  - [tools/e2e/run-real-native-recruitment-assignment.mjs](../tools/e2e/run-real-native-recruitment-assignment.mjs)
  - [tools/verification/identity-cohort-rehearsal.ts](../tools/verification/identity-cohort-rehearsal.ts)
  - [tools/verification/organization-import-rehearsal-main.ts](../tools/verification/organization-import-rehearsal-main.ts)
  - [tools/verification/receipt-import-rehearsal.ts](../tools/verification/receipt-import-rehearsal.ts)
  - [tools/verification/unattended-delivery-recovery.ts](../tools/verification/unattended-delivery-recovery.ts)
- `startDisposablePostgres`: Starts a fresh cluster of the selected major on a private port and socket directory with trust authentication.
  [tools/postgres/index.ts:436](../tools/postgres/index.ts#L436), 34 consumers:
  - [apps/backend/test/postgres.ts](../apps/backend/test/postgres.ts)
  - [apps/dashboard/e2e/run-real-admission-period-management.mjs](../apps/dashboard/e2e/run-real-admission-period-management.mjs)
  - [apps/dashboard/e2e/run-real-interview-response.mjs](../apps/dashboard/e2e/run-real-interview-response.mjs)
  - [apps/dashboard/e2e/run-real-native-content-publication.mjs](../apps/dashboard/e2e/run-real-native-content-publication.mjs)
  - [apps/dashboard/e2e/run-real-native-identity-browser.mjs](../apps/dashboard/e2e/run-real-native-identity-browser.mjs)
  - [apps/dashboard/e2e/run-real-native-organization-administration.mjs](../apps/dashboard/e2e/run-real-native-organization-administration.mjs)
  - [apps/dashboard/e2e/run-real-native-profile-self-edit.mjs](../apps/dashboard/e2e/run-real-native-profile-self-edit.mjs)
  - [apps/dashboard/e2e/run-real-native-receipt-settlement.mjs](../apps/dashboard/e2e/run-real-native-receipt-settlement.mjs)
  - [apps/dashboard/e2e/run-real-native-recruitment-interview-conduct.mjs](../apps/dashboard/e2e/run-real-native-recruitment-interview-conduct.mjs)
  - [apps/dashboard/e2e/run-real-native-recruitment-interview-scheduling.mjs](../apps/dashboard/e2e/run-real-native-recruitment-interview-scheduling.mjs)
  - [apps/dashboard/e2e/run-real-native-schools-directory.mjs](../apps/dashboard/e2e/run-real-native-schools-directory.mjs)
  - [apps/dashboard/e2e/run-real-native-social-events.mjs](../apps/dashboard/e2e/run-real-native-social-events.mjs)
  - [apps/dashboard/e2e/run-real-receipt-approval.mjs](../apps/dashboard/e2e/run-real-receipt-approval.mjs)
  - [apps/dashboard/e2e/run-real-receipt-owner.mjs](../apps/dashboard/e2e/run-real-receipt-owner.mjs)
  - [apps/homepage/e2e/run-native-contact.mjs](../apps/homepage/e2e/run-native-contact.mjs)
  - [apps/homepage/e2e/run-real-public-applicant-admission.mjs](../apps/homepage/e2e/run-real-public-applicant-admission.mjs)
  - [packages/database/runtime/historical-service-cohort-rehearsal.ts](../packages/database/runtime/historical-service-cohort-rehearsal.ts)
  - [packages/database/runtime/person-cohort-rehearsal.ts](../packages/database/runtime/person-cohort-rehearsal.ts)
  - [packages/database/src/oauth-refresh-window.test.ts](../packages/database/src/oauth-refresh-window.test.ts)
  - [tools/acceptance/onboarding-check.ts](../tools/acceptance/onboarding-check.ts)
  - [tools/acceptance/password-recovery-check.ts](../tools/acceptance/password-recovery-check.ts)
  - [tools/acceptance/recommendation-check.ts](../tools/acceptance/recommendation-check.ts)
  - [tools/acceptance/substitute-outcome-check.ts](../tools/acceptance/substitute-outcome-check.ts)
  - [tools/e2e/golden-harness.ts](../tools/e2e/golden-harness.ts)
  - [tools/e2e/golden-reimbursement.mjs](../tools/e2e/golden-reimbursement.mjs)
  - [tools/e2e/legacy-organization-rehearsal-runtime.ts](../tools/e2e/legacy-organization-rehearsal-runtime.ts)
  - [tools/e2e/placement-check.ts](../tools/e2e/placement-check.ts)
  - [tools/e2e/run-legacy-backup-person-rehearsal.ts](../tools/e2e/run-legacy-backup-person-rehearsal.ts)
  - [tools/e2e/run-legacy-current-assignment-rehearsal.ts](../tools/e2e/run-legacy-current-assignment-rehearsal.ts)
  - [tools/e2e/run-real-native-recruitment-assignment.mjs](../tools/e2e/run-real-native-recruitment-assignment.mjs)
  - [tools/verification/current-assignment-cohort-rehearsal.ts](../tools/verification/current-assignment-cohort-rehearsal.ts)
  - [tools/verification/identity-cohort-rehearsal.ts](../tools/verification/identity-cohort-rehearsal.ts)
  - [tools/verification/receipt-import-rehearsal.ts](../tools/verification/receipt-import-rehearsal.ts)
  - [tools/verification/unattended-delivery-recovery.ts](../tools/verification/unattended-delivery-recovery.ts)
- `withDisposablePostgres`: Runs `use` against the database `database` of a fresh cluster, which `startDisposablePostgres` starts, and removes the cluster when `use` settles, also when it fails.
  [tools/postgres/index.ts:648](../tools/postgres/index.ts#L648), 3 consumers:
  - [packages/database/runtime/authorization-rules-postgres-proof-main.ts](../packages/database/runtime/authorization-rules-postgres-proof-main.ts)
  - [packages/database/runtime/rule-reconciliation-postgres-tracer-main.ts](../packages/database/runtime/rule-reconciliation-postgres-tracer-main.ts)
  - [tools/verification/organization-import-rehearsal-main.ts](../tools/verification/organization-import-rehearsal-main.ts)

## request-ledger

Classifies the requests that journey recorders observe by whole path segments: native contract operations and legacy routes.

- `isNativeRequest`: Whether a dashboard-to-backend request stays on the native surface: an operation of the native HTTP contract or an email-password route of the identity engine.
  [apps/dashboard/e2e/native-operations.ts:73](../apps/dashboard/e2e/native-operations.ts#L73), 3 consumers:
  - [apps/dashboard/e2e/run-real-native-identity-browser.mjs](../apps/dashboard/e2e/run-real-native-identity-browser.mjs)
  - [apps/dashboard/e2e/run-real-native-receipt-settlement.mjs](../apps/dashboard/e2e/run-real-native-receipt-settlement.mjs)
  - [apps/dashboard/test/request-routes.test.ts](../apps/dashboard/test/request-routes.test.ts)
- `addressesAnyRoute`: Whether a request path addresses any of the routes, each matched by whole path segments.
  [apps/dashboard/e2e/request-routes.ts:36](../apps/dashboard/e2e/request-routes.ts#L36), 12 consumers:
  - [apps/dashboard/e2e/native-content-publication.spec.ts](../apps/dashboard/e2e/native-content-publication.spec.ts)
  - [apps/dashboard/e2e/native-identity-browser.spec.ts](../apps/dashboard/e2e/native-identity-browser.spec.ts)
  - [apps/dashboard/e2e/native-profile-self-edit.spec.ts](../apps/dashboard/e2e/native-profile-self-edit.spec.ts)
  - [apps/dashboard/e2e/native-schools-directory.spec.ts](../apps/dashboard/e2e/native-schools-directory.spec.ts)
  - [apps/dashboard/e2e/organization-import-rehearsal.spec.ts](../apps/dashboard/e2e/organization-import-rehearsal.spec.ts)
  - [apps/dashboard/e2e/real-interview-response.spec.ts](../apps/dashboard/e2e/real-interview-response.spec.ts)
  - [apps/dashboard/e2e/receipt-approval.spec.ts](../apps/dashboard/e2e/receipt-approval.spec.ts)
  - [apps/dashboard/e2e/run-real-native-content-publication.mjs](../apps/dashboard/e2e/run-real-native-content-publication.mjs)
  - [apps/dashboard/e2e/run-real-native-profile-self-edit.mjs](../apps/dashboard/e2e/run-real-native-profile-self-edit.mjs)
  - [apps/dashboard/e2e/run-real-native-schools-directory.mjs](../apps/dashboard/e2e/run-real-native-schools-directory.mjs)
  - [apps/dashboard/e2e/run-real-receipt-approval.mjs](../apps/dashboard/e2e/run-real-receipt-approval.mjs)
  - [tools/verification/organization-import-rehearsal-main.ts](../tools/verification/organization-import-rehearsal-main.ts)
