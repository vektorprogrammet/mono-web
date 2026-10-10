import { assert, describe, it } from "@effect/vitest";
import { Scope } from "@vektorprogrammet/domain/authz";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Deferred, Effect, Exit, Fiber, Ref } from "effect";
import { genericContext } from "../native-operation.js";
import { onboardingGuards } from "./http.js";
import {
  authorizeOnboardingAt,
  type OnboardingDecision,
  type OnboardingOperation,
} from "./http-guard.js";

const departmentId = DepartmentId.make("onboarding-guard-department");

const otherDepartmentId = DepartmentId.make("onboarding-guard-other-department");

const personId = PersonId.make("onboarding-guard-person");

const instant = "2026-10-01T10:00:00.000Z";

const decision = (
  operation: OnboardingOperation,
  grantDepartmentId = departmentId,
): OnboardingDecision => {
  const request = new Request("http://backend.test/api/onboarding", {
    headers: { cookie: "better-auth.session_token=synthetic-onboarding-guard" },
  });

  return {
    operation,
    request,
    input: {
      request,
      personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({ domainId: "organization", departmentId, authorityVersion: instant }),
        ],
      },
      grantScopes: [Scope.Department({ departmentId: grantDepartmentId })],
      now: instant,
    },
  };
};

describe("deferred onboarding authority frames", () => {
  for (const operation of ["onboarding.readBoard", "onboarding.command"] as const) {
    it.effect(`${operation} authorizes only its own Person/department decision`, () =>
      Effect.gen(function* () {
        yield* authorizeOnboardingAt(onboardingGuards[operation], decision(operation));

        const refusal = yield* authorizeOnboardingAt(
          onboardingGuards[operation],
          decision(operation, otherDepartmentId),
        ).pipe(Effect.flip);

        assert.strictEqual(refusal.code, "authority.denied");
      }),
    );

    it.effect(`${operation} cannot reuse a completed frame or run without one`, () =>
      Effect.gen(function* () {
        const guard = onboardingGuards[operation];
        // Construction must not evaluate the absent frame. Only executing the Effect may fail.
        const unexecuted = guard();
        const absent = yield* Effect.exit(unexecuted);
        assert.isTrue(Exit.hasDies(absent));

        yield* authorizeOnboardingAt(guard, decision(operation));
        const reused = yield* Effect.exit(guard());
        assert.isTrue(Exit.hasDies(reused));
      }),
    );

    it.effect(`${operation} rejects a frame belonging to the other operation`, () =>
      Effect.gen(function* () {
        const other =
          operation === "onboarding.command" ? "onboarding.readBoard" : "onboarding.command";

        const exit = yield* Effect.exit(
          authorizeOnboardingAt(onboardingGuards[operation], decision(other)),
        );

        assert.isTrue(Exit.hasDies(exit));
        assert.isFalse(Exit.hasInterrupts(exit));
      }),
    );
  }

  it.effect("a credential missing from the frame stays a typed credential failure", () =>
    Effect.gen(function* () {
      const original = decision("onboarding.command");

      const input = {
        personId: original.input.personId,
        resolution: original.input.resolution,
        grantScopes: original.input.grantScopes,
        now: original.input.now,
      };

      const rejected = yield* authorizeOnboardingAt(onboardingGuards["onboarding.command"], {
        ...original,
        input,
      }).pipe(Effect.flip);

      const missing = yield* authorizeOnboardingAt(onboardingGuards["onboarding.command"], {
        ...original,
        request: new Request("http://backend.test/api/onboarding"),
        input,
      }).pipe(Effect.flip);

      assert.strictEqual(rejected.code, "credential.invalid");
      assert.strictEqual(missing.code, "credential.missing");
    }),
  );

  it.effect(
    "frame provision preserves expected failure and defect while running cleanup once",
    () =>
      Effect.gen(function* () {
        const released = yield* Ref.make(0);
        const cleanup = Ref.update(released, (count) => count + 1);
        const frame = decision("onboarding.command");
        const failure = Problem.make("authority.denied");

        yield* authorizeOnboardingAt(() => Effect.void.pipe(Effect.ensuring(cleanup)), frame);
        assert.strictEqual(yield* Ref.get(released), 1);

        const refused = yield* authorizeOnboardingAt(
          () => Effect.fail(failure).pipe(Effect.ensuring(cleanup)),
          frame,
        ).pipe(Effect.flip);

        assert.strictEqual(refused, failure);
        assert.strictEqual(yield* Ref.get(released), 2);

        const defect = yield* Effect.exit(
          authorizeOnboardingAt(
            () =>
              Effect.die(new TypeError("synthetic guard defect")).pipe(Effect.ensuring(cleanup)),
            frame,
          ),
        );

        assert.isTrue(Exit.hasDies(defect));
        assert.isFalse(Exit.hasInterrupts(defect));
        assert.strictEqual(yield* Ref.get(released), 3);
      }),
  );

  it.effect("interruption propagates through the frame and awaits cleanup exactly once", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Ref.make(0);

      const pending = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);

        return yield* Effect.never;
      }).pipe(Effect.ensuring(Ref.update(released, (count) => count + 1)));

      const fiber = yield* Effect.forkChild(
        authorizeOnboardingAt(() => pending, decision("onboarding.command")),
      );

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.isFalse(Exit.hasDies(exit));
      assert.strictEqual(yield* Ref.get(released), 1);

      const afterCleanup = yield* Effect.exit(onboardingGuards["onboarding.command"]());
      assert.isTrue(Exit.hasDies(afterCleanup));
    }),
  );
});
