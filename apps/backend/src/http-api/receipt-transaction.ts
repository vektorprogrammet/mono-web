import { Schema, Predicate, Data, Effect } from "effect";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { Database, type DatabaseOperations } from "@vektorprogrammet/database";

const sha256Pattern = /^[a-f0-9]{64}$/u;

const operationPattern =
  /^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?:\.[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)+$/u;

const allowedHeaders = {
  "content-type": true,
  etag: true,
  location: true,
  "retry-after": true,
} as const;

export interface NativeHttpReceiptIdentity {
  readonly identitySha256: string;
  readonly requestSha256: string;
  readonly operationId: string;
}

export interface NativeHttpResponseCapsule {
  readonly status: number;
  readonly mediaType: string | null;
  readonly bodyBytes: Uint8Array<ArrayBuffer> | null;
  readonly headers: Readonly<Record<string, string>>;
}

export interface NativeHttpCommandPlan<E, R> {
  readonly identity: NativeHttpReceiptIdentity;
  readonly execute: Effect.Effect<NativeHttpResponseCapsule, E, R | Database>;
}

/**
 * Retry modes re-execute `prepare` and `execute` once after rollback. The
 * unique-constraint mode is for a command-specific idempotency collision whose
 * winning transaction becomes visible only after this transaction restarts.
 * Callers must keep both effects rollback-safe and limited to database/outbox
 * work.
 */
export type NativeHttpCommandExecutionOptions =
  | {
      readonly retry?: undefined;
      readonly retryUniqueConstraints?: never;
    }
  | {
      readonly retry: "serialization-once";
      readonly retryUniqueConstraints?: never;
    }
  | {
      readonly retry: "serialization-or-unique-once";
      readonly retryUniqueConstraints: readonly [string, ...ReadonlyArray<string>];
    };

const isRetryableCommandRace = (
  cause: unknown,
  retryUniqueConstraints: ReadonlySet<string>,
  seen = new Set<object>(),
): boolean => {
  if (cause === null || !(cause === null || Predicate.isObjectOrArray(cause)) || seen.has(cause))
    return false;
  seen.add(cause);

  if (isSqlError(cause)) {
    return (
      Predicate.isTagged(cause.reason, "SerializationError") ||
      Predicate.isTagged(cause.reason, "DeadlockError") ||
      (Predicate.isTagged(cause.reason, "UniqueViolation") &&
        retryUniqueConstraints.has(cause.reason.constraint))
    );
  }

  if (!("cause" in cause)) return false;

  return isRetryableCommandRace(cause.cause, retryUniqueConstraints, seen);
};

interface NativeHttpReceiptRow {
  readonly requestSha256: string;
  readonly operationId: string;
  readonly state: "Complete" | "Tombstone";
  readonly status: number | null;
  readonly mediaType: string | null;
  // PostgreSQL bytea decoding allocates an ArrayBuffer-backed Buffer.
  readonly bodyBytes: Uint8Array<ArrayBuffer> | null;
  readonly headers: unknown;
}

interface LockRow {
  readonly acquired: boolean;
}

interface RedactionCountRow {
  readonly count: number;
}

export type NativeHttpCommandOutcome =
  | { readonly _tag: "Committed"; readonly response: NativeHttpResponseCapsule }
  | { readonly _tag: "Replay"; readonly response: NativeHttpResponseCapsule }
  | { readonly _tag: "InFlight"; readonly retryAfterSeconds: 1 }
  | { readonly _tag: "DigestConflict" }
  | { readonly _tag: "ResponseExpired" };

export const NativeHttpCommandOutcome = Data.taggedEnum<NativeHttpCommandOutcome>();

export class NativeHttpReceiptInvalid extends Data.TaggedError("NativeHttpReceiptInvalid")<{
  readonly reason: string;
}> {}

export class NativeHttpReceiptPersistenceError extends Data.TaggedError(
  "NativeHttpReceiptPersistenceError",
)<{
  readonly operation: "execute" | "redact" | "invitation-receipt";
  readonly cause: unknown;
}> {}

