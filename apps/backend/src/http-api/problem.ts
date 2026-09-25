/**
 * Typed transport failures for handler groups migrated off raw problem
 * Responses. Handlers fail with `Problem` values and HttpApiBuilder encodes
 * them against the endpoint's declared problems, so an undeclared code, an
 * unmapped domain failure, or a credential code chosen without ingress
 * evidence does not compile.
 */
import type { AccessSpec, CanonicalScopeResolution } from "@vektorprogrammet/domain/authz";
import {
  credentialPresentation,
  type CredentialPresentation,
  isProblem,
  type NativeProblemCode,
  type PlainProblemCode,
  Problem,
  problemBody,
  problemHeaders,
} from "@vektorprogrammet/http-api/http-semantics";
import { Cause, Effect, ErrorReporter, Match, Predicate, type Schema } from "effect";
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpSemanticFailure, responseFromCapsule } from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  authorizePersonNativeOperation,
  type NativePersonAuthorization,
} from "../native-operation.js";
import { hasBetterAuthSessionCredential } from "../session-security.js";
import type {
  NativeHttpCommandOutcome,
  NativeHttpReceiptInvalid,
  NativeHttpReceiptPersistenceError,
} from "./receipt-transaction.js";

/** Renders one problem outside HttpApi encoding, with the encoder's body and headers. */
export const problemWebResponse = (problem: Problem): Response =>
  new Response(JSON.stringify(problemBody(problem)), {
    status: problem.status,
    headers: { ...problemHeaders(problem), "content-type": "application/problem+json" },
  });

/** Records, from the raw request only, whether person credential material was presented. */
export const classifyCredential = (
  authorization: string | null | undefined,
  cookie: string | null | undefined,
  challenge: string,
): CredentialPresentation =>
  credentialPresentation({
    presented:
      Predicate.isNotNullish(authorization) || hasBetterAuthSessionCredential(cookie ?? null),
    challenge,
  });

/**
 * Runs one Effect-native Web transport operation. Typed failures stay in the
 * error channel, where HttpApiBuilder encodes them against the endpoint's
 * declared problems; the success is the operation's Response.
 */
export const webHandler = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  handle: (request: Request) => Effect.Effect<Response, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.orDie,
    Effect.flatMap(handle),
    Effect.map(HttpServerResponse.fromWeb),
  );

const declaredProblem = <Code extends PlainProblemCode>(
  cause: unknown,
  codes: ReadonlyArray<Code>,
): Effect.Effect<never, Problem<Code>> => {
  const code =
    cause instanceof HttpSemanticFailure
      ? codes.find((declared) => declared === cause.code)
      : undefined;

  return code === undefined ? Effect.die(cause) : Effect.fail(Problem.make(code));
};

/** Runs a throwing semantic parser. Its declared codes become problems; anything else is a defect. */
export const semanticProblem = <A, const Code extends PlainProblemCode>(
  parse: () => A,
  codes: ReadonlyArray<Code>,
): Effect.Effect<A, Problem<Code>> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(parse());
    } catch (cause) {
      return declaredProblem(cause, codes);
    }
  });

/** Narrows an untyped semantic failure channel to its declared codes. */
export const semanticProblems = <A, R, const Code extends PlainProblemCode>(
  effect: Effect.Effect<A, HttpSemanticFailure, R>,
  codes: ReadonlyArray<Code>,
): Effect.Effect<A, Problem<Code>, R> =>
  Effect.catch(effect, (cause) => declaredProblem(cause, codes));

interface TaggedFailure {
  readonly _tag: string;
}

type FailureCases<Failure extends TaggedFailure> = {
  readonly [Tag in Failure["_tag"]]: (failure: Extract<Failure, { readonly _tag: Tag }>) => Problem;
};

type MappedFailure<E, Failure extends TaggedFailure, Cases extends FailureCases<Failure>> =
  | Exclude<E, Failure>
  | ReturnType<Cases[Extract<E, Failure>["_tag"]]>;

/**
 * Builds the one failure-to-problem mapper of a domain. Every tag of `Failure`
 * needs a case, and the mapped error channel keeps only the problems the
 * mapped effect can actually produce. Other failures pass through unchanged,
 * so an unmapped one still reaches, and fails, the endpoint's type check.
 */
