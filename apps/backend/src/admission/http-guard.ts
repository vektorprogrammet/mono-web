/** Request-local access decisions that the generated Admissions and outcome guards evaluate. */
import type { CanonicalScopeResolution } from "@vektorprogrammet/domain/authz";
import { reflectAccessSpec } from "@vektorprogrammet/http-api";
import type { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Context, Effect, Option, type Schema } from "effect";
import { authorizeAnonymous, authorizePerson, personPresentation } from "../http-api/problem.js";
import type { NativePersonAuthorization } from "../native-operation.js";

type Endpoint = Parameters<typeof reflectAccessSpec>[0];

/** What a person decision point supplies; the guard adds the AccessSpec of its own endpoint. */
export type PersonDecisionInput = Omit<NativePersonAuthorization, "spec">;

/**
 * The decision that the original access point hands to its generated guard. The guard is never
 * evaluated anywhere else, so no request can authorize against another operation's frame.
 */
export type AdmissionDecision =
  | {
      readonly kind: "Person";
      readonly operation: string;
      readonly request: Request;
      readonly input: PersonDecisionInput;
    }
  | {
      readonly kind: "Anonymous";
      readonly operation: string;
      readonly resolution: CanonicalScopeResolution<Schema.JsonObject>;
      readonly now: string;
    };

export const CurrentAdmissionDecision = Context.Reference<AdmissionDecision | undefined>(
  "@vektorprogrammet/backend/admission/current-decision",
  { defaultValue: () => undefined },
);

/** The person guard of one endpoint: it evaluates the AccessSpec of `endpoint` at its decision. */
export const personGuard = (operation: string, endpoint: Endpoint) =>
  Effect.gen(function* () {
    const decision = yield* CurrentAdmissionDecision;

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

/** The anonymous guard of one endpoint: it evaluates the AccessSpec of `endpoint` at its decision. */
export const anonymousGuard = (operation: string, endpoint: Endpoint) =>
  Effect.gen(function* () {
    const decision = yield* CurrentAdmissionDecision;

    if (decision?.kind !== "Anonymous" || decision.operation !== operation) {
      return yield* Effect.die(
        new TypeError(
          `The anonymous guard of ${operation} ran outside its matching access decision`,
        ),
      );
    }

    return yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(endpoint)),
      decision.resolution,
      decision.now,
    );
  });

/** Runs a generated guard at the original decision point, with the facts only that point holds. */
export const authorizeAt = <E>(
  authorize: () => Effect.Effect<unknown, E>,
  decision: AdmissionDecision,
): Effect.Effect<void, E> =>
  authorize().pipe(Effect.provideService(CurrentAdmissionDecision, decision), Effect.asVoid);

/** The failures of a person guard whose AccessSpec reveals every denial. */
type PersonDenial =
  | Problem<"authority.denied">
  | Problem<"credential.invalid">
  | Problem<"credential.missing">;

/** The generated guard of an admission person endpoint, as a handler receives it. */
export type AdmissionPersonAuthorize = () => Effect.Effect<unknown, PersonDenial>;

/** The generated guard of an anonymous admission endpoint, as a handler receives it. */
export type AdmissionAnonymousAuthorize = () => Effect.Effect<unknown>;

/** The failures of an outcome or template person guard, whose endpoints declare resource.not-found. */
export type OutcomePersonDenial = PersonDenial | Problem<"resource.not-found">;

/** The generated guard of an outcome or template endpoint, as a handler receives it. */
export type OutcomePersonAuthorize = () => Effect.Effect<unknown, OutcomePersonDenial>;