const validateIdentity = (identity: NativeHttpReceiptIdentity): void => {
  if (!sha256Pattern.test(identity.identitySha256)) {
    throw new NativeHttpReceiptInvalid({ reason: "identity digest is not lowercase SHA-256" });
  }

  if (!sha256Pattern.test(identity.requestSha256)) {
    throw new NativeHttpReceiptInvalid({ reason: "request digest is not lowercase SHA-256" });
  }

  if (!operationPattern.test(identity.operationId)) {
    throw new NativeHttpReceiptInvalid({ reason: "operation ID is not qualified" });
  }
};

const validateCapsule = (capsule: NativeHttpResponseCapsule): void => {
  if (!Number.isInteger(capsule.status) || capsule.status < 200 || capsule.status > 599) {
    throw new NativeHttpReceiptInvalid({ reason: "response status is outside 200 through 599" });
  }

  if ((capsule.bodyBytes === null) !== (capsule.mediaType === null)) {
    throw new NativeHttpReceiptInvalid({
      reason: "response body and media type must either both be present or both be absent",
    });
  }

  if ((capsule.headers["content-type"] ?? null) !== capsule.mediaType) {
    throw new NativeHttpReceiptInvalid({
      reason: "response media type must equal the stored Content-Type header",
    });
  }

  for (const [name, value] of Object.entries(capsule.headers)) {
    if (!Object.hasOwn(allowedHeaders, name) || value.length === 0) {
      throw new NativeHttpReceiptInvalid({
        reason: "response capsule contains a forbidden header",
      });
    }
  }
};

const decodeHeaders = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.String).pipe(
    Schema.check(
      Schema.makeFilter((headers) =>
        Object.keys(headers).every((name) => Object.hasOwn(allowedHeaders, name)),
      ),
    ),
  ),
);

const capsuleFromRow = (row: NativeHttpReceiptRow): NativeHttpResponseCapsule => {
  if (row.state !== "Complete" || row.status === null) {
    throw new NativeHttpReceiptInvalid({ reason: "a tombstone has no response capsule" });
  }

  return {
    status: row.status,
    mediaType: row.mediaType,
    bodyBytes: row.bodyBytes,
    headers: decodeHeaders(row.headers),
  };
};

const redactIdentityIfExpired = (sql: DatabaseOperations, identitySha256: string) =>
  sql`
    UPDATE public.native_http_idempotency_receipts
    SET
      state = 'Tombstone',
      status = NULL,
      media_type = NULL,
      body_bytes = NULL,
      headers_json = NULL,
      tombstoned_at = transaction_timestamp()
    WHERE identity_sha256 = ${identitySha256}
      AND state = 'Complete'
      AND full_expires_at <= transaction_timestamp()
  `.pipe(Effect.asVoid);

const readReceipt = (sql: DatabaseOperations, identitySha256: string) =>
  sql<NativeHttpReceiptRow>`
    SELECT
      request_sha256 AS "requestSha256",
      operation_id AS "operationId",
      state,
      status,
      media_type AS "mediaType",
      body_bytes AS "bodyBytes",
      headers_json AS headers
    FROM public.native_http_idempotency_receipts
    WHERE identity_sha256 = ${identitySha256}
  `.pipe(Effect.map((rows) => rows[0]));

const writeCompleteReceipt = (
  sql: DatabaseOperations,
  identity: NativeHttpReceiptIdentity,
  capsule: NativeHttpResponseCapsule,
) =>
  sql`
    INSERT INTO public.native_http_idempotency_receipts (
      identity_sha256,
      request_sha256,
      operation_id,
      state,
      status,
      media_type,
      body_bytes,
      headers_json,
      committed_at,
      full_expires_at,
      tombstoned_at
    ) VALUES (
      ${identity.identitySha256},
      ${identity.requestSha256},
      ${identity.operationId},
      'Complete',
      ${capsule.status},
      ${capsule.mediaType},
      ${capsule.bodyBytes},
      ${sql.json(capsule.headers)},
      transaction_timestamp(),
      transaction_timestamp() + interval '24 hours',
      NULL
    )
  `.pipe(Effect.asVoid);