export const problemMapper =
  <Failure extends TaggedFailure>() =>
  <const Cases extends FailureCases<Failure>>(
    cases: Cases & { readonly [Extra in Exclude<keyof Cases, Failure["_tag"]>]: never },
  ) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, MappedFailure<E, Failure, Cases>, R> => {
    // `cases` has exactly one handler per `Failure` tag and no other member.
    const handlers = new Map<string, (cause: unknown) => Problem>(Object.entries(cases));

    const mapped = Effect.mapError(effect, (error) => {
      const tag = Predicate.hasProperty(error, "_tag") ? error._tag : undefined;
      const handle = Predicate.isString(tag) ? handlers.get(tag) : undefined;

      return handle === undefined ? error : handle(error);
    });

    // SAFETY: failures with a mapped tag became the problem their case returns; the rest are unchanged.
    return mapped as Effect.Effect<A, MappedFailure<E, Failure, Cases>, R>;
  };

const serializationConflict = (cause: unknown, depth = 0): boolean =>
  depth < 8 &&
  Predicate.isObjectOrArray(cause) &&
  (("code" in cause && (cause.code === "40001" || cause.code === "40P01")) ||
    (Predicate.hasProperty(cause, "reason") &&
      (Predicate.isTagged(cause.reason, "SerializationError") ||
        Predicate.isTagged(cause.reason, "DeadlockError"))) ||
    (Predicate.hasProperty(cause, "cause") && serializationConflict(cause.cause, depth + 1)));

/** HTTP command receipts: the transport's own persistence failures. */
export const commandReceiptProblems = problemMapper<
  NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError
>()({
  NativeHttpReceiptInvalid: () => Problem.make("internal.error"),
  NativeHttpReceiptPersistenceError: (failure) =>
    serializationConflict(failure)
      ? Problem.make("transaction.conflict")
      : Problem.make("idempotency.unavailable"),
});

/** Answers a command receipt outcome: committed and replayed results, or an idempotency problem. */
export const commandOutcomeResponse = (
  outcome: NativeHttpCommandOutcome,
): Effect.Effect<
  Response,
  | Problem<"idempotency.in-flight">
  | Problem<"idempotency.digest-conflict">
  | Problem<"idempotency.response-expired">
> =>
  Match.value(outcome).pipe(
    Match.tag("Committed", "Replay", ({ response }) =>
      Effect.succeed(responseFromCapsule(response)),
    ),
    Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
    Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
    Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
    Match.exhaustive,
  );

/**
 * An anonymous AccessSpec grants every caller and conceals nothing, so a
 * denial means the spec and its scope resolution disagree: a defect.
 */
export const authorizeAnonymous = (
  spec: AccessSpec,
  resolution: CanonicalScopeResolution<Schema.JsonObject>,
  now: string,
): Effect.Effect<void> =>
  authorizeAnonymousNativeOperation(spec, resolution, now).pipe(
    Effect.catch((failure) =>
      Effect.die(new Error(`anonymous access denied with ${failure.code}`)),
    ),
  );

/** A rejected person credential is answered from the ingress evidence, never by string choice. */
export const authorizePerson = (
  input: NativePersonAuthorization,
  presentation: CredentialPresentation,
) =>
  authorizePersonNativeOperation(input).pipe(
    Effect.catch((failure) =>
      Effect.fail(
        Match.value(failure.status).pipe(
          Match.when(401, () => Problem.unauthenticated(presentation)),
          Match.when(404, () => Problem.make("resource.not-found")),
          Match.orElse(() => Problem.make("authority.denied")),
        ),
      ),
    ),
  );

/**
 * Marks problems a shared mapper can produce but this operation cannot, such
 * as a serialization conflict inside a read-only snapshot. Reaching one is a
 * defect, answered by the boundary as internal.error.
 */
export const unreachable =
  <const Code extends NativeProblemCode>(...codes: ReadonlyArray<Code>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, Problem<Code>>, R> => {
    const narrowed = Effect.catch(effect, (error) =>
      isProblem(error) && codes.some((code) => code === error.code)
        ? Effect.die(error)
        : Effect.fail(error),
    );

    // SAFETY: only the listed problems left the error channel; every other failure re-fails unchanged.
    return narrowed as Effect.Effect<A, Exclude<E, Problem<Code>>, R>;
  };

/**
 * The only Cause consumer. HttpApiBuilder has already answered every declared
 * typed failure, so a cause reaching this boundary is a defect, an interrupt,
 * or a failure no endpoint declared. It is reported, then answered with the
 * frozen internal.error problem; a client abort needs no answer.
 */
export const ProblemBoundaryLive = HttpRouter.middleware(
  (httpEffect) =>
    Effect.catchCause(httpEffect, (cause) =>
      Cause.hasInterruptsOnly(cause) &&
      cause.reasons.some((reason) => reason.annotations.has(HttpServerError.ClientAbort.key))
        ? Effect.failCause(cause)
        : ErrorReporter.report(cause).pipe(
            Effect.as(
              HttpServerResponse.fromWeb(problemWebResponse(Problem.make("internal.error"))),
            ),
          ),
    ),
  { global: true },
);
