/**
 * Typed transport failures for native HttpApi handlers. Handlers fail with
 * `Problem` values and HttpApiBuilder encodes them against the endpoint's
 * declared problems, so an undeclared code, an unmapped domain failure, or a
 * credential code chosen without ingress evidence does not compile.
 */
import type { AccessSpec, CanonicalScopeResolution } from "@vektorprogrammet/domain/authz";
import {
  credentialPresentation,
  type CredentialPresentation,
  type IdempotencyKey,
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
import { Cause, Effect, ErrorReporter, type Layer, Match, Predicate, Schema } from "effect";
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  type DerivedHttpIdentity,
  deriveHttpIdentity,
  evaluateMutationPrecondition,
  evaluateReadPreconditions,
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
 * @remarks
 * The body is the JSON text of `problemBody(problem)`, the status is `problem.status`, and the
 * headers are those of `problemHeaders(problem)` with `content-type: application/problem+json`:
 * the answer that HttpApiBuilder encodes for a declared problem. It answers where no endpoint
 * encodes: an origin denial, a method outside the allowed set, an unknown path, and the internal
 * error of `ProblemBoundaryLive`.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const response = problemWebResponse(Problem.make("method.not-allowed"));
 * ```
 *
 * @avoid Building a problem response by hand: its body or headers drift from the frozen encoding
 * that clients decode. Render the `Problem` with this.
 *
 * @construct http-problem
 */
export const problemWebResponse = (problem: Problem): Response =>
  new Response(JSON.stringify(problemBody(problem)), {
    status: problem.status,
    headers: { ...problemHeaders(problem), "content-type": "application/problem+json" },
  });

const JsonText = Schema.fromJsonString(Schema.Unknown);

/**
 * The JSON text of a representation, byte for byte what `JSON.stringify` writes.
 *
 * @remarks
 * It encodes `value` with `Schema.fromJsonString(Schema.Unknown)`. A value that JSON cannot
 * represent, such as a `bigint`, fails the encoding, and the failure becomes a defect, which
 * `ProblemBoundaryLive` answers as internal.error.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * return new Response(yield* jsonText(body), { headers: { "content-type": "application/json" } });
 * ```
 *
 * @avoid `JSON.stringify` in a handler: it throws outside the error channel, and
 * `effecttsgo/prefer-schema-over-json` rejects it. Write the text with `jsonText`.
 *
 * @construct http-problem
 */
export const jsonText = <A>(value: A): Effect.Effect<string> =>
  Schema.encodeEffect(JsonText)(value).pipe(Effect.orDie);

/**
 * Records, from the raw request only, whether person credential material was presented.
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
 * Runs one Effect-native Web transport operation.
 *
 * @remarks
 * It converts the HttpApi request to a Web `Request`, runs `handle`, and converts the `Response`
 * back; a request that does not convert is a defect. The typed failures of `handle` stay in the
 * error channel, where HttpApiBuilder encodes each against the endpoint's declared problems, so a
 * problem that the endpoint does not declare fails its type check.
 *
 * @sideEffects none of its own; it runs `handle`.
 *
 * @example
 * ```ts
 * .handleRaw("readTeamApplication", ({ request, params }) => webHandler(request, (webRequest) => readApplication(webRequest, params.applicationId)))
 * ```
 *
 * @avoid Answering a failure inside `handle` with a hand-built `Response`: HttpApiBuilder then
 * cannot check it against the endpoint's declared problems. Fail with the `Problem`.
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

/**
 * Runs a throwing semantic parser.
 *
 * @remarks
 * `parse` runs when the effect runs. A thrown `Problem` whose code is in `codes` becomes a failure
 * with that code; any other throw, a problem of another code included, is a defect. The HTTP
 * semantic parsers, such as `normalizeTarget`, throw their problems, so an Effect handler calls
 * them through this.
 *
 * @sideEffects none of its own; it runs `parse`.
 *
 * @example
 * ```ts
 * const normalizedTarget = yield* semanticProblem(() => normalizeTarget(routeTemplate, identities), ["request.malformed"]);
 * ```
 *
 * @avoid `Effect.try` with a hand-written catch around a parser: an unexpected throw then becomes
 * a failure that the endpoint does not declare. List the codes that the endpoint declares here.
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
      const code = isProblem(cause) ? codes.find((declared) => declared === cause.code) : undefined;

      return code === undefined ? Effect.die(cause) : Effect.fail(Problem.make(code));
    }
  });

interface TaggedFailure {
  readonly _tag: string;
}

/** One case per tag of `Failure`: the problem that answers a failure with that tag. */
export type ProblemCases<Failure extends TaggedFailure> = {
  readonly [Tag in Failure["_tag"]]: (failure: Extract<Failure, { readonly _tag: Tag }>) => Problem;
};

/** `Cases` with no case for a tag outside `Failure`. */
type ExactCases<Failure extends TaggedFailure, Cases> = Cases & {
  readonly [Extra in Exclude<keyof Cases, Failure["_tag"]>]: never;
};

type MappedFailure<E, Failure extends TaggedFailure, Cases extends ProblemCases<Failure>> =
  | Exclude<E, Failure>
  | ReturnType<Cases[Extract<E, Failure>["_tag"]]>;

/** The mapper that `problemMapper` builds from the cases `Cases` of `Failure`. */
export type ProblemMapper<Failure extends TaggedFailure, Cases extends ProblemCases<Failure>> = <
  A,
  E,
  R,
>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, MappedFailure<E, Failure, Cases>, R>;

/** Cases that answer each failure tagged `Tag` from the credential that the request presented. */
export type CredentialCases<Tag extends string> = {
  readonly [Case in Tag]: () => Problem<"credential.missing"> | Problem<"credential.invalid">;
};

/** Cases that answer each failure tagged `Tag` with the endpoint's unavailable problem `Code`. */
export type OutageCases<Tag extends string, Code extends PlainProblemCode> = {
  readonly [Case in Tag]: () => Problem<Code>;
};

/**
 * Builds the one failure-to-problem mapper of a domain.
 *
 * @remarks
 * `problemMapper<Failure>()(cases)` takes one case per tag of `Failure` and no other key. The
 * mapper maps each failure of an effect whose tag has a case to the problem that its case
 * returns, and it passes every other failure through unchanged, so an unmapped failure still
 * reaches, and fails, the endpoint's type check. The mapped error channel keeps only the problems
 * that the effect's own failures map to. A mapper constant declares its type as
 * `ProblemMapper<Failure, typeof cases>`, with its cases in a constant that `satisfies`
 * `ProblemCases<Failure>`. A mapper that a function builds per request adds `CredentialCases`
 * and `OutageCases` to its constant cases, for the answers that depend on its arguments.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const storedReceiptProblems = problemMapper<ReceiptDecodeError>()({ ReceiptDecodeError: () => Problem.make("receipts.unavailable") });
 * ```
 *
 * @avoid Mapping a domain's failures with `Effect.mapError` or `Effect.catchTag` in each handler:
 * the copies drift apart, so one failure gets different problems on different endpoints. Map each
 * domain once and pipe its mapper.
 *
 * @construct http-problem
 */
export const problemMapper =
  <Failure extends TaggedFailure>(): (<const Cases extends ProblemCases<Failure>>(
    cases: ExactCases<Failure, Cases>,
  ) => ProblemMapper<Failure, Cases>) =>
  <const Cases extends ProblemCases<Failure>>(
    cases: ExactCases<Failure, Cases>,
  ): ProblemMapper<Failure, Cases> =>
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
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- EX-0002: Each failure tag maps to the problem type its case returns; TypeScript cannot index the generic `Cases` by the failure tag to infer that union, so the mapped error channel is asserted once here.
    return mapped as Effect.Effect<A, MappedFailure<E, Failure, Cases>, R>;
  };