/**
 * Resolves current authentication and authorization, then runs one accepted
 * command and its complete HTTP receipt in one transaction. `prepare` runs
 * before every receipt lookup, including replay, so a revoked credential or
 * authority cannot recover a previously committed response.
 *
 * The transaction connection is inherited by every SQL client used by the
 * prepared program. Domain state, audit, outbox, and receipt writes therefore
 * commit or roll back as one unit.
 */
export const executeNativeHttpCommandPostgres = <EPrepare, RPrepare, EExecute, RExecute>(
  prepare: Effect.Effect<NativeHttpCommandPlan<EExecute, RExecute>, EPrepare, RPrepare>,
  options: NativeHttpCommandExecutionOptions = {},
): Effect.Effect<
  NativeHttpCommandOutcome,
  EPrepare | EExecute | NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError,
  RPrepare | RExecute | Database
> => {
  const transaction = Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
        const plan = yield* prepare;
        const identity = plan.identity;
        yield* Effect.try({
          try: () => validateIdentity(identity),
          catch: (cause) =>
            cause instanceof NativeHttpReceiptInvalid
              ? cause
              : new NativeHttpReceiptInvalid({ reason: "invalid receipt identity" }),
        });

        const lockRows = yield* sql<LockRow>`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended(${identity.identitySha256}, 0)
          ) AS acquired
        `;

        if (lockRows[0]?.acquired !== true) {
          return NativeHttpCommandOutcome.InFlight({ retryAfterSeconds: 1 });
        }

        yield* redactIdentityIfExpired(sql, identity.identitySha256);
        const stored = yield* readReceipt(sql, identity.identitySha256);

        if (stored !== undefined) {
          if (
            stored.requestSha256 !== identity.requestSha256 ||
            stored.operationId !== identity.operationId
          ) {
            return NativeHttpCommandOutcome.DigestConflict();
          }

          if (stored.state === "Tombstone") return NativeHttpCommandOutcome.ResponseExpired();

          return NativeHttpCommandOutcome.Replay({ response: capsuleFromRow(stored) });
        }

        const response = yield* plan.execute.pipe(Effect.provideService(Database, sql));
        yield* Effect.try({
          try: () => validateCapsule(response),
          catch: (cause) =>
            cause instanceof NativeHttpReceiptInvalid
              ? cause
              : new NativeHttpReceiptInvalid({ reason: "invalid response capsule" }),
        });
        yield* writeCompleteReceipt(sql, identity, response);

        return NativeHttpCommandOutcome.Committed({ response });
      }),
    ),
  );

  const retryUniqueConstraints = new Set(
    options.retry === "serialization-or-unique-once" ? options.retryUniqueConstraints : [],
  );

  const executed =
    options.retry === undefined
      ? transaction
      : Effect.retry(transaction, {
          times: 1,
          while: (cause) => isRetryableCommandRace(cause, retryUniqueConstraints),
        });

  return executed.pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(new NativeHttpReceiptPersistenceError({ operation: "execute", cause })),
    ),
  );
};

/** Redacts all expired response capsules while retaining durable tombstones. */
export const redactExpiredNativeHttpReceipts = Database.use((sql) =>
  sql
    .withTransaction(
      sql<RedactionCountRow>`
      WITH redacted AS (
        UPDATE public.native_http_idempotency_receipts
        SET
          state = 'Tombstone',
          status = NULL,
          media_type = NULL,
          body_bytes = NULL,
          headers_json = NULL,
          tombstoned_at = transaction_timestamp()
        WHERE state = 'Complete'
          AND full_expires_at <= transaction_timestamp()
        RETURNING 1
      )
      SELECT count(*)::integer AS count FROM redacted
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    )
    .pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(new NativeHttpReceiptPersistenceError({ operation: "redact", cause })),
      ),
    ),
);
