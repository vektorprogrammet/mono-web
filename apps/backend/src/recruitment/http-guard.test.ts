import { expect, it } from "@effect/vitest";
import { DomainId, Scope } from "@vektorprogrammet/domain/authz";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { RecruitmentInvitationHttpSourceSchema } from "@vektorprogrammet/domain/recruitment";
import {
  ExternalNativeApi,
  InvitationCapabilitySecurity,
  RecruitmentApi,
} from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { expectTypeOf } from "vitest";
import type { RecruitmentGuards } from "../../.effx/generated/recruitment-handlers.js";
import { genericContext } from "../native-operation.js";
import { recruitmentGuards } from "./http.js";
import {
  CurrentRecruitmentDecision,
  authorizeAt,
  type RecruitmentDecision,
  type RecruitmentOperationId,
} from "./http-guard.js";

type Endpoints = HttpApiGroup.Endpoints<(typeof ExternalNativeApi)["groups"]["recruitment"]>;

type Guards = typeof recruitmentGuards;

type TestGuard = () => Effect.Effect<unknown, Effect.Error<ReturnType<Guards[keyof Guards]>>>;

type UnexpectedFailures = {
  [K in keyof Guards]: Exclude<
    Effect.Error<ReturnType<Guards[K]>>,
    HttpApiEndpoint.ErrorsWithIdentifier<
      Endpoints,
      K extends `recruitment.${infer Key}` ? Key : never
    >
  >;
}[keyof Guards];

type GuardServices = {
  [K in keyof Guards]: Effect.Services<ReturnType<Guards[K]>>;
}[keyof Guards];

const source = Schema.decodeSync(RecruitmentInvitationHttpSourceSchema)({
  capabilitySha256: "recruitment-guard-capability-digest",
  invitationId: "recruitment-guard-invitation",
  interviewId: "recruitment-guard-interview",
  departmentId: "recruitment-guard-department",
  scheduleRevision: 1,
  responseRevision: 0,
  responseState: "Pending",
  supersededAt: null,
});

const personDecision = (operation: RecruitmentOperationId): RecruitmentDecision => {
  const request = new Request("http://backend.test/api/recruitment/application-assignments");

  return {
    kind: "Person",
    operation,
    request,
    input: {
      request,
      personId: PersonId.make("recruitment-guard-person"),
      resolution: {
        selection: "AllMatching",
        contexts: [genericContext({ domainId: "recruitment", authorityVersion: "guard-proof" })],
      },
      grantScopes: [Scope.Domain({ domainId: DomainId.make("recruitment") })],
      now: "2031-09-15T12:00:00.000Z",
    },
  };
};

it("keeps every generated guard key, allowed failure channel and closed requirement channel", () => {
  expectTypeOf<Guards>().toExtend<RecruitmentGuards<Endpoints>>();
  expectTypeOf<keyof Guards>().toEqualTypeOf<RecruitmentOperationId>();
  expectTypeOf<UnexpectedFailures>().toEqualTypeOf<never>();
  expectTypeOf<GuardServices>().toEqualTypeOf<never>();
  expectTypeOf<Omit<Guards, "recruitment.confirmInvitation">>().not.toExtend<
    RecruitmentGuards<Endpoints>
  >();

  type WrongFailure = Omit<Guards, "recruitment.confirmInvitation"> & {
    readonly "recruitment.confirmInvitation": () => Effect.Effect<
      never,
      Problem<"onboarding.already-linked">
    >;
  };

  expectTypeOf<WrongFailure>().not.toExtend<RecruitmentGuards<Endpoints>>();
});

it.effect("all sixteen guards refuse execution without a decision frame", () =>
  Effect.gen(function* () {
    const guards: ReadonlyArray<TestGuard> = Object.values(recruitmentGuards);
    expect(guards).toHaveLength(16);

    for (const guard of guards) expect(Exit.hasDies(yield* Effect.exit(guard()))).toBe(true);
  }),
);

it.effect(
  "every guard refuses a frame of the wrong principal kind, including a same-operation frame",
  () =>
    Effect.gen(function* () {
      for (const endpoint of Object.values(RecruitmentApi.endpoints)) {
        const operation: RecruitmentOperationId = `recruitment.${endpoint.identifier}`;
        const person = personDecision(operation);

        const invitation: RecruitmentDecision = {
          kind: "Invitation",
          operation,
          source,
          authorizationInstant: "2031-09-15T12:00:00.000Z",
        };

        const guard: TestGuard = recruitmentGuards[operation];
        let invitationGuard = false;

        for (const middleware of endpoint.middlewares) {
          if (middleware === InvitationCapabilitySecurity) invitationGuard = true;
        }

        const wrongKind = invitationGuard ? person : invitation;

        expect(Exit.hasDies(yield* Effect.exit(authorizeAt(guard, wrongKind)))).toBe(true);
      }
    }),
);

it.effect("guards cannot reuse another operation's authority frame", () =>
  Effect.gen(function* () {
    const decision = personDecision("recruitment.readInvitationResponse");

    const guards: ReadonlyArray<TestGuard> = Object.values(recruitmentGuards);

    for (const guard of guards) {
      expect(Exit.hasDies(yield* Effect.exit(authorizeAt(guard, decision)))).toBe(true);
    }
  }),
);

it.effect(
  "a matching capability guard succeeds, but its frame cannot authorize a later request",
  () =>
    Effect.gen(function* () {
      const guard = recruitmentGuards["recruitment.readInvitationResponse"];
      yield* authorizeAt(guard, {
        kind: "Invitation",
        operation: "recruitment.readInvitationResponse",
        source,
        authorizationInstant: "2031-09-15T12:00:00.000Z",
      });
      expect(yield* CurrentRecruitmentDecision).toBeUndefined();
      expect(Exit.hasDies(yield* Effect.exit(guard()))).toBe(true);
    }),
);

it.effect(
  "a matching board frame cannot grant missing leadership and retains its typed denial",
  () =>
    Effect.gen(function* () {
      const denial = yield* authorizeAt(
        recruitmentGuards["recruitment.readAssignmentBoard"],
        personDecision("recruitment.readAssignmentBoard"),
      ).pipe(Effect.flip);

      expect(denial.code).toBe("authority.denied");
      expect(yield* CurrentRecruitmentDecision).toBeUndefined();
    }),
);

it.effect("constructing the decision program does not call its guard", () =>
  Effect.gen(function* () {
    let calls = 0;

    const guard = () => {
      calls += 1;

      return CurrentRecruitmentDecision;
    };

    const program = authorizeAt(guard, personDecision("recruitment.readAssignmentBoard"));
    expect(calls).toBe(0);
    yield* program;
    expect(calls).toBe(1);
    expect(yield* CurrentRecruitmentDecision).toBeUndefined();
  }),
);

it.effect("interruption releases the guarded work once and cannot leak its authority frame", () =>
  Effect.gen(function* () {
    const acquired = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const decision = personDecision("recruitment.readAssignmentBoard");
    let releases = 0;

    const guard = () =>
      Effect.gen(function* () {
        expect(yield* CurrentRecruitmentDecision).toEqual(decision);
        yield* Deferred.succeed(acquired, undefined);

        return yield* Effect.never;
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            releases += 1;
            yield* Deferred.succeed(released, undefined);
          }),
        ),
      );

    const fiber = yield* authorizeAt(guard, decision).pipe(Effect.forkChild);
    yield* Deferred.await(acquired);
    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(released);
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    expect(releases).toBe(1);
    expect(yield* CurrentRecruitmentDecision).toBeUndefined();
  }),
);
