import { Data, Effect } from "effect";
import type { DatabaseShape } from "./database/service.js";
import { Database } from "./database/service.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const operationPattern = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
const allowedHeaders: Readonly<Record<string, true>> = {
  "content-type": true,
  etag: true,
  location: true,
  "retry-after": true,
};

export interface NativeHttpReceiptIdentity {
  readonly identitySha256: string;
  readonly requestSha256: string;
  readonly operationId: string;
}

export interface NativeHttpResponseCapsule {
  readonly status: number;
  readonly mediaType: string | null;
  readonly bodyBytes: Uint8Array | null;
  readonly headers: Readonly<Record<string, string>>;
}
export interface NativeHttpCommandPlan<E, R> {
  readonly identity: NativeHttpReceiptIdentity;
  readonly execute: Effect.Effect<NativeHttpResponseCapsule, E, R | Database>;
}

interface NativeHttpReceiptRow {
  readonly requestSha256: string;
  readonly operationId: string;
  readonly state: "Complete" | "Tombstone";
  readonly status: number | null;
  readonly mediaType: string | null;
  readonly bodyBytes: Uint8Array | null;
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
    if (allowedHeaders[name] !== true || value.length === 0) {
      throw new NativeHttpReceiptInvalid({
        reason: "response capsule contains a forbidden header",
      });
    }
  }
};

const decodeHeaders = (value: unknown): Readonly<Record<string, string>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NativeHttpReceiptInvalid({ reason: "stored response headers are not an object" });
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (allowedHeaders[name] !== true || typeof headerValue !== "string") {
      throw new NativeHttpReceiptInvalid({ reason: "stored response headers are invalid" });
    }
    headers[name] = headerValue;
  }
  return headers;
};

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

const redactIdentityIfExpired = (sql: DatabaseShape, identitySha256: string) =>
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

const readReceipt = (sql: DatabaseShape, identitySha256: string) =>
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
  sql: DatabaseShape,
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
export const executeNativeHttpCommandPostgres = <E, R>(
  prepare: Effect.Effect<NativeHttpCommandPlan<E, R>, E, R | Database>,
): Effect.Effect<
  NativeHttpCommandOutcome,
  E | NativeHttpReceiptInvalid | NativeHttpReceiptPersistenceError,
  R | Database
> =>
  Database.use((sql) =>
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
          return { _tag: "InFlight", retryAfterSeconds: 1 } as const;
        }

        yield* redactIdentityIfExpired(sql, identity.identitySha256);
        const stored = yield* readReceipt(sql, identity.identitySha256);
        if (stored !== undefined) {
          if (
            stored.requestSha256 !== identity.requestSha256 ||
            stored.operationId !== identity.operationId
          ) {
            return { _tag: "DigestConflict" } as const;
          }
          if (stored.state === "Tombstone") return { _tag: "ResponseExpired" } as const;
          return { _tag: "Replay", response: capsuleFromRow(stored) } as const;
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
        return { _tag: "Committed", response } as const;
      }),
    ),
  ).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(new NativeHttpReceiptPersistenceError({ operation: "execute", cause })),
    ),
  );

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

/** Writes the invitation domain receipt inside the caller's HTTP transaction. */
export const writeInvitationResponseCommandReceiptWithSql = (
  sql: DatabaseShape,
  input: {
    readonly commandId: string;
    readonly commandSha256: string;
    readonly invitationId: string;
    readonly resultingResponseRevision: number;
  },
) => {
  if (
    !/^httpv2_[A-Za-z0-9_-]{43}$/u.test(input.commandId) ||
    !sha256Pattern.test(input.commandSha256) ||
    !Number.isSafeInteger(input.resultingResponseRevision) ||
    input.resultingResponseRevision < 0
  ) {
    return Effect.fail(new NativeHttpReceiptInvalid({ reason: "invalid invitation receipt" }));
  }
  return sql`
    INSERT INTO public.recruitment_invitation_response_command_receipts (
      command_id,
      command_sha256,
      invitation_id,
      resulting_response_revision,
      committed_at
    ) VALUES (
      ${input.commandId},
      ${input.commandSha256},
      ${input.invitationId},
      ${input.resultingResponseRevision},
      transaction_timestamp()
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(
        new NativeHttpReceiptPersistenceError({ operation: "invitation-receipt", cause }),
      ),
    ),
  );
};