/**
 * The values of one request header; an absent header has none.
 */
export const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);

  return value === null ? [] : [value];
};

/**
 * An operation that accepts no query answers any query as malformed.
 *
 * @remarks
 * A request whose URL has a non-empty query fails with request.malformed, so an operation that
 * declares no query parameter never answers as if it had applied one.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* requireNoQuery(request);
 * ```
 *
 * @avoid Ignoring an unexpected query: a client that sends a filter that the operation does not
 * know gets an unfiltered answer that looks filtered. Call it first in an operation without query
 * parameters.
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
 * @remarks
 * A `content-type` that `mediaType` does not match fails with media-type.unsupported before a
 * byte is read. `readBoundedJson` then reads the body: a malformed or too large Content-Length
 * fails at once, the bytes are counted as they arrive and fail with request.too-large past
 * `maxBytes`, and the JSON parses without duplicate member names, else request.malformed. A body
 * that cannot be read is internal.error. It takes the body reader when it is called, not when
 * the effect runs.
 *
 * @sideEffects Reads and consumes the request body.
 *
 * @example
 * ```ts
 * const body = yield* readJsonBody(request, /^application\/json(?:\s*;|$)/iu, MAX_SUBMISSION_BYTES);
 * ```
 *
 * @avoid `request.json()`: it reads without a bound, accepts duplicate member names, and throws
 * outside the error channel. Read the body with this.
 *
 * @construct http-problem
 */
