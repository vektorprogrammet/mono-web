[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/http-api

This folder is not a bounded context. Transport shared by every context: problems, rate limits, JSON reading, receipt transactions.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

## Constructs

The shared constructs defined here. Each name links to its contract; [docs/constructs.md](../../../../docs/constructs.md) indexes them all.

- [`problemWebResponse`](../../../../docs/constructs/http-problem.md#problemwebresponse) (http-problem): Renders one problem outside HttpApi encoding, with the encoder's body and headers.
- [`jsonText`](../../../../docs/constructs/http-problem.md#jsontext) (http-problem): The JSON text of a representation, byte for byte what `JSON.stringify` writes.
- [`webHandler`](../../../../docs/constructs/http-problem.md#webhandler) (http-problem): Runs one Effect-native Web transport operation.
- [`semanticProblem`](../../../../docs/constructs/http-problem.md#semanticproblem) (http-problem): Runs a throwing semantic parser.
- [`problemMapper`](../../../../docs/constructs/http-problem.md#problemmapper) (http-problem): Builds the one failure-to-problem mapper of a domain.
- [`requireNoQuery`](../../../../docs/constructs/http-problem.md#requirenoquery) (http-problem): An operation that accepts no query answers any query as malformed.
- [`readJsonBody`](../../../../docs/constructs/http-problem.md#readjsonbody) (http-problem): Reads a bounded JSON body of the one media type `mediaType` accepts.
- [`idempotencyKeyOf`](../../../../docs/constructs/http-problem.md#idempotencykeyof) (http-problem): Decodes the one Idempotency-Key a replayable mutation requires.
- [`requiredIfMatchOf`](../../../../docs/constructs/http-problem.md#requiredifmatchof) (http-problem): Decodes the one strong If-Match an item mutation requires.
- [`httpIdentity`](../../../../docs/constructs/http-problem.md#httpidentity) (http-problem): Derives a command's idempotency identity; a tuple outside the frozen grammar is a request problem.
- [`requireCurrentETag`](../../../../docs/constructs/http-problem.md#requirecurrentetag) (http-problem): Fails a mutation whose If-Match no longer names the current representation.
- [`conditionalJson`](../../../../docs/constructs/http-problem.md#conditionaljson) (http-problem): Answers a conditional JSON read after authority and concealment: the representation, a bodyless 304, or precondition.failed.
- [`personPresentation`](../../../../docs/constructs/http-problem.md#personpresentation) (http-problem): The person credential a request presented, for a rejection answered after ingress.
- [`isSerializationConflict`](../../../../docs/constructs/http-problem.md#isserializationconflict) (http-problem): Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.
- [`requestInvalid`](../../../../docs/constructs/http-problem.md#requestinvalid) (http-problem): The request as a whole fails validation; no single member is singled out.
- [`decodeRequest`](../../../../docs/constructs/http-problem.md#decoderequest) (http-problem): Decodes one JSON request value strictly; any mismatch fails the whole request's validation.
- [`strictOutput`](../../../../docs/constructs/http-problem.md#strictoutput) (http-problem): Decodes one response value strictly.
- [`commandReceiptProblems`](../../../../docs/constructs/http-problem.md#commandreceiptproblems) (http-problem): HTTP command receipts: the transport's own persistence failures.
- [`commandOutcomeResponse`](../../../../docs/constructs/http-problem.md#commandoutcomeresponse) (http-problem): Answers a command receipt outcome: committed and replayed results, or an idempotency problem.
- [`authorizeAnonymous`](../../../../docs/constructs/http-problem.md#authorizeanonymous) (http-problem): An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and its scope resolution disagree: a defect.
- [`authorizePerson`](../../../../docs/constructs/http-problem.md#authorizeperson) (http-problem): A rejected person credential is answered from the ingress evidence, never by string choice.
- [`unreachable`](../../../../docs/constructs/http-problem.md#unreachable) (http-problem): Marks problems a shared mapper can produce but this operation cannot, such as a serialization conflict inside a read-only snapshot.
- [`ProblemBoundaryLive`](../../../../docs/constructs/http-problem.md#problemboundarylive) (http-problem): The only Cause consumer.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
