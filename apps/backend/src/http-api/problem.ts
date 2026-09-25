/**
 * Typed transport failures for native HttpApi handlers. Handlers fail with
 * `Problem` values and HttpApiBuilder encodes them against the endpoint's
 * declared problems, so an undeclared code, an unmapped domain failure, or a
 * credential code chosen without ingress evidence does not compile.
 *
 * @construct http-problem
 */
import type { AccessSpec, CanonicalScopeResolution } from "@vektorprogrammet/domain/authz";
import {
  credentialPresentation,
  type CredentialPresentation,
  isProblem,
  makeNativeValidationError,
  type NativeProblemCode,
  nativeUserChallenges,
  type PlainProblemCode,
  Problem,
  problemBody,
  problemHeaders,
  type StrongETag,
} from "@vektorprogrammet/http-api/http-semantics";
import { Cause, Effect, ErrorReporter, Match, Predicate, Schema } from "effect";
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  deriveHttpIdentity,
  evaluateMutationPrecondition,
  evaluateReadPreconditions,
  HttpSemanticFailure,
  type NativeIdempotencyIdentity,
  notModifiedResponse,
  parseIdempotencyKey,
  parseIfNoneMatch,
  parseReadIfMatch,
  parseRequiredIfMatch,
  responseFromCapsule,
} from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  authorizePersonNativeOperation,
  type NativePersonAuthorization,
} from "../native-operation.js";
import { hasBetterAuthSessionCredential } from "../session-security.js";
import { readBoundedJson } from "./read-json.js";
import type {
  NativeHttpCommandOutcome,
  NativeHttpReceiptInvalid,
  NativeHttpReceiptPersistenceError,
} from "./receipt-transaction.js";

/**
 * Renders one problem outside HttpApi encoding, with the encoder's body and headers.
 *
 * @construct http-problem
 */
export const problemWebResponse = (problem: Problem): Response =>
  new Response(JSON.stringify(problemBody(problem)), {
    status: problem.status,
    headers: { ...problemHeaders(problem), "content-type": "application/problem+json" },
  });

/**
 * Records, from the raw request only, whether person credential material was presented.
 *
 * @construct http-problem
 */
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
 *
 * @construct http-problem
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

/**
 * Runs a throwing semantic parser. Its declared codes become problems; anything else is a defect.
 *
 * @construct http-problem
 */
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

/**
 * Narrows an untyped semantic failure channel to its declared codes.
 *
 * @construct http-problem
 */
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
 *
 * @construct http-problem
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

/**
 * The values of one request header; an absent header has none.
 *
 * @construct http-problem
 */
export const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);

  return value === null ? [] : [value];
};

/**
 * An operation that accepts no query answers any query as malformed.
 *
 * @construct http-problem
 */
export const requireNoQuery = (
  request: Request,
): Effect.Effect<void, Problem<"request.malformed">> =>
  new URL(request.url).search === "" ? Effect.void : Effect.fail(Problem.make("request.malformed"));

/**
 * Reads a bounded JSON body of the one media type `mediaType` accepts.
 *
 * @construct http-problem
 */
export const readJsonBody = (request: Request, mediaType: RegExp, maxBytes: number) =>
  mediaType.test(request.headers.get("content-type") ?? "")
    ? semanticProblems(readBoundedJson(request, maxBytes), [
        "request.malformed",
        "request.too-large",
        "internal.error",
      ])
    : Effect.fail(Problem.make("media-type.unsupported"));

/**
 * Decodes the one Idempotency-Key a replayable mutation requires.
 *
 * @construct http-problem
 */
export const idempotencyKeyOf = (request: Request) =>
  semanticProblem(
    () => parseIdempotencyKey(headerValues(request, "idempotency-key")),
    ["idempotency-key.invalid"],
  );

/**
 * Decodes the one strong If-Match an item mutation requires.
 *
 * @construct http-problem
 */
export const requiredIfMatchOf = (request: Request) =>
  semanticProblem(
    () => parseRequiredIfMatch(headerValues(request, "if-match")),
    ["precondition.required", "precondition.invalid"],
  );

/**
 * Derives a command's idempotency identity; a tuple outside the frozen grammar is a request problem.
 *
 * @construct http-problem
 */
export const httpIdentity = (identity: NativeIdempotencyIdentity) =>
  semanticProblem(
    () => deriveHttpIdentity(identity),
    ["request.malformed", "idempotency-key.invalid"],
  );

