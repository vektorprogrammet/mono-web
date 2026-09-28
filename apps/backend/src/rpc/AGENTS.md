[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/rpc

This folder is not a bounded context. Transport shared by every context: credential middlewares, problems, rate limits, command receipts.
The backend layer holds RPC handlers, delivery workers, and provider adapters that the native process composes. It keeps command receipts and preconditions in the transport, and provider I/O after commit.

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

## Constructs

The shared constructs defined here. Each name links to its contract; [docs/constructs.md](../../../../docs/constructs.md) indexes them all.

- [`jsonText`](../../../../docs/constructs/rpc-problem.md#jsontext) (rpc-problem): The JSON text of a representation, byte for byte what `JSON.stringify` writes.
- [`problemMapper`](../../../../docs/constructs/rpc-problem.md#problemmapper) (rpc-problem): Builds the one failure-to-problem mapper of a domain.
- [`commandIdentity`](../../../../docs/constructs/rpc-problem.md#commandidentity) (rpc-problem): Derives a command's idempotency identity: the receipt digest and the domain command ID.
- [`requireCurrentETag`](../../../../docs/constructs/rpc-problem.md#requirecurrentetag) (rpc-problem): Fails a mutation whose If-Match no longer names the current representation.
- [`isSerializationConflict`](../../../../docs/constructs/rpc-problem.md#isserializationconflict) (rpc-problem): Whether a failure, or one of its causes, is a lost serialization or deadlock race: a transaction.conflict the client may retry.
- [`requestInvalid`](../../../../docs/constructs/rpc-problem.md#requestinvalid) (rpc-problem): The request as a whole fails validation; no single member is singled out.
- [`strictOutput`](../../../../docs/constructs/rpc-problem.md#strictoutput) (rpc-problem): Decodes one response value strictly.
- [`commandReceiptProblems`](../../../../docs/constructs/rpc-problem.md#commandreceiptproblems) (rpc-problem): HTTP command receipts: the transport's own persistence failures.
- [`personPresentation`](../../../../docs/constructs/rpc-problem.md#personpresentation) (rpc-problem): The credential evidence of an RPC request: which credential headers it presented.
- [`commandOutcome`](../../../../docs/constructs/rpc-problem.md#commandoutcome) (rpc-problem): The value of a command receipt outcome: the committed or replayed success, or an idempotency problem.
- [`authorizeAnonymous`](../../../../docs/constructs/rpc-problem.md#authorizeanonymous) (rpc-problem): An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and its scope resolution disagree: a defect.
- [`authorizePerson`](../../../../docs/constructs/rpc-problem.md#authorizeperson) (rpc-problem): A rejected person credential is answered from the ingress evidence, never by string choice.
- [`unreachable`](../../../../docs/constructs/rpc-problem.md#unreachable) (rpc-problem): Marks problems a shared mapper can produce but this operation cannot, such as a serialization conflict inside a read-only snapshot.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
