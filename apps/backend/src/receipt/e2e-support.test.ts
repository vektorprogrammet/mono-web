import { Cause, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { HttpSemanticFailure } from "../http-semantics.js";
import { runTestPromise } from "../../test/runtime.js";
import {
  RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER,
  makeReceiptE2ETransactionBarrier,
  type ReceiptE2EConcurrencyLane,
} from "./e2e-support.js";

const probe = (lane: ReceiptE2EConcurrencyLane | null) =>
  new Request("http://backend.test/api/receipts/receipt-1/approve", {
    headers: lane === null ? {} : { [RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER]: lane },
  });

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  runTestPromise(effect.pipe(Effect.provide(TestClock.layer())));

const malformedStatus = (failure: HttpSemanticFailure | Cause.TimeoutError) =>
  failure instanceof HttpSemanticFailure ? `${failure.code}:${failure.status}` : "other";

describe("receipt E2E transaction barrier", () => {
  it("holds probed lanes until all three arrive and then admits their retries", async () => {
    const result = await runWithTestClock(
      Effect.gen(function* () {
        const barrier = yield* makeReceiptE2ETransactionBarrier;

        const unprobed = yield* barrier(probe(null), "receipt-1", "approve");
        const approve = yield* Effect.forkChild(barrier(probe("approve"), "receipt-1", "approve"));
        const reject = yield* Effect.forkChild(barrier(probe("reject"), "receipt-1", "reject"));
        yield* Effect.yieldNow;

        const heldBeforeLastLane = approve.pollUnsafe() === undefined;
        const fileRead = yield* barrier(probe("file-read"), "receipt-1", "file-read");
        const retry = yield* barrier(probe("approve"), "receipt-1", "approve");

        return {
          unprobed,
          heldBeforeLastLane,
          lanes: [yield* Fiber.join(approve), yield* Fiber.join(reject), fileRead],
          retry,
        };
      }),
    );

    expect(result).toEqual({
      unprobed: false,
      heldBeforeLastLane: true,
      lanes: [true, true, true],
      retry: true,
    });
  });

  it("rejects a mismatched lane, another receipt, and an unsynchronized repeat", async () => {
    const failures = await runWithTestClock(
      Effect.gen(function* () {
        const barrier = yield* makeReceiptE2ETransactionBarrier;
        const mismatched = yield* Effect.flip(barrier(probe("reject"), "receipt-1", "approve"));
        const waiting = yield* Effect.forkChild(barrier(probe("approve"), "receipt-1", "approve"));
        yield* Effect.yieldNow;
        const otherReceipt = yield* Effect.flip(barrier(probe("reject"), "receipt-2", "reject"));
        const repeated = yield* Effect.flip(barrier(probe("approve"), "receipt-1", "approve"));
        yield* Fiber.interrupt(waiting);

        return [mismatched, otherReceipt, repeated].map(malformedStatus);
      }),
    );

    expect(failures).toEqual([
      "request.malformed:400",
      "request.malformed:400",
      "request.malformed:400",
    ]);
  });

  it("times every lane out ten seconds after the first arrival and stays expired", async () => {
    const result = await runWithTestClock(
      Effect.gen(function* () {
        const barrier = yield* makeReceiptE2ETransactionBarrier;
        const approve = yield* Effect.forkChild(barrier(probe("approve"), "receipt-1", "approve"));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("6 seconds");
        const reject = yield* Effect.forkChild(barrier(probe("reject"), "receipt-1", "reject"));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("4 seconds");

        const timedOut = [
          yield* Effect.flip(Fiber.join(approve)),
          yield* Effect.flip(Fiber.join(reject)),
        ];

        const lateLane = yield* Effect.flip(barrier(probe("file-read"), "receipt-1", "file-read"));

        return [...timedOut, lateLane].map(Cause.isTimeoutError);
      }),
    );

    expect(result).toEqual([true, true, true]);
  });
});
