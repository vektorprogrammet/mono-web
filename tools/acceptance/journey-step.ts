import { Effect, FileSystem, type PlatformError, Schema } from "effect";
import { dual } from "effect/Function";
import type { HttpClientResponse } from "effect/unstable/http";

/** A rejection of the promise-based driver code, such as Playwright or `pg`, that a journey step awaited. */
export class JourneyStepFailed extends Schema.TaggedError<JourneyStepFailed>()(
  "JourneyStepFailed",
  { cause: Schema.Defect() },
) {}

/**
 * Runs one call of promise-based driver code as a journey step. A rejection fails the step with
 * the original rejection as its cause, so the entry reports the same error that the driver raised.
 */
export const step = <P extends PromiseLike<unknown>>(
  evaluate: () => P,
): Effect.Effect<Awaited<P>, JourneyStepFailed> =>
  Effect.tryPromise({
    try: () => Promise.resolve(evaluate()),
    catch: (cause) => JourneyStepFailed.make({ cause }),
  });

/**
 * Fails a program with the original rejection of a failed step, as a defect, so that a Promise
 * caller receives the same error that the driver raised.
 */
export const surfaceStepFailure = <A, E, R>(
  effect: Effect.Effect<A, E | JourneyStepFailed, R>,
): Effect.Effect<A, Exclude<E, JourneyStepFailed>, R> =>
  // SAFETY: the predicate catches every JourneyStepFailed, so none remains in the error channel.
  effect.pipe(
    Effect.catchIf(Schema.is(JourneyStepFailed), (failed) => Effect.die(failed.cause)),
  ) as Effect.Effect<A, Exclude<E, JourneyStepFailed>, R>;

/** A connection that a pool lends and takes back, as `pg` `PoolClient` does. */
interface LentConnection {
  readonly query: (text: string, values?: ReadonlyArray<unknown>) => PromiseLike<object>;
  readonly release: () => void;
}

type Queryable = Pick<LentConnection, "query">;

interface ConnectionPool {
  readonly connect: () => PromiseLike<LentConnection>;
}

/** The connection type that a pool lends. */
type LentBy<P extends ConnectionPool> = Awaited<ReturnType<P["connect"]>>;

/** Borrows one pool connection for the use, and returns it to the pool however the use ends. */
export const withPoolClient: {
  <P extends ConnectionPool, A, E, R>(
    use: (client: LentBy<P>) => Effect.Effect<A, E, R>,
  ): (pool: P) => Effect.Effect<A, E | JourneyStepFailed, R>;
  <P extends ConnectionPool, A, E, R>(
    pool: P,
    use: (client: LentBy<P>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | JourneyStepFailed, R>;
} = dual(
  2,
  <P extends ConnectionPool, A, E, R>(
    pool: P,
    use: (client: LentBy<P>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | JourneyStepFailed, R> =>
    Effect.acquireUseRelease(
      // SAFETY: `connect` of the pool type P answers ReturnType<P["connect"]>, which awaits to LentBy<P>.
      step(() => pool.connect() as PromiseLike<LentBy<P>>),
      use,
      (client) => Effect.sync(() => client.release()),
    ),
);

/**
 * Runs the body in a transaction of the connection: it commits after the body succeeds, and rolls
 * back when the body or the commit fails, which then fails with the original cause.
 */
export const committed: {
  <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ): (client: Queryable) => Effect.Effect<A, E | JourneyStepFailed, R>;
  <A, E, R>(
    client: Queryable,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | JourneyStepFailed, R>;
} = dual(
  2,
  <A, E, R>(
    client: Queryable,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | JourneyStepFailed, R> =>
    step(() => client.query("BEGIN")).pipe(
      Effect.andThen(
        body.pipe(
          Effect.tap(() => step(() => client.query("COMMIT"))),
          Effect.onError(() => step(() => client.query("ROLLBACK")).pipe(Effect.ignore)),
        ),
      ),
    ),
);

/** Runs the body in a transaction of the connection that always rolls back. */
export const rolledBack: {
  <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ): (client: Queryable) => Effect.Effect<A, E | JourneyStepFailed, R>;
  <A, E, R>(
    client: Queryable,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | JourneyStepFailed, R>;
} = dual(
  2,
  <A, E, R>(
    client: Queryable,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | JourneyStepFailed, R> =>
    step(() => client.query("BEGIN")).pipe(
      Effect.andThen(body),
      Effect.ensuring(step(() => client.query("ROLLBACK")).pipe(Effect.ignore)),
    ),
);

const CompactJson = Schema.fromJsonString(Schema.Unknown);

const IndentedJson = Schema.fromJsonString(Schema.Unknown, { space: 2 });

/** The JSON text of a value, the bytes that `JSON.stringify(value)` writes. */
export const jsonText = <A>(value: A): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(CompactJson)(value);

type EvidenceWrite = Effect.Effect<
  void,
  Schema.SchemaError | PlatformError.PlatformError,
  FileSystem.FileSystem
>;

/** Writes the evidence file of a journey: the JSON text of the value, indented by two, and a newline. */
export const writeEvidence: {
  <A>(value: A): (path: string) => EvidenceWrite;
  <A>(path: string, value: A): EvidenceWrite;
} = dual(
  2,
  <A>(path: string, value: A): EvidenceWrite =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* Schema.encodeEffect(IndentedJson)(value);

      yield* fs.writeFileString(path, `${text}\n`);
    }),
);

/** The `name=value` pair of the first cookie that a response sets, in the order of its headers. */
export const firstSetCookie = (response: HttpClientResponse.HttpClientResponse) => {
  const [first] = Object.values(response.cookies.cookies);

  return first === undefined ? undefined : `${first.name}=${first.valueEncoded}`;
};
