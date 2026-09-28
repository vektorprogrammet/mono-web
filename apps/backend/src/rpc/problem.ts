/**
 * Typed failures and command primitives of the native RPC handlers. A handler fails with `Problem`
 * values, and each RPC encodes them against its declared problem union (`rpcProblems`), so an
 * undeclared code, an unmapped domain failure, or a credential code chosen without ingress evidence
 * does not compile.
 */
import type { AccessSpec, CanonicalScopeResolution } from "@vektorprogrammet/domain/authz";
import { ProblemBoundary } from "@vektorprogrammet/rpc";
import {
  credentialPresentation,
  type CredentialPresentation,
  isProblem,
  makeNativeValidationError,
  type NativeProblemCode,
  nativeUserChallenges,
  type PlainProblemCode,
  Problem,
  type StrongETag,
} from "@vektorprogrammet/rpc/problem";
import { Cause, Effect, ErrorReporter, Layer, Match, Predicate, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  type DerivedHttpIdentity,
  deriveHttpIdentity,
  evaluateMutationPrecondition,
  type NativeIdempotencyIdentity,
} from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  authorizePersonNativeOperation,
  type NativePersonAuthorization,
} from "../native-operation.js";
import { hasBetterAuthSessionCredential } from "../session-security.js";
import {
  decodeStoredSuccess,
  type NativeHttpCommandOutcome,
  type NativeHttpReceiptInvalid,
  type NativeHttpReceiptPersistenceError,
} from "./receipt-transaction.js";

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
 * @construct rpc-problem
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
 * @construct rpc-problem
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
 * @construct rpc-problem
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
 * Derives a command's idempotency identity: the receipt digest and the domain command ID.
 *
 * @remarks
 * It runs `deriveHttpIdentity` over the credential subject, the operation id, the normalized
 * target, and the idempotency key. The RPC payload schema has already decoded the key, and a
 * handler passes its operation id and the path of the HTTP route it replaced as constants, so a
 * tuple outside the grammar is a defect. Keeping the old path keeps the receipts and command IDs
 * of commands that straddle the cutover stable.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const identity = yield* commandIdentity({ credentialSubject: `Person:${personId}`, qualifiedOperationId: "social-events.create", normalizedTarget: "/api/social-events", idempotencyKey });
 * ```
 *
 * @avoid Deriving a new target from the RPC tag: a replay across the cutover then misses its
 * receipt, and the domain command runs twice. Pass the old route path.
 *
 * @construct rpc-problem
 */
export const commandIdentity = (
  identity: NativeIdempotencyIdentity,
): Effect.Effect<DerivedHttpIdentity> =>
  // The payload schema already decoded the key, and the operation and target are constants, so a
  // throw here is a defect.
  Effect.sync(() => deriveHttpIdentity(identity));

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
 * @construct rpc-problem
 */
export const requireCurrentETag = (
  current: StrongETag,
  ifMatch: StrongETag,
): Effect.Effect<void, Problem<"precondition.failed">> =>
  Predicate.isTagged(evaluateMutationPrecondition(current, ifMatch), "Failed")
    ? Effect.fail(Problem.make("precondition.failed"))
    : Effect.void;

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
 * @construct rpc-problem
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
 * @construct rpc-problem
 */
export const requestInvalid = (): Problem<"validation.failed"> =>
  Problem.validation("validation.failed", [makeNativeValidationError("", "invalid")]);

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
 * @construct rpc-problem
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
 * @construct rpc-problem
 */
export const commandReceiptProblems: ProblemMapper<
  NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError,
  typeof commandReceiptCases
> = problemMapper<NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError>()(
  commandReceiptCases,
);

/**
 * The credential evidence of an RPC request: which credential headers it presented.
 *
 * @remarks
 * `authorizePerson` answers a credential rejection from this evidence, never by string choice.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizePerson(input, personPresentation(headers));
 * ```
 *
 * @avoid Deciding between credential.missing and credential.invalid in a handler. Pass this.
 *
 * @construct rpc-problem
 */
export const personPresentation = (
  headers: Headers.Headers,
  challenge: string = nativeUserChallenges(),
): CredentialPresentation => classifyCredential(headers.authorization, headers.cookie, challenge);

/**
 * The value of a command receipt outcome: the committed or replayed success, or an idempotency
 * problem.
 *
 * @remarks
 * A committed or replayed outcome answers the success that its receipt stores, decoded with the
 * RPC's success schema, so a replay returns the value of the first answer. A command that still
 * runs under the key fails with idempotency.in-flight, a key reused for another request with
 * idempotency.digest-conflict, and a result that is no longer kept with
 * idempotency.response-expired.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * return yield* commandOutcome(SocialEventResource)(outcome);
 * ```
 *
 * @avoid Rebuilding the result of a replay from the current state: a retry then sees another
 * answer than the first attempt. Answer every outcome through this.
 *
 * @construct rpc-problem
 */
export const commandOutcome =
  <S extends Schema.Codec<unknown, unknown, never, never>>(success: S) =>
  (
    outcome: NativeHttpCommandOutcome,
  ): Effect.Effect<
    S["Type"],
    | Problem<"idempotency.in-flight">
    | Problem<"idempotency.digest-conflict">
    | Problem<"idempotency.response-expired">
  > =>
    Match.value(outcome).pipe(
      Match.tag("Committed", "Replay", ({ response }) => decodeStoredSuccess(success, response)),
      Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
      Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
      Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
      Match.exhaustive,
    );

/**
 * The implementation of the `ProblemBoundary` middleware that every native RPC runs inside.
 *
 * @remarks
 * A cause with a typed failure, or of interrupts only, passes through unchanged. Any other cause
 * is a defect: it is reported through `ErrorReporter` and answered as internal.error, so no
 * defect, stack, or message reaches a client.
 *
 * @sideEffects Reports each defect that it answers through `ErrorReporter`.
 *
 * @example
 * ```ts
 * RpcServer.layerHttp({ group: NativeRpcs, path: nativeRpcPath, protocol: "http" }).pipe(Layer.provide(ProblemBoundaryLive));
 * ```
 *
 * @avoid Catching defects or rendering causes in a handler. Leave causes to this boundary.
 *
 * @construct rpc-problem
 */
export const ProblemBoundaryLive = Layer.succeed(ProblemBoundary)(
  ProblemBoundary.of((effect) =>
    Effect.catchCause(effect, (cause) =>
      Cause.hasFails(cause) || Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : ErrorReporter.report(cause).pipe(
            Effect.andThen(Effect.fail(Problem.make("internal.error"))),
          ),
    ),
  ),
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
 * @construct rpc-problem
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
 * @construct rpc-problem
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
 * @construct rpc-problem
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
