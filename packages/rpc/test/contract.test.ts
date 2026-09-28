import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  anonymousNativeAccess,
  InternalNativeRpcs,
  NativeRpcs,
  ProblemBoundary,
  ReadSocialEventScope,
  reflectAccessSpec,
  withAccessSpec,
} from "../src/index.js";
import { isProblem, Problem, problemUnion, rpcProblems } from "../src/problem.js";

const allRpcs = [...NativeRpcs.requests.values(), ...InternalNativeRpcs.requests.values()];

// The operation-id grammar that command receipts store (`receipt-transaction.ts`).
const operationId =
  /^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?:\.[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)+$/u;

describe("the native RPC contract", () => {
  it("serves every operation of every context", () => {
    // 106 external operations and the internal evidence read; /health stays plain HTTP.
    expect(NativeRpcs.requests.size).toBe(106);
    expect(InternalNativeRpcs.requests.size).toBe(1);
  });

  it("gives every RPC exactly one AccessSpec", () => {
    const missing = allRpcs.flatMap((rpc) =>
      Option.isNone(reflectAccessSpec(rpc)) ? [rpc._tag] : [],
    );

    expect(missing).toEqual([]);
  });

  it("names every RPC by an operation id that a command receipt can store", () => {
    expect(allRpcs.flatMap((rpc) => (operationId.test(rpc._tag) ? [] : [rpc._tag]))).toEqual([]);
  });

  it("runs every RPC inside the defect boundary", () => {
    const unbounded = allRpcs.flatMap((rpc) =>
      [...rpc.middlewares].some((middleware) => middleware === ProblemBoundary) ? [] : [rpc._tag],
    );

    expect(unbounded).toEqual([]);
  });

  it("rejects a second AccessSpec on one RPC", () => {
    expect(() =>
      withAccessSpec(anonymousNativeAccess("system.health"))(ReadSocialEventScope),
    ).toThrow(/multiple AccessSpec annotations/u);
  });
});

describe("rpcProblems", () => {
  const Declared = rpcProblems(
    problemUnion("DeclaredProblem", ["authority.denied", "idempotency.in-flight"]),
  );

  it.effect("round-trips a declared problem through its wire body", () =>
    Effect.gen(function* () {
      const wire = yield* Schema.encodeEffect(Declared)(Problem.make("authority.denied"));

      expect(wire).toMatchObject({ code: "authority.denied", status: 403 });

      const decoded = yield* Schema.decodeEffect(Declared)(wire);

      expect(isProblem(decoded) && decoded.code).toBe("authority.denied");
    }),
  );

  it.effect("refuses to encode a code the RPC does not declare", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Schema.encodeUnknownEffect(Declared)(Problem.make("internal.error")),
      );

      expect(failure).toBeInstanceOf(Schema.SchemaError);
    }),
  );
});