export const readJsonBody = (
  request: Request,
  mediaType: RegExp,
  maxBytes: number,
): Effect.Effect<
  Schema.Json,
  | Problem<"media-type.unsupported">
  | Problem<"request.malformed">
  | Problem<"request.too-large">
  | Problem<"internal.error">
> =>
  mediaType.test(request.headers.get("content-type") ?? "")
    ? readBoundedJson(request, maxBytes)
    : Effect.fail(Problem.make("media-type.unsupported"));

/**
 * Decodes the one Idempotency-Key a replayable mutation requires.
 *
 * @remarks
 * `parseIdempotencyKey` decodes the Idempotency-Key field: exactly one field, with no comma, of
 * the frozen key grammar. A missing, repeated, or malformed key fails with
 * idempotency-key.invalid.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const idempotencyKey = yield* idempotencyKeyOf(request);
 * ```
 *
 * @avoid Reading the field with `request.headers.get` and trimming it: a repeated or malformed key
 * then reaches the command identity. Decode it with this before `httpIdentity`.
 *
 * @construct http-problem
 */
export const idempotencyKeyOf = (
  request: Request,
): Effect.Effect<IdempotencyKey, Problem<"idempotency-key.invalid">> =>
  semanticProblem(
    () => parseIdempotencyKey(headerValues(request, "idempotency-key")),
    ["idempotency-key.invalid"],
  );

/**
 * Decodes the one strong If-Match an item mutation requires.
 *
 * @remarks
 * `parseRequiredIfMatch` decodes the If-Match field: no field fails with precondition.required,
 * and anything but one strong entity tag, such as a weak tag, a list, or `*`, fails with
 * precondition.invalid.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const ifMatch = yield* requiredIfMatchOf(request);
 * ```
 *
 * @avoid Treating a missing If-Match as a match: a client that never read the representation
 * overwrites a concurrent change. Require it, and compare it with `requireCurrentETag`.
 *
 * @construct http-problem
 */
export const requiredIfMatchOf = (
  request: Request,
): Effect.Effect<StrongETag, Problem<"precondition.invalid" | "precondition.required">> =>
  semanticProblem(
    () => parseRequiredIfMatch(headerValues(request, "if-match")),
    ["precondition.required", "precondition.invalid"],
  );

/**
 * Derives a command's idempotency identity; a tuple outside the frozen grammar is a request problem.
 *
 * @remarks
 * It runs `deriveHttpIdentity` through `semanticProblem`: a credential subject, operation id, or
 * target outside its grammar fails with request.malformed, and a key outside its grammar with
 * idempotency-key.invalid. `commandId` and `identitySha256` key the command receipt of the
 * mutation.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const identity = yield* httpIdentity({ credentialSubject: `Person:${personId}`, qualifiedOperationId: operationId, normalizedTarget, idempotencyKey });
 * ```
 *
 * @avoid Calling `deriveHttpIdentity` directly in an Effect handler: its throw escapes the error
 * channel and becomes a defect, internal.error, instead of the declared request problem.
 *
 * @construct http-problem
 */
export const httpIdentity = (
  identity: NativeIdempotencyIdentity,
): Effect.Effect<DerivedHttpIdentity, Problem<"idempotency-key.invalid" | "request.malformed">> =>
  semanticProblem(
    () => deriveHttpIdentity(identity),
    ["request.malformed", "idempotency-key.invalid"],
  );

