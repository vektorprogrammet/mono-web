# Shared constructs

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

A shared construct is an export that owns logic that several call sites share. Use it instead of writing the logic again.
Read about a construct in three steps, each only when you need it:

1. This index: each category and each construct in one line.
2. Its contract, on the page of its category: signature, errors, requirements, side effects, how it works, one use, and the misuse to avoid.
3. Its consumers: `just constructs consumers <name>` prints the modules that import it. No page lists them, so an import changes no page.

The JSDoc of a construct carries `@construct <category>`, a summary sentence, `@remarks`, `@sideEffects`, `@example`, and `@avoid`, and its parameters and return type carry annotations.
Tag a construct only when at least 2 modules outside its own module and the tests of its app or package import it.
`just constructs` checks these pages against the tags, and it lists untagged functions that 3 or more modules outside their app or package import.

- [http-transport](constructs/http-transport.md): Reads native HTTP requests and writes their representations: bounded JSON, preconditions, idempotency keys, entity tags, and cache headers.
  - [`jsonResponse`](constructs/http-transport.md#jsonresponse): One JSON representation that no cache stores.
  - [`conditionalCollection`](constructs/http-transport.md#conditionalcollection): Answers a conditional read of one admission collection, tagged by the versions of its items.
  - [`readBoundedJson`](constructs/http-transport.md#readboundedjson): Bound bytes while reading, including requests without Content-Length.
  - [`jcsBytes`](constructs/http-transport.md#jcsbytes): Encodes one I-JSON value with the repository RFC 8785 encoder.
  - [`parseJsonWithoutDuplicateMembers`](constructs/http-transport.md#parsejsonwithoutduplicatemembers): Decodes UTF-8 JSON while rejecting duplicate member names before schema decoding.
  - [`interpretMergePatchSource`](constructs/http-transport.md#interpretmergepatchsource): Preserves absence, value, and explicit deletion before typed merge-patch decoding.
  - [`parseIdempotencyKey`](constructs/http-transport.md#parseidempotencykey): Decodes one non-combinable Idempotency-Key field.
  - [`parseRequiredIfMatch`](constructs/http-transport.md#parserequiredifmatch): Decodes the required single strong If-Match value for an item mutation.
  - [`parseReadIfMatch`](constructs/http-transport.md#parsereadifmatch): Canonicalizes an optional read If-Match wildcard or entity-tag list.
  - [`parseIfNoneMatch`](constructs/http-transport.md#parseifnonematch): Canonicalizes an optional If-None-Match wildcard or entity-tag list.
  - [`encodePathIdentity`](constructs/http-transport.md#encodepathidentity): Encodes one decoded identity as an uppercase RFC 3986 path segment.
  - [`normalizeTarget`](constructs/http-transport.md#normalizetarget): Fills a route template with its encoded identities; a missing identity is a malformed request.
  - [`deriveHttpIdentity`](constructs/http-transport.md#derivehttpidentity): Derives the private storage digest and domain command ID from the identity tuple.
  - [`jsonResponse`](constructs/http-transport.md#jsonresponse-1): A JSON body under the receipt cache policy the caller names.
  - [`privateJsonResponse`](constructs/http-transport.md#privatejsonresponse): A JSON body private to the caller, varying by Origin.
  - [`receiptMutationCapsule`](constructs/http-transport.md#receiptmutationcapsule): The replayable response of one receipt mutation.
  - [`readPrivateReceiptFile`](constructs/http-transport.md#readprivatereceiptfile): Answers verified private bytes with their exact headers; unreadable bytes are the receipt store failing.
- [http-problem](constructs/http-problem.md): Answers a native HTTP request with a declared problem: failure mapping, credential classification, authorization, and decoding.
  - [`authorizeAdmissionPerson`](constructs/http-problem.md#authorizeadmissionperson): Evaluates one admission person AccessSpec.
  - [`returningAuthorization`](constructs/http-problem.md#returningauthorization): Resolves the current person and authorizes one returning-assistant operation on that person's own profile.
  - [`admissionActorForAuthority`](constructs/http-problem.md#admissionactorforauthority): The admission actor of one department scope.
  - [`decodeJson`](constructs/http-problem.md#decodejson): Reads and decodes one bounded JSON body.
  - [`decodeAdmissionPeriodPatch`](constructs/http-problem.md#decodeadmissionperiodpatch): Reads and decodes one bounded admission period merge patch.
  - [`admissionProblems`](constructs/http-problem.md#admissionproblems): The one answer for every admission failure.
  - [`submissionProblems`](constructs/http-problem.md#submissionproblems): Problems only a public application submission answers.
  - [`periodCommandProblems`](constructs/http-problem.md#periodcommandproblems): Problems only an admission period command answers.
  - [`authorizeContentOperation`](constructs/http-problem.md#authorizecontentoperation): Evaluates a content endpoint's AccessSpec for one person with the content grant scope.
  - [`authorizedActor`](constructs/http-problem.md#authorizedactor): Resolves the staff person of a snapshot read and its content actor at the person's authorization instant.
  - [`authorizedActorInTransaction`](constructs/http-problem.md#authorizedactorintransaction): Resolves the staff person of a command, its credential, and its content actor inside the command's transaction.
  - [`departmentQuery`](constructs/http-problem.md#departmentquery): A workspace or news listing accepts at most one department filter and no other parameter.
  - [`versionFromQuery`](constructs/http-problem.md#versionfromquery): A news article read accepts at most one positive published version and no other parameter.
  - [`contentProblems`](constructs/http-problem.md#contentproblems): The one answer for every content domain failure.
  - [`contentActorProblems`](constructs/http-problem.md#contentactorproblems): A staff person rejected after ingress is answered from the credential the request presented.
  - [`problemWebResponse`](constructs/http-problem.md#problemwebresponse): Renders one problem outside HttpApi encoding, with the encoder's body and headers.
  - [`jsonText`](constructs/http-problem.md#jsontext): The JSON text of a representation, byte for byte what `JSON.stringify` writes.
  - [`classifyCredential`](constructs/http-problem.md#classifycredential): Records, from the raw request only, whether person credential material was presented.
  - [`webHandler`](constructs/http-problem.md#webhandler): Runs one Effect-native Web transport operation.
  - [`semanticProblem`](constructs/http-problem.md#semanticproblem): Runs a throwing semantic parser.
  - [`problemMapper`](constructs/http-problem.md#problemmapper): Builds the one failure-to-problem mapper of a domain.
  - [`headerValues`](constructs/http-problem.md#headervalues): The values of one request header; an absent header has none.
  - [`requireNoQuery`](constructs/http-problem.md#requirenoquery): An operation that accepts no query answers any query as malformed.
  - [`readJsonBody`](constructs/http-problem.md#readjsonbody): Reads a bounded JSON body of the one media type `mediaType` accepts.
  - [`idempotencyKeyOf`](constructs/http-problem.md#idempotencykeyof): Decodes the one Idempotency-Key a replayable mutation requires.
  - [`requiredIfMatchOf`](constructs/http-problem.md#requiredifmatchof): Decodes the one strong If-Match an item mutation requires.
  - [`httpIdentity`](constructs/http-problem.md#httpidentity): Derives a command's idempotency identity; a tuple outside the frozen grammar is a request problem.
  - [`requireCurrentETag`](constructs/http-problem.md#requirecurrentetag): Fails a mutation whose If-Match no longer names the current representation.
  - [`conditionalJson`](constructs/http-problem.md#conditionaljson): Answers a conditional JSON read after authority and concealment: the representation, a bodyless 304, or precondition.failed.
  - [`personPresentation`](constructs/http-problem.md#personpresentation): The person credential a request presented, for a rejection answered after ingress.
  - [`isSerializationConflict`](constructs/http-problem.md#isserializationconflict): Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.
  - [`requestInvalid`](constructs/http-problem.md#requestinvalid): The request as a whole fails validation; no single member is singled out.
  - [`decodeRequest`](constructs/http-problem.md#decoderequest): Decodes one JSON request value strictly; any mismatch fails the whole request's validation.
  - [`strictOutput`](constructs/http-problem.md#strictoutput): Decodes one response value strictly.
  - [`commandReceiptProblems`](constructs/http-problem.md#commandreceiptproblems): HTTP command receipts: the transport's own persistence failures.
  - [`commandOutcomeResponse`](constructs/http-problem.md#commandoutcomeresponse): Answers a command receipt outcome: committed and replayed results, or an idempotency problem.
  - [`authorizeAnonymous`](constructs/http-problem.md#authorizeanonymous): An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and its scope resolution disagree: a defect.
  - [`authorizePerson`](constructs/http-problem.md#authorizeperson): A rejected person credential is answered from the ingress evidence, never by string choice.
  - [`unreachable`](constructs/http-problem.md#unreachable): Marks problems a shared mapper can produce but this operation cannot, such as a serialization conflict inside a read-only snapshot.
  - [`ProblemBoundaryLive`](constructs/http-problem.md#problemboundarylive): The only Cause consumer.
  - [`NativeAccessRejected`](constructs/http-problem.md#nativeaccessrejected): An AccessSpec evaluation that did not grant the operation.
  - [`receiptProblems`](constructs/http-problem.md#receiptproblems): The one answer for every receipt failure other than a rejected credential, including an unavailable store, Identity, or E2E barrier.
  - [`storedReceiptProblems`](constructs/http-problem.md#storedreceiptproblems): A stored receipt value a read cannot decode is the receipt store failing, not the request.
  - [`receiptCredentialProblems`](constructs/http-problem.md#receiptcredentialproblems): A credential rejected inside a receipt handler is answered from the request's own evidence.
  - [`projected`](constructs/http-problem.md#projected): Projects stored rows onto response items.
  - [`authorizeInvitationOperation`](constructs/http-problem.md#authorizeinvitationoperation): Authorizes the holder of an invitation's response capability.
  - [`interviewAuthorizationInTransaction`](constructs/http-problem.md#interviewauthorizationintransaction): Resolves the current person and authorizes one interview inside the caller's transaction; a rejected credential is answered from the request's evidence.
  - [`readRecruitmentBody`](constructs/http-problem.md#readrecruitmentbody): Every recruitment request body is one bounded `application/json` document.
  - [`recruitmentProblems`](constructs/http-problem.md#recruitmentproblems): The one answer for every recruitment failure.
  - [`raceProblems`](constructs/http-problem.md#raceproblems): A failure that lost a serialization or deadlock race answers transaction.conflict, whatever failure carried it.
  - [`maintenanceProblems`](constructs/http-problem.md#maintenanceproblems): The maintenance API answers its own failures, an unknown interview, and an identity outage in its own vocabulary; everything else as recruitment does.
  - [`schoolsProblems`](constructs/http-problem.md#schoolsproblems): The one answer for every Schools failure.
  - [`schoolsCredentialProblems`](constructs/http-problem.md#schoolscredentialproblems): A person credential rejected after ingress is answered from the request's own evidence; an unavailable identity provider leaves Schools unavailable.
  - [`problemUnion`](constructs/http-problem.md#problemunion): Creates a closed endpoint-specific Problem Details union.
  - [`Problem`](constructs/http-problem.md#problem): One RFC 9457 failure in an Effect error channel.
  - [`isProblem`](constructs/http-problem.md#isproblem): Narrows a caught value to a `Problem`, also one that another copy of this module created.
  - [`problemBody`](constructs/http-problem.md#problembody): The frozen RFC 9457 body: the registry entry, then code, instance, and validation.
  - [`problemHeaders`](constructs/http-problem.md#problemheaders): The response headers of one problem: `no-store`, its challenge, and its retry delay.
  - [`makeNativeProblem`](constructs/http-problem.md#makenativeproblem): Builds one safe fixed public problem value.
- [sql-lock](constructs/sql-lock.md): Transaction-scoped PostgreSQL advisory locks under registered keys.
  - [`AdvisoryLockKey`](constructs/sql-lock.md#advisorylockkey): The registered advisory-lock keys, one constructor per namespace.
  - [`lockAdvisory`](constructs/sql-lock.md#lockadvisory): Waits for the advisory lock on `key` until the current transaction ends.
  - [`tryLockAdvisory`](constructs/sql-lock.md#trylockadvisory): Takes the exclusive advisory lock on `key` until the current transaction ends when no other transaction holds it.
  - [`lockOrganizationAdministratorSet`](constructs/sql-lock.md#lockorganizationadministratorset): Acquire before any person lock when changing the usable administrator set.
  - [`lockPersonAuthorization`](constructs/sql-lock.md#lockpersonauthorization): Serializes one person's protected command with person-keyed authority writers.
- [sql-lifecycle](constructs/sql-lifecycle.md): Claim-fenced row lifecycles in PostgreSQL, such as outbox claims and account access.
  - [`accountAccessEnabled`](constructs/sql-lifecycle.md#accountaccessenabled): Whether the native account of `personId` exists and is not disabled.
  - [`outboxClaimAssignments`](constructs/sql-lifecycle.md#outboxclaimassignments): SET list for the aggregate's claim UPDATE; `targetAlias` names the updated outbox row.
  - [`markOutboxDelivered`](constructs/sql-lifecycle.md#markoutboxdelivered): Settles the claimed row as Delivered, with delivery evidence when the table records it.
  - [`markOutboxFailed`](constructs/sql-lifecycle.md#markoutboxfailed): Settles the claimed row as Failed with its failure tag, so a later claim retries it.
  - [`quarantineOutboxClaim`](constructs/sql-lifecycle.md#quarantineoutboxclaim): Settles the claimed row as Quarantined, a terminal status, with its failure tag.
  - [`releaseOutboxClaim`](constructs/sql-lifecycle.md#releaseoutboxclaim): Returns an interrupted claim to Pending without a provider outcome; a lost claim needs none.
  - [`recoverStaleOutboxClaims`](constructs/sql-lifecycle.md#recoverstaleoutboxclaims): Recovers every Processing row claimed before `claimedBefore`.
  - [`recoverStaleOutboxClaim`](constructs/sql-lifecycle.md#recoverstaleoutboxclaim): Recovers the rows of one claim when that claim was taken before `claimedBefore`.
- [delivery](constructs/delivery.md): Delivers committed effects to providers after the transaction.
  - [`deliverJson`](constructs/delivery.md#deliverjson): Shared acknowledged JSON transport; deliberately no retry on ambiguous acceptance.
- [worker](constructs/worker.md): Runs background workers on the Effect clock.
  - [`pollForever`](constructs/worker.md#pollforever): Runs `tick` at once, then again after each success.
- [pagination](constructs/pagination.md): Keyset cursors and pages over ordered PostgreSQL reads.
  - [`CursorPositioned`](constructs/pagination.md#cursorpositioned): A row with the ordering text that `receiptCursorTimestamp` selects.
  - [`receiptCursorTimestamp`](constructs/pagination.md#receiptcursortimestamp): Selects the ordering column as microsecond UTC text so cursor positions compare exactly.
  - [`withoutCursorTimestamp`](constructs/pagination.md#withoutcursortimestamp): Drops the ordering text from a row before the row leaves the adapter.
  - [`receiptCursorPage`](constructs/pagination.md#receiptcursorpage): Keeps one page of the rows, encodes the next cursor when a further row was read, and drops the ordering text.
- [digest](constructs/digest.md): Canonical JSON and SHA-256 digests that evidence and idempotency identities hash.
  - [`canonicalJsonValue`](constructs/digest.md#canonicaljsonvalue): The plain JSON value of a datum, with sorted object keys and non-finite numbers as `null`.
  - [`canonicalJson`](constructs/digest.md#canonicaljson): The canonical JSON text of a datum, to hash or compare; a SQL `json` parameter takes `canonicalJsonValue` instead.
  - [`canonicalJsonBytes`](constructs/digest.md#canonicaljsonbytes): The UTF-8 bytes of the canonical JSON text of a datum.
  - [`sha256Hex`](constructs/digest.md#sha256hex): The lowercase hexadecimal SHA-256 digest of bytes.
- [test-harness](constructs/test-harness.md): Starts and drives disposable infrastructure for tests, proofs, and journeys: PostgreSQL clusters, loopback ports, and the local backend.
  - [`ReceiptE2EBarrierArrival`](constructs/test-harness.md#receipte2ebarrierarrival): `false` for unprobed requests; `true` once all three lanes are synchronized.
  - [`selectDatabaseMigration`](constructs/test-harness.md#selectdatabasemigration): Selects the registered migration `id` and the migrations that run before it; an absent id throws and names the nearest registered ids.
  - [`journeyClock`](constructs/test-harness.md#journeyclock): A journey clock at a reference instant that the caller pins.
  - [`admissionJourneyClock`](constructs/test-harness.md#admissionjourneyclock): The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the current time.
  - [`localBackendEnvironment`](constructs/test-harness.md#localbackendenvironment): The environment of a disposable local native backend for one composition.
  - [`selectedPostgresMajor`](constructs/test-harness.md#selectedpostgresmajor): The major that `VEKTOR_POSTGRES_MAJOR` selects, or the default.
  - [`postgresProgram`](constructs/test-harness.md#postgresprogram): Absolute path of a client program of the selected PostgreSQL major.
  - [`postgresVersion`](constructs/test-harness.md#postgresversion): The `postgres --version` line of the selected major, such as `postgres (PostgreSQL) 18.6`, for evidence that names the toolchain whether or not a cluster started.
  - [`loopbackPortFree`](constructs/test-harness.md#loopbackportfree): Whether a listener can bind `port` on loopback now.
  - [`reserveLoopbackPorts`](constructs/test-harness.md#reserveloopbackports): Reserves `count` distinct loopback ports for the servers that a journey starts: its backend, dashboard, receivers, and clusters.
  - [`startDisposablePostgres`](constructs/test-harness.md#startdisposablepostgres): Starts a fresh cluster of the selected major on a private port and socket directory with trust authentication.
  - [`withDisposablePostgres`](constructs/test-harness.md#withdisposablepostgres): Runs `use` against the database `database` of a fresh cluster, which `startDisposablePostgres` starts, and removes the cluster when `use` settles, also when it fails.
  - [`startDisposablePgBouncer`](constructs/test-harness.md#startdisposablepgbouncer): Starts PgBouncer on a private loopback port in front of `upstream`, with trust authentication and every database of the cluster, in transaction pool mode unless `options` names another.
- [request-ledger](constructs/request-ledger.md): Classifies the requests that journey recorders observe by whole path segments: native contract operations and legacy routes.
  - [`isNativeRequest`](constructs/request-ledger.md#isnativerequest): Whether a dashboard-to-backend request stays on the native surface: an operation of the native HTTP contract or an email-password route of the identity engine.
  - [`addressesAnyRoute`](constructs/request-ledger.md#addressesanyroute): Whether a request path addresses any of the routes, each matched by whole path segments.
