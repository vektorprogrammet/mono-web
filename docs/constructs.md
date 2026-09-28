# Shared constructs

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

A shared construct is an export that owns logic that several call sites share. Use it instead of writing the logic again.
Read about a construct in three steps, each only when you need it:

1. This index: each category and each construct in one line.
2. Its contract, on the page of its category: signature, errors, requirements, side effects, how it works, one use, and the misuse to avoid.
3. Its consumers: `just constructs consumers <name>` prints the modules that import it. No page lists them, so an import changes no page.

The JSDoc of a construct carries `@construct <category>`, a summary sentence, `@remarks`, `@sideEffects`, `@example`, and `@avoid`, and its parameters and return type carry annotations.
Tag a construct only when at least 2 modules outside its own module and the tests of its app or package import it.
`just constructs` fails when these pages differ from the tags, when a construct lacks one of these tags or annotations, and when fewer modules import it. It lists untagged functions that 3 or more modules outside their app or package import.

- [http-transport](constructs/http-transport.md): Derives the transport facts that commands keep across the cutover from HTTP: command identities, request digests, preconditions, and entity tags.
  - [`encodePathIdentity`](constructs/http-transport.md#encodepathidentity): Encodes one decoded identity as an uppercase RFC 3986 path segment.
  - [`normalizeTarget`](constructs/http-transport.md#normalizetarget): Fills a route template with its encoded identities; a missing identity is a malformed request.
  - [`deriveHttpIdentity`](constructs/http-transport.md#derivehttpidentity): Derives the private storage digest and domain command ID from the identity tuple.
- [authority-evidence](constructs/authority-evidence.md): Checks a resolved authority and returns the evidence that a command which needs that authority takes; nothing else constructs it.
  - [`requireDepartmentReach`](constructs/authority-evidence.md#requiredepartmentreach): Checks that a resolved authority reaches one department with a capability, and returns the evidence that a department-scoped command requires.
  - [`requireOrganizationAdministrator`](constructs/authority-evidence.md#requireorganizationadministrator): Checks that a resolved authority holds active global administration, and returns the evidence that the Organization administration commands require.
  - [`requireTeamInterestScope`](constructs/authority-evidence.md#requireteaminterestscope): Checks what team interest a resolved authority may read, narrowed to one requested department, and returns the scope that the listing requires.
- [rpc-transport](constructs/rpc-transport.md): Addresses the native RPC endpoints over HTTP, as the ingress serves them and every recorder matches them.
  - [`isNativeRpcPath`](constructs/rpc-transport.md#isnativerpcpath): Whether a request path addresses the native RPC endpoint.
- [rpc-problem](constructs/rpc-problem.md): Answers a native RPC with a declared problem: failure mapping, credential classification, authorization, command outcomes, and the defect boundary.
  - [`authorizeAdmissionPerson`](constructs/rpc-problem.md#authorizeadmissionperson): Evaluates one admission person AccessSpec.
  - [`returningAuthorization`](constructs/rpc-problem.md#returningauthorization): Resolves the current person and authorizes one returning-assistant operation on that person's own profile.
  - [`admissionActorForAuthority`](constructs/rpc-problem.md#admissionactorforauthority): The admission actor of one department scope.
  - [`admissionProblems`](constructs/rpc-problem.md#admissionproblems): The one answer for every admission failure.
  - [`authorizeContentOperation`](constructs/rpc-problem.md#authorizecontentoperation): Evaluates a content RPC's AccessSpec for one person with the content grant scope.
  - [`contentProblems`](constructs/rpc-problem.md#contentproblems): The one answer for every content domain failure.
  - [`contentActorProblems`](constructs/rpc-problem.md#contentactorproblems): A staff person rejected after the credential middleware is answered from the credential the request presented.
  - [`receiptProblems`](constructs/rpc-problem.md#receiptproblems): The one answer for every receipt failure other than a rejected credential, including an unavailable store, Identity, or E2E barrier.
  - [`receiptCredentialProblems`](constructs/rpc-problem.md#receiptcredentialproblems): A credential rejected inside a receipt handler is answered from the request's own evidence.
  - [`authorizeInvitationOperation`](constructs/rpc-problem.md#authorizeinvitationoperation): Authorizes the holder of an invitation's response capability.
  - [`interviewAuthorizationInTransaction`](constructs/rpc-problem.md#interviewauthorizationintransaction): Resolves the current person and authorizes one interview inside the caller's transaction; a rejected credential is answered from the request's evidence.
  - [`recruitmentProblems`](constructs/rpc-problem.md#recruitmentproblems): The one answer for every recruitment failure.
  - [`raceProblems`](constructs/rpc-problem.md#raceproblems): A failure that lost a serialization or deadlock race answers transaction.conflict, whatever failure carried it.
  - [`jsonText`](constructs/rpc-problem.md#jsontext): The JSON text of a representation, byte for byte what `JSON.stringify` writes.
  - [`problemMapper`](constructs/rpc-problem.md#problemmapper): Builds the one failure-to-problem mapper of a domain.
  - [`commandIdentity`](constructs/rpc-problem.md#commandidentity): Derives a command's idempotency identity: the receipt digest and the domain command ID.
  - [`requireCurrentETag`](constructs/rpc-problem.md#requirecurrentetag): Fails a mutation whose If-Match no longer names the current representation.
  - [`isSerializationConflict`](constructs/rpc-problem.md#isserializationconflict): Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.
  - [`requestInvalid`](constructs/rpc-problem.md#requestinvalid): The request as a whole fails validation; no single member is singled out.
  - [`strictOutput`](constructs/rpc-problem.md#strictoutput): Decodes one response value strictly.
  - [`commandReceiptProblems`](constructs/rpc-problem.md#commandreceiptproblems): Command receipts: the transport's own persistence failures.
  - [`personPresentation`](constructs/rpc-problem.md#personpresentation): The credential evidence of an RPC request: which credential headers it presented.
  - [`commandOutcome`](constructs/rpc-problem.md#commandoutcome): The value of a command receipt outcome: the committed or replayed success, or an idempotency problem.
  - [`authorizeAnonymous`](constructs/rpc-problem.md#authorizeanonymous): An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and its scope resolution disagree: a defect.
  - [`authorizePerson`](constructs/rpc-problem.md#authorizeperson): A rejected person credential is answered from the ingress evidence, never by string choice.
  - [`unreachable`](constructs/rpc-problem.md#unreachable): Marks problems a shared mapper can produce but this operation cannot, such as a serialization conflict inside a read-only snapshot.
  - [`problemUnion`](constructs/rpc-problem.md#problemunion): Creates the closed Problem Details union of one RPC.
  - [`Problem`](constructs/rpc-problem.md#problem): One RFC 9457 failure in an Effect error channel.
  - [`isProblem`](constructs/rpc-problem.md#isproblem): Narrows a caught value to a `Problem`, also one that another copy of this module created.
  - [`problemBody`](constructs/rpc-problem.md#problembody): The frozen RFC 9457 body: the registry entry, then code, instance, and validation.
  - [`makeNativeProblem`](constructs/rpc-problem.md#makenativeproblem): Builds one safe fixed public problem value.
- [sql-lock](constructs/sql-lock.md): Transaction-scoped PostgreSQL advisory locks under registered keys.
  - [`AdvisoryLockKey`](constructs/sql-lock.md#advisorylockkey): The registered advisory-lock keys, one constructor per namespace.
  - [`lockAdvisory`](constructs/sql-lock.md#lockadvisory): Waits for the advisory lock on `key` until the current transaction ends.
  - [`lockPersonAuthorization`](constructs/sql-lock.md#lockpersonauthorization): Serializes one person's protected command with person-keyed authority writers.
- [sql-lifecycle](constructs/sql-lifecycle.md): Claim-fenced row lifecycles in PostgreSQL, such as outbox claims and account access.
  - [`accountAccessEnabled`](constructs/sql-lifecycle.md#accountaccessenabled): Whether the native account of `personId` exists and is not disabled.
  - [`outboxClaimAssignments`](constructs/sql-lifecycle.md#outboxclaimassignments): SET list for the aggregate's claim UPDATE; `targetAlias` names the updated outbox row.
  - [`markOutboxDelivered`](constructs/sql-lifecycle.md#markoutboxdelivered): Settles the claimed row as Delivered, with delivery evidence when the table records it.
  - [`markOutboxFailed`](constructs/sql-lifecycle.md#markoutboxfailed): Settles the claimed row as Failed with its failure tag, so a later claim retries it.
  - [`quarantineOutboxClaim`](constructs/sql-lifecycle.md#quarantineoutboxclaim): Settles the claimed row as Quarantined, a terminal status, with its failure tag.
  - [`releaseOutboxClaim`](constructs/sql-lifecycle.md#releaseoutboxclaim): Returns an interrupted claim to Pending without a provider outcome; a lost claim needs none.
  - [`recoverStaleOutboxClaims`](constructs/sql-lifecycle.md#recoverstaleoutboxclaims): Recovers every Processing row claimed before `claimedBefore`.
- [delivery](constructs/delivery.md): Delivers committed effects to providers after the transaction.
  - [`deliverJson`](constructs/delivery.md#deliverjson): Shared acknowledged JSON transport; deliberately no retry on ambiguous acceptance.
- [worker](constructs/worker.md): Runs background workers on the Effect clock.
  - [`pollForever`](constructs/worker.md#pollforever): Runs `tick` at once, then again after each success.
- [pagination](constructs/pagination.md): Keyset cursors and pages over ordered PostgreSQL reads.
  - [`CursorPositioned`](constructs/pagination.md#cursorpositioned): A row with the ordering text that `receiptCursorTimestamp` selects.
  - [`receiptCursorTimestamp`](constructs/pagination.md#receiptcursortimestamp): Selects the ordering column as microsecond UTC text so cursor positions compare exactly.
  - [`receiptCursorPage`](constructs/pagination.md#receiptcursorpage): Keeps one page of the rows, encodes the next cursor when a further row was read, and drops the ordering text.
- [digest](constructs/digest.md): Canonical JSON and SHA-256 digests that evidence and idempotency identities hash.
  - [`canonicalJsonValue`](constructs/digest.md#canonicaljsonvalue): The plain JSON value of a datum, with sorted object keys and non-finite numbers as `null`.
  - [`canonicalJson`](constructs/digest.md#canonicaljson): The canonical JSON text of a datum, to hash or compare; a SQL `json` parameter takes `canonicalJsonValue` instead.
  - [`canonicalJsonBytes`](constructs/digest.md#canonicaljsonbytes): The UTF-8 bytes of the canonical JSON text of a datum.
  - [`sha256Hex`](constructs/digest.md#sha256hex): The lowercase hexadecimal SHA-256 digest of bytes.
- [test-harness](constructs/test-harness.md): Starts and drives disposable infrastructure for tests, proofs, and journeys: PostgreSQL clusters, loopback ports, and the local backend.
  - [`selectDatabaseMigration`](constructs/test-harness.md#selectdatabasemigration): Selects the registered migration `id` and the migrations that run before it.
  - [`journeyClock`](constructs/test-harness.md#journeyclock): A journey clock at a reference instant that the caller pins.
  - [`admissionJourneyClock`](constructs/test-harness.md#admissionjourneyclock): The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the current time.
  - [`localBackendEnvironment`](constructs/test-harness.md#localbackendenvironment): The environment of a disposable local native backend for one composition.
  - [`postgresProgram`](constructs/test-harness.md#postgresprogram): Absolute path of a client program of the selected PostgreSQL major.
  - [`postgresVersion`](constructs/test-harness.md#postgresversion): The `postgres --version` line of the selected major, such as `postgres (PostgreSQL) 18.6`, for evidence that names the toolchain whether or not a cluster started.
  - [`loopbackPortFree`](constructs/test-harness.md#loopbackportfree): Whether a listener can bind `port` on loopback now.
  - [`reserveLoopbackPorts`](constructs/test-harness.md#reserveloopbackports): Reserves `count` distinct loopback ports for the servers that a journey starts: its backend, dashboard, receivers, and clusters.
  - [`startDisposablePostgres`](constructs/test-harness.md#startdisposablepostgres): Starts a fresh cluster of the selected major on a private port and socket directory with trust authentication.
  - [`withDisposablePostgres`](constructs/test-harness.md#withdisposablepostgres): Runs `use` against the database `database` of a fresh cluster, which `startDisposablePostgres` starts, and removes the cluster when `use` settles, also when it fails.
- [browser-audit](constructs/browser-audit.md): Audits the pages that browser journeys render once they have settled: accessibility with axe.
  - [`auditSettledPage`](constructs/browser-audit.md#auditsettledpage): Audits a page with axe once every finite animation on it has finished.
- [request-ledger](constructs/request-ledger.md): Classifies the requests that journey recorders observe by whole path segments: native contract operations and legacy routes.
  - [`isNativeRequest`](constructs/request-ledger.md#isnativerequest): Whether a dashboard-to-backend request stays on the native surface: an operation of the native RPC contract or an email-password route of the identity engine.
  - [`addressesAnyRoute`](constructs/request-ledger.md#addressesanyroute): Whether a request path addresses any of the routes, each matched by whole path segments.
