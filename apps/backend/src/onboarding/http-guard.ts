import { reflectAccessSpec } from "@vektorprogrammet/http-api";
import type { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Context, Effect, Option } from "effect";
import { authorizePerson, personPresentation } from "../http-api/problem.js";
import type { NativePersonAuthorization } from "../native-operation.js";

type Endpoint = Parameters<typeof reflectAccessSpec>[0];

export type OnboardingOperation = "onboarding.readBoard" | "onboarding.command";

/** Only the original read snapshot or command preparation can supply these current Person facts. */
export interface OnboardingDecision {
  readonly operation: OnboardingOperation;
  readonly request: Request;
  readonly input: Omit<NativePersonAuthorization, "spec">;
}

const CurrentOnboardingDecision = Context.Reference<OnboardingDecision | undefined>(
  "@vektorprogrammet/backend/onboarding/current-decision",
  { defaultValue: () => undefined },
);

/** A deferred guard evaluates only its own endpoint in its matching request-local authority frame. */
export const onboardingGuard = Effect.fnUntraced(function* (
  operation: OnboardingOperation,
  endpoint: Endpoint,
) {
  const decision = yield* CurrentOnboardingDecision;

  if (decision === undefined || decision.operation !== operation) {
    return yield* Effect.die(
      new TypeError(`The guard of ${operation} ran outside its matching onboarding decision`),
    );
  }

  return yield* authorizePerson(
    { ...decision.input, spec: Option.getOrThrow(reflectAccessSpec(endpoint)) },
    personPresentation(decision.request),
  );
});

/** Supplies a fresh frame at the existing decision point, never at generated registration time. */
export const authorizeOnboardingAt = <E>(
  authorize: () => Effect.Effect<unknown, E>,
  decision: OnboardingDecision,
): Effect.Effect<void, E> =>
  authorize().pipe(Effect.provideService(CurrentOnboardingDecision, decision), Effect.asVoid);

/** The revealing Person policy keeps every credential, authority and missing-scope failure typed. */
export type OnboardingPersonAuthorize = () => Effect.Effect<
  unknown,
  | Problem<"authority.denied">
  | Problem<"credential.invalid">
  | Problem<"credential.missing">
  | Problem<"resource.not-found">
>;