/**
 * Fails a mutation whose If-Match no longer names the current representation.
 *
 * @remarks
 * `evaluateMutationPrecondition` compares the strong tag of the current representation with the
 * one that If-Match named: equal tags proceed, and different ones fail with precondition.failed.
 * A command runs it in its transaction, after authorization and concealment, on the state that
 * it is about to change.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * service.reviseIntake(command, staff.principal, (current) => requireCurrentETag(intakeETag(teamId, current.revision), ifMatch));
 * ```
 *
 * @avoid Comparing tags before the transaction, as a preflight read: a concurrent change can
 * commit between the check and the write. Compare inside the transaction that writes.
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
 * Answers a conditional JSON read after authority and concealment: the representation, a
 * bodyless 304, or precondition.failed.
 *
 * @remarks
 * It parses If-Match and If-None-Match, and a field outside their grammar fails with
 * precondition.invalid. An If-Match without the current strong tag fails with
 * precondition.failed. An If-None-Match that names the current tag, or `*`, answers a bodyless 304
 * with the tag, the cache policy, and `Vary: Origin`. Otherwise it answers 200 with the JSON text
 * of `body` and the same headers.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * return yield* conditionalJson({ request, body, etag, cacheControl: PRIVATE_NO_STORE, contentType: "application/json" });
 * ```
 *
 * @avoid Evaluating the conditions before authorization and concealment: a 304 or 412 then tells a
 * caller that a resource it may not see exists. Answer the read with this, last.
 *
 * @construct http-problem
 */