/**
 * Fails a mutation whose If-Match no longer names the current representation.
 *
 * @construct http-problem
 */
export const requireCurrentETag = (
  current: StrongETag,
  ifMatch: StrongETag,
): Effect.Effect<void, Problem<"precondition.failed">> =>
  Predicate.isTagged(evaluateMutationPrecondition(current, ifMatch), "Failed")
    ? Effect.fail(Problem.make("precondition.failed"))
    : Effect.void;

/**
 * Answers a conditional JSON read after authority and concealment: the
 * representation, a bodyless 304, or precondition.failed.
 *
 * @construct http-problem
 */
export const conditionalJson = (input: {
  readonly request: Request;
  readonly body: unknown;
  readonly etag: StrongETag;
  readonly cacheControl: string;
  readonly contentType: "application/json" | "application/json; charset=utf-8";
}) =>
  Effect.gen(function* () {
    const conditions = yield* semanticProblem(
      () => ({
        ifMatch: parseReadIfMatch(headerValues(input.request, "if-match")),
        ifNoneMatch: parseIfNoneMatch(headerValues(input.request, "if-none-match")),
      }),
      ["precondition.invalid"],
    );

    const decision = evaluateReadPreconditions({ currentETag: input.etag, ...conditions });

    if (Predicate.isTagged(decision, "Failed")) {
      return yield* Effect.fail(Problem.make("precondition.failed"));
    }

    if (Predicate.isTagged(decision, "NotModified")) {
      return notModifiedResponse({
        etag: input.etag,
        cacheControl: input.cacheControl,
        vary: "Origin",
      });
    }

    return new Response(JSON.stringify(input.body), {
      status: 200,
      headers: {
        "cache-control": input.cacheControl,
        "content-type": input.contentType,
        etag: input.etag,
        vary: "Origin",
      },
    });
  });

/**
 * The person credential a request presented, for a rejection answered after ingress.
 *
 * @construct http-problem
 */
export const personPresentation = (request: Request, challenge: string = nativeUserChallenges()) =>
  classifyCredential(
    request.headers.get("authorization"),
    request.headers.get("cookie"),
    challenge,
  );

/**
 * Whether a failure, or one of its causes, is a lost serialization or
 * deadlock race: a transaction.conflict the client may retry.
 *
 * @construct http-problem
 */
export const isSerializationConflict = (cause: unknown, depth = 0): boolean =>
  depth < 8 &&
  Predicate.isObjectOrArray(cause) &&
  (("code" in cause && (cause.code === "40001" || cause.code === "40P01")) ||
    (Predicate.hasProperty(cause, "reason") &&
      (Predicate.isTagged(cause.reason, "SerializationError") ||
        Predicate.isTagged(cause.reason, "DeadlockError"))) ||
    (Predicate.hasProperty(cause, "cause") && isSerializationConflict(cause.cause, depth + 1)));

/**
 * The request as a whole fails validation; no single member is singled out.
 *
 * @construct http-problem
 */
export const requestInvalid = () =>
  Problem.validation("validation.failed", [makeNativeValidationError("", "invalid")]);

/**
 * Decodes one JSON request value strictly; any mismatch fails the whole request's validation.
 *
 * @construct http-problem
 */
export const decodeRequest =
  <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  (value: Schema.Json) =>
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(requestInvalid),
    );

/**
 * Decodes one response value strictly. A domain value that does not fit its
 * representation is a defect, answered by the boundary as internal.error.
 *
 * @construct http-problem
 */
export const strictOutput =
  <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  (value: S["Type"]) =>
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(Effect.orDie);

/**
 * HTTP command receipts: the transport's own persistence failures.
 *
 * @construct http-problem
 */
export const commandReceiptProblems = problemMapper<
  NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError
>()({
  NativeHttpReceiptInvalid: () => Problem.make("internal.error"),
  NativeHttpReceiptPersistenceError: (failure) =>
    isSerializationConflict(failure)
      ? Problem.make("transaction.conflict")
      : Problem.make("idempotency.unavailable"),
});

/**
 * Answers a command receipt outcome: committed and replayed results, or an idempotency problem.
 *
 * @construct http-problem
 */
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
 *
 * @construct http-problem
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

/**
 * A rejected person credential is answered from the ingress evidence, never by string choice.
 *
 * @construct http-problem
 */
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
 *
 * @construct http-problem
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
 *
 * @construct http-problem
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
