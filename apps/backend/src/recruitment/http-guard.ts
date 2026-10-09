/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
/** Request-local authority frames evaluated only by the matching generated Recruitment guard. */
import type { RecruitmentInvitationHttpSource } from "@vektorprogrammet/domain/recruitment";
import { ExternalNativeApi, reflectAccessSpec } from "@vektorprogrammet/http-api";
import type { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Context, Effect, Option } from "effect";
import type { HttpApiGroup } from "effect/http-api";
import type { RecruitmentGuards } from "../../.effx/generated/recruitment-handlers.js";
import { authorizePerson, personPresentation } from "../http-api/problem.js";
import type { NativePersonAuthorization } from "../native-operation.js";
import { authorizeInvitationOperation } from "./http-access.js";

type RecruitmentEndpoints = HttpApiGroup.Endpoints<
  (typeof ExternalNativeApi)["groups"]["recruitment"]
>;

export type RecruitmentOperationId = keyof RecruitmentGuards<RecruitmentEndpoints>;

type Endpoint = Parameters<typeof reflectAccessSpec>[0];

/** Only the existing decision point owns these current credential and scope facts. */
export type RecruitmentDecision =
  | {
      readonly kind: "Person";
      readonly operation: RecruitmentOperationId;
      readonly request: Request;
      readonly input: Omit<NativePersonAuthorization, "spec">;
    }
  | {
      readonly kind: "Invitation";
      readonly operation: RecruitmentOperationId;
      readonly source: RecruitmentInvitationHttpSource;
      readonly authorizationInstant: string;
    };

export const CurrentRecruitmentDecision = Context.Reference<RecruitmentDecision | undefined>(
  "@vektorprogrammet/backend/recruitment/current-decision",
  { defaultValue: () => undefined },
);

export const personGuard = Effect.fnUntraced(function* (
  operation: RecruitmentOperationId,
  endpoint: Endpoint,
) {
  const decision = yield* CurrentRecruitmentDecision;

  if (decision?.kind !== "Person" || decision.operation !== operation) {
    return yield* Effect.die(
      new TypeError(`The person guard of ${operation} ran outside its matching access decision`),
    );
  }

  return yield* authorizePerson(
    { ...decision.input, spec: Option.getOrThrow(reflectAccessSpec(endpoint)) },
    personPresentation(decision.request),
  );
});

export const invitationGuard = Effect.fnUntraced(function* (
  operation: RecruitmentOperationId,
  endpoint: Endpoint,
) {
  const decision = yield* CurrentRecruitmentDecision;

  if (decision?.kind !== "Invitation" || decision.operation !== operation) {
    return yield* Effect.die(
      new TypeError(
        `The invitation guard of ${operation} ran outside its matching access decision`,
      ),
    );
  }

  return yield* authorizeInvitationOperation({
    spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
    source: decision.source,
    authorizationInstant: decision.authorizationInstant,
  });
});

/** The callback stays deferred and its current frame cannot escape this one evaluation. */
export const authorizeAt = <E>(
  authorize: () => Effect.Effect<unknown, E>,
  decision: RecruitmentDecision,
): Effect.Effect<void, E> =>
  Effect.suspend(authorize).pipe(
    Effect.provideService(CurrentRecruitmentDecision, decision),
    Effect.asVoid,
  );

export type RecruitmentPersonDenial =
  | Problem<"authority.denied">
  | Problem<"credential.invalid">
  | Problem<"credential.missing">;

export type RecruitmentPersonAuthorize = () => Effect.Effect<unknown, RecruitmentPersonDenial>;

export type RecruitmentInvitationAuthorize = () => Effect.Effect<
  unknown,
  Problem<"resource.not-found">
>;
