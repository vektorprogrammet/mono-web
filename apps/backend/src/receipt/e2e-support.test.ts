import { isProblem, type Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Cause, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";
import {
  RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER,
  makeReceiptE2ETransactionBarrier,
  type ReceiptE2EConcurrencyLane,
} from "./e2e-support.js";

const probe = (lane: ReceiptE2EConcurrencyLane | null) =>
  new Request("http://backend.test/api/receipts/receipt-1/approve", {
    headers: lane === null ? {} : { [RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER]: lane },
  });

const malformedStatus = (failure: Problem<"request.malformed"> | Cause.TimeoutError) =>
  isProblem(failure) ? `${failure.code}:${failure.status}` : "other";

describe("receipt E2E transaction barrier", () => {
  it.effect("holds probed lanes until all three arrive and then admits their retries", () =>
    Effect.gen(function* () {
      const barrier = yield* makeReceiptE2ETransactionBarrier;

      const unprobed = yield* barrier(probe(null), "receipt-1", "approve");
      const approve = yield* Effect.forkChild(barrier(probe("approve"), "receipt-1", "approve"));
      const reject = yield* Effect.forkChild(barrier(probe("reject"), "receipt-1", "reject"));
      yield* Effect.yieldNow;

      const heldBeforeLastLane = approve.pollUnsafe() === undefined;
      const fileRead = yield* barrier(probe("file-read"), "receipt-1", "file-read");
      const retry = yield* barrier(probe("approve"), "receipt-1", "approve");

      expect({
        unprobed,
        heldBeforeLastLane,
        lanes: [yield* Fiber.join(approve), yield* Fiber.join(reject), fileRead],
        retry,
      }).toEqual({
        unprobed: false,
        heldBeforeLastLane: true,
        lanes: [true, true, true],
        retry: true,
      });
    }),
  );

  it.effect("rejects a mismatched lane, another receipt, and an unsynchronized repeat", () =>
    Effect.gen(function* () {
      const barrier = yield* makeReceiptE2ETransactionBarrier;
      const mismatched = yield* Effect.flip(barrier(probe("reject"), "receipt-1", "approve"));
      const waiting = yield* Effect.forkChild(barrier(probe("approve"), "receipt-1", "approve"));
      yield* Effect.yieldNow;
      const otherReceipt = yield* Effect.flip(barrier(probe("reject"), "receipt-2", "reject"));
      const repeated = yield* Effect.flip(barrier(probe("approve"), "receipt-1", "approve"));
      yield* Fiber.interrupt(waiting);

      expect([mismatched, otherReceipt, repeated].map(malformedStatus)).toEqual([
        "request.malformed:400",
        "request.malformed:400",
        "request.malformed:400",
      ]);
    }),
  );

  it.effect("times every lane out ten seconds after the first arrival and stays expired", () =>
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

      expect([...timedOut, lateLane].map(Cause.isTimeoutError)).toEqual([true, true, true]);
    }),
  );
});