export const conditionalJson = (input: {
  readonly request: Request;
  readonly body: unknown;
  readonly etag: StrongETag;
  readonly cacheControl: string;
  readonly contentType: "application/json" | "application/json; charset=utf-8";
}): Effect.Effect<Response, Problem<"precondition.failed"> | Problem<"precondition.invalid">> =>
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
      return yield* Problem.make("precondition.failed");
    }

    if (Predicate.isTagged(decision, "NotModified")) {
      return notModifiedResponse({
        etag: input.etag,
        cacheControl: input.cacheControl,
        vary: "Origin",
      });
    }

    return new Response(yield* jsonText(input.body), {
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
 * @remarks
 * It classifies the raw request once: an Authorization field or a Better Auth session cookie
 * counts as presented, whatever its validity. `Problem.unauthenticated` answers this evidence with
 * credential.missing for an absent credential and credential.invalid for a presented one, with
 * `challenge` in `WWW-Authenticate`; the default challenge names the native session cookie and
 * bearer tokens.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const presentation = personPresentation(request);
 * ```
 *
 * @avoid Choosing credential.missing or credential.invalid by string: a request that sent a
 * rejected token would be told that it sent none. Answer a rejected credential from this evidence
 * with `Problem.unauthenticated`.
 *
 * @construct http-problem
 */
export const personPresentation = (
  request: Request,
  challenge: string = nativeUserChallenges(),
): CredentialPresentation =>
  classifyCredential(
    request.headers.get("authorization"),
    request.headers.get("cookie"),
    challenge,
  );

/**
 * Whether a failure, or one of its causes, is a lost serialization or deadlock race: a
 * transaction.conflict the client may retry.
 *
 * @remarks
 * It follows `cause` through its `cause` members, at most eight levels deep. A `code` of SQLSTATE
 * 40001 (serialization failure) or 40P01 (deadlock detected), or a `reason` tagged
 * `SerializationError` or `DeadlockError`, is such a race.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * isSerializationConflict(failure) ? Problem.make("transaction.conflict") : failure;
 * ```
 *
 * @avoid Matching SQLSTATEs or messages in each handler: a race that a wrapper carries one level
 * deeper then answers internal.error instead of a retryable conflict. Classify it with this.
 *
 * @construct http-problem
 */
export const isSerializationConflict = (cause: unknown, depth: number = 0): boolean =>
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
 * @remarks
 * It is validation.failed with one diagnostic, code `invalid`, at the root pointer `""`. A domain
 * that decodes a whole command at once cannot name the member that failed, so it answers this.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * AdmissionPeriodDecodeError: requestInvalid,
 * ```
 *
 * @avoid Echoing the schema issue, or pointing at a guessed member: the answer then leaks decoding
 * internals or misleads the client. Answer the whole request with this, or build
 * `Problem.validation` with the pointers that the decoder knows.
 *
 * @construct http-problem
 */
export const requestInvalid = (): Problem<"validation.failed"> =>
  Problem.validation("validation.failed", [makeNativeValidationError("", "invalid")]);

/**
 * Decodes one JSON request value strictly; any mismatch fails the whole request's validation.
 *
 * @remarks
 * It decodes `value` with `schema` and rejects excess properties (`onExcessProperty: "error"`).
 * Any mismatch fails with `requestInvalid()`: one validation.failed problem for the request.
 *
 * @sideEffects none of its own; it runs the decoding services of `schema`.
 *
 * @example
 * ```ts
 * const body = yield* decodeRequest(CreateSocialEventRequest)(json);
 * ```
 *
 * @avoid Decoding a request with the default options of `Schema.decodeUnknownEffect`: excess
 * properties then pass silently, and the schema error is a failure that the endpoint does not
 * declare. Decode request values with this.
 *
 * @construct http-problem
 */
export const decodeRequest =
  <S extends Schema.ConstraintDecoder<unknown, never>>(
    schema: S,
  ): ((
    value: Schema.Json,
  ) => Effect.Effect<S["Type"], Problem<"validation.failed">, S["DecodingServices"]>) =>
  (value: Schema.Json) =>
    Schema.decodeEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(requestInvalid),
    );

/**
 * Decodes one response value strictly.
 *
 * @remarks
 * It decodes the value that a handler is about to answer with the response schema and rejects
 * excess properties, so a private field that the domain value carries cannot reach the response.
 * A mismatch is a defect, which `ProblemBoundaryLive` answers as internal.error.
 *
 * @sideEffects none of its own; it runs the decoding services of `schema`.
 *
 * @example
 * ```ts
 * return yield* strictOutput(SocialEventListResource)(body);
 * ```
 *
 * @avoid Answering a domain value as it is, or through a spread: its private fields then reach the
 * client. Decode it with the response schema first.
 *
 * @construct http-problem
 */
export const strictOutput =
  <S extends Schema.ConstraintDecoder<unknown, never>>(
    schema: S,
  ): ((value: S["Type"]) => Effect.Effect<S["Type"], never, S["DecodingServices"]>) =>
  (value: S["Type"]) =>
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(Effect.orDie);

const commandReceiptCases = {
  NativeHttpReceiptInvalid: () => Problem.make("internal.error"),
  NativeHttpReceiptPersistenceError: (failure: NativeHttpReceiptPersistenceError) =>
    isSerializationConflict(failure)
      ? Problem.make("transaction.conflict")
      : Problem.make("idempotency.unavailable"),
} satisfies ProblemCases<NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError>;

/**
 * HTTP command receipts: the transport's own persistence failures.
 *
 * @remarks
 * An invalid stored receipt answers internal.error. A receipt persistence failure answers
 * transaction.conflict when it lost a serialization race, and idempotency.unavailable otherwise.
 * A replayable mutation pipes its command effect through its domain mapper, then through this.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * command.pipe(teamApplicationProblems, commandReceiptProblems);
 * ```
 *
 * @avoid Mapping receipt failures in a domain mapper: each domain would answer the transport's own
 * failures differently. Pipe this after the domain's mapper.
 *
 * @construct http-problem
 */
export const commandReceiptProblems: ProblemMapper<
  NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError,
  typeof commandReceiptCases
> = problemMapper<NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError>()(
  commandReceiptCases,
);

/**
 * Answers a command receipt outcome: committed and replayed results, or an idempotency problem.
 *
 * @remarks
 * A committed or replayed outcome answers its stored response capsule with
 * `Cache-Control: no-store`, so a replay returns the status, bytes, and headers of the first
 * answer. A command that still runs under the key fails with idempotency.in-flight, a key reused
 * for another request with idempotency.digest-conflict, and a response that is no longer kept
 * with idempotency.response-expired.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * return yield* commandOutcomeResponse(outcome);
 * ```
 *
 * @avoid Rebuilding the response of a replay from the current state: a retry then sees another
 * answer than the first attempt. Answer every outcome through this.
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
 * An anonymous AccessSpec grants every caller and conceals nothing, so a denial means the spec and
 * its scope resolution disagree: a defect.
 *
 * @remarks
 * It evaluates `spec` for the anonymous principal, with no grants, over `resolution` at `now`. A
 * public operation calls it with the scope that it resolved, so the AccessSpec of the contract
 * stays the one authority. A denial dies with the HTTP status of the evaluation.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizeAnonymous(Option.getOrThrow(reflectAccessSpec(ReadTeamApplicationIntakeEndpoint)), resolution, instant);
 * ```
 *
 * @avoid Skipping the evaluation because the operation is public: the declared AccessSpec and the
 * handler then drift apart unnoticed. Evaluate it, so that a mismatch is a defect.
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
      Effect.die(new Error(`anonymous access denied with HTTP ${failure.status}`)),
    ),
  );

/**
 * A rejected person credential is answered from the ingress evidence, never by string choice.
 *
 * @remarks
 * It evaluates the AccessSpec of `input` for the person, with a grant for each capability of the
 * spec in each grant scope. An evaluation of 401 answers `Problem.unauthenticated(presentation)`,
 * 404 answers resource.not-found for a concealed resource, and 403 answers authority.denied. An
 * operation whose spec reveals every denial pipes `unreachable("resource.not-found")` after it.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizePerson({ spec, credential: authorization.credential, personId, resolution, grantScopes, now }, personPresentation(request));
 * ```
 *
 * @avoid Choosing the answer to a denial in the handler: a concealed resource would answer 403
 * and reveal that it exists, or a credential answer would ignore the ingress evidence. Map the
 * evaluation with this.
 *
 * @construct http-problem
 */
export const authorizePerson = (
  input: NativePersonAuthorization,
  presentation: CredentialPresentation,
): Effect.Effect<
  void,
  | Problem<"authority.denied">
  | Problem<"credential.invalid">
  | Problem<"credential.missing">
  | Problem<"resource.not-found">
> =>
  authorizePersonNativeOperation(input).pipe(
    Effect.mapError((failure) =>
      Match.value(failure.status).pipe(
        Match.when(401, () => Problem.unauthenticated(presentation)),
        Match.when(404, () => Problem.make("resource.not-found")),
        Match.orElse(() => Problem.make("authority.denied")),
      ),
    ),
  );

/**
 * Marks problems a shared mapper can produce but this operation cannot, such as a serialization
 * conflict inside a read-only snapshot.
 *
 * @remarks
 * It turns each failure that is a problem with one of the listed codes into a defect, which
 * `ProblemBoundaryLive` answers as internal.error, and removes those problems from the error
 * channel, so the endpoint need not declare them. At least one code is required: an empty list
 * would widen `Code` to every code and erase every problem.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * authorizePerson(input, presentation).pipe(unreachable("resource.not-found"));
 * ```
 *
 * @avoid Declaring a problem on an endpoint only because a shared mapper can produce it: the
 * contract then promises an answer that the operation never gives. Mark it unreachable here.
 *
 * @construct http-problem
 */
export const unreachable =
  <const Code extends NativeProblemCode>(
    code: Code,
    ...codes: ReadonlyArray<Code>
  ): (<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, Exclude<E, Extract<E, Problem<Code>>>, R>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const listed: ReadonlyArray<NativeProblemCode> = [code, ...codes];

    // Inferred apart from the declared return type, which would select another overload of catchIf.
    const unlisted = Effect.catchIf(
      effect,
      (error): error is Extract<E, Problem<Code>> =>
        isProblem(error) && listed.includes(error.code),
      (error) => Effect.die(error),
    );

    return unlisted;
  };

/**
 * The only Cause consumer.
 *
 * @remarks
 * A global router middleware. HttpApiBuilder has already answered every declared typed failure, so
 * a cause that reaches this boundary is a defect, an interrupt, or a failure that no endpoint
 * declared. It reports the cause through `ErrorReporter` and answers the frozen internal.error
 * problem. A cause of interrupts only that a client abort annotates passes through unanswered,
 * because the client is gone.
 *
 * @sideEffects Reports each cause that it answers through `ErrorReporter`.
 *
 * @example
 * ```ts
 * return Layer.mergeAll(nativeRoutes, notFound, ProblemBoundaryLive);
 * ```
 *
 * @avoid Catching defects or rendering causes in a handler or another middleware: a cause then
 * reaches the client, or a fault goes unreported. Leave causes to this boundary.
 *
 * @construct http-problem
 */
export const ProblemBoundaryLive: Layer.Layer<never, never, HttpRouter.HttpRouter> =
  HttpRouter.middleware(
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
