[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/http-api

This folder is not a bounded context. Transport shared by every context: problems, rate limits, JSON reading, receipt transactions.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

## Constructs

The shared constructs defined here. [docs/constructs.md](../../../../docs/constructs.md) lists their consumers.

- [`problemWebResponse`](problem.ts) (http-problem): Renders one problem outside HttpApi encoding, with the encoder's body and headers.
- [`classifyCredential`](problem.ts) (http-problem): Records, from the raw request only, whether person credential material was presented.
- [`webHandler`](problem.ts) (http-problem): Runs one Effect-native Web transport operation.
- [`semanticProblem`](problem.ts) (http-problem): Runs a throwing semantic parser.
- [`problemMapper`](problem.ts) (http-problem): Builds the one failure-to-problem mapper of a domain.
- [`headerValues`](problem.ts) (http-problem): The values of one request header; an absent header has none.
- [`requireNoQuery`](problem.ts) (http-problem): An operation that accepts no query answers any query as malformed.
- [`readJsonBody`](problem.ts) (http-problem): Reads a bounded JSON body of the one media type `mediaType` accepts.
- [`idempotencyKeyOf`](problem.ts) (http-problem): Decodes the one Idempotency-Key a replayable mutation requires.
- [`requiredIfMatchOf`](problem.ts) (http-problem): Decodes the one strong If-Match an item mutation requires.
- [`httpIdentity`](problem.ts) (http-problem): Derives a command's idempotency identity; a tuple outside the frozen grammar is a request problem.
- [`requireCurrentETag`](problem.ts) (http-problem): Fails a mutation whose If-Match no longer names the current representation.
- [`conditionalJson`](problem.ts) (http-problem): Answers a conditional JSON read after authority and concealment: the representation, a bodyless 304, or precondition.failed.
- [`personPresentation`](problem.ts) (http-problem): The person credential a request presented, for a rejection answered after ingress.
- [`isSerializationConflict`](problem.ts) (http-problem): Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.
- [`requestInvalid`](problem.ts) (http-problem): The request as a whole fails validation; no single member is singled out.
- [`decodeRequest`](problem.ts) (http-problem): Decodes one JSON request value strictly; any mismatch fails the whole request's validation.
- [`strictOutput`](problem.ts) (http-problem): Decodes one response value strictly.
- [`commandReceiptProblems`](problem.ts) (http-problem): HTTP command receipts: the transport's own persistence failures.
- [`commandOutcomeResponse`](problem.ts) (http-problem): Answers a command receipt outcome: committed and replayed results, or an idempotency problem.
- [`authorizeAnonymous`](problem.ts) (http-problem): An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and its scope resolution disagree: a defect.
- [`authorizePerson`](problem.ts) (http-problem): A rejected person credential is answered from the ingress evidence, never by string choice.
- [`unreachable`](problem.ts) (http-problem): Marks problems a shared mapper can produce but this operation cannot, such as a serialization conflict inside a read-only snapshot.
- [`ProblemBoundaryLive`](problem.ts) (http-problem): The only Cause consumer.
- [`readBoundedJson`](read-json.ts) (http-transport): Bound bytes while reading, including requests without Content-Length.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
