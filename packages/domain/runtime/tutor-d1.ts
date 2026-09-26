import { SqlError } from "effect/unstable/sql/SqlError";
import * as D1Client from "@effect/sql-d1/D1Client";
import { Data, Record, flow, Result, Predicate, Effect, Schema } from "effect";
import { canonicalJsonBytes, canonicalJson, sha256Hex } from "../src/shared-kernel/index.js";
import {
  ConductInterviewV1Schema,
  DescriptorSchema,
  decodeConductInterviewV1,
  decodeEventEnvelopeV1,
  type ConductInterviewV1,
  type Descriptor,
  type EventEnvelopeV1,
  type StreamKey,
} from "../src/tutor/schema.js";
import {
  DuplicateCommandConflict,
  InvalidTransition,
  StaleState,
  conductInterview,
  foldEvents,
  type CommandObservation,
  type FoldedState,
  type TutorFailure,
} from "../src/tutor/tracer.js";

export type D1Binding = Parameters<typeof D1Client.layer>[0]["db"];

export type D1IntegrityReason =
  | "BLOB_RUNTIME_TYPE"
  | "BLOB_UTF8"
  | "BLOB_NON_CANONICAL"
  | "ROW_SHAPE"
  | "ROW_STREAM"
  | "ROW_INDEX_MISMATCH"
  | "UNKNOWN_DECODER"
  | "REPLAY_FOLD"
  | "HEAD_MISMATCH"
  | "RESULT_SHAPE"
  | "EMPTY_STREAM";

export class D1IntegrityError extends Data.TaggedError("D1IntegrityError")<{
  readonly reason: D1IntegrityReason;
  readonly detail: string;
}> {
  readonly reasonCode = "D1_INTEGRITY";
  readonly lifecycle = "Drift";

  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

export class D1BatchError extends Data.TaggedError("D1BatchError")<{
  readonly operation: "read" | "append";
  readonly detail: string;
  readonly causeValue?: SqlError;
}> {
  readonly reasonCode = "D1_BATCH_FAILURE";
  readonly lifecycle = "Drift";

  override get message(): string {
    return `${this.operation} batch failed: ${this.detail}`;
  }
}

export type TutorD1Failure = TutorFailure | D1IntegrityError | D1BatchError;

export interface StreamHead {
  readonly person_id: string;
  readonly department_id: string;
  readonly semester_year: number;
  readonly semester_term: "Vår" | "Høst";
  readonly current_version: number;
  readonly last_command_id: string | null;
}

export interface ReplayEventRow {
  readonly person_id: unknown;
  readonly department_id: unknown;
  readonly semester_year: unknown;
  readonly semester_term: unknown;
  readonly event_id: unknown;
  readonly stream_version: unknown;
  readonly schema_version: unknown;
  readonly event_type: unknown;
  readonly envelope_bytes: unknown;
  readonly occurred_at: unknown;
  readonly causation_id: unknown;
  readonly correlation_id: unknown;
}

export interface ReplayResult {
  readonly rows: ReadonlyArray<ReplayEventRow>;
  readonly events: ReadonlyArray<EventEnvelopeV1>;
  readonly folded: FoldedState;
}

export interface StoredReceipt {
  readonly commandId: string;
  readonly commandBytes: Uint8Array;
  readonly resultBytes: Uint8Array;
  readonly descriptorBytes: Uint8Array;
  readonly result: Schema.Json;
  readonly descriptor: Descriptor;
}

export interface D1AcceptedAppend {
  readonly _tag: "AcceptedResult";
  readonly observation: CommandObservation;
  readonly commandBytes: Uint8Array;
  readonly resultBytes: Uint8Array;
  readonly descriptorBytes: Uint8Array;
  readonly event: EventEnvelopeV1;
  readonly batchPlan: BatchPlan;
  readonly batchResults: readonly [
    ReadonlyArray<Pick<StreamHead, "current_version" | "last_command_id">>,
    ReadonlyArray<never>,
    ReadonlyArray<never>,
  ];
}

export interface D1DuplicateAppend {
  readonly _tag: "DuplicateResult";
  readonly receipt: StoredReceipt;
  readonly resultBytes: Uint8Array;
  readonly descriptorBytes: Uint8Array;
}

export type D1AppendResult = D1AcceptedAppend | D1DuplicateAppend;

export const D1AppendResult = Data.taggedEnum<D1AppendResult>();

export interface BatchPlan {
  readonly statements: readonly [
    { readonly sql: string; readonly binds: ReadonlyArray<unknown> },
    { readonly sql: string; readonly binds: ReadonlyArray<unknown> },
    { readonly sql: string; readonly binds: ReadonlyArray<unknown> },
  ];
  readonly newVersion: number;
  readonly commandId: string;
  readonly eventId: string;
}

export const RECEIPT_LOOKUP_SQL = `SELECT command_id, command_bytes, result_bytes, descriptor_bytes
FROM command_receipts
WHERE command_id = ?1;`;

export const HEAD_LOOKUP_SQL = `SELECT person_id, department_id, semester_year, semester_term, current_version, last_command_id
FROM stream_heads
WHERE person_id = ?1
  AND department_id = ?2
  AND semester_year = ?3
  AND semester_term = ?4;`;

export const REPLAY_SQL = `SELECT
  person_id,
  department_id,
  semester_year,
  semester_term,
  event_id,
  stream_version,
  schema_version,
  event_type,
  envelope_bytes,
  occurred_at,
  causation_id,
  correlation_id
FROM tutor_events
WHERE person_id = ?1
  AND department_id = ?2
  AND semester_year = ?3
  AND semester_term = ?4
ORDER BY stream_version ASC;`;

export const HEAD_CAS_SQL = `UPDATE stream_heads
SET current_version = current_version + 1,
    last_command_id = ?7
WHERE person_id = ?1
  AND department_id = ?2
  AND semester_year = ?3
  AND semester_term = ?4
  AND current_version = ?5
  AND last_command_id IS ?6
RETURNING current_version, last_command_id;`;

export const EVENT_INSERT_SQL = `INSERT INTO tutor_events (
  person_id,
  department_id,
  semester_year,
  semester_term,
  event_id,
  stream_version,
  schema_version,
  event_type,
  envelope_bytes,
  occurred_at,
  causation_id,
  correlation_id
)
SELECT
  h.person_id,
  h.department_id,
  h.semester_year,
  h.semester_term,
  ?7,
  h.current_version,
  ?8,
  ?9,
  ?10,
  ?11,
  ?6,
  ?12
FROM stream_heads AS h
WHERE h.person_id = ?1
  AND h.department_id = ?2
  AND h.semester_year = ?3
  AND h.semester_term = ?4
  AND h.current_version = ?5
  AND h.last_command_id = ?6;`;

export const RECEIPT_INSERT_SQL = `INSERT INTO command_receipts (
  person_id,
  department_id,
  semester_year,
  semester_term,
  command_id,
  command_bytes,
  command_sha256,
  result_bytes,
  descriptor_bytes,
  event_id,
  event_stream_version
)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);`;

const streamEqual = (left: StreamKey, right: StreamKey): boolean =>
  left.personId === right.personId &&
  left.cycle.departmentId === right.cycle.departmentId &&
  left.cycle.semester.year === right.cycle.semester.year &&
  left.cycle.semester.term === right.cycle.semester.term;

const streamBinds = (stream: StreamKey): ReadonlyArray<unknown> => [
  stream.personId,
  stream.cycle.departmentId,
  stream.cycle.semester.year,
  stream.cycle.semester.term,
];

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Strict adapter boundary. Bun Buffer coercion is deliberately not used here. */
const BlobRepresentationSchema = Schema.Union([
  Schema.instanceOf(ArrayBuffer),
  Schema.declare((value): value is ArrayBufferView => ArrayBuffer.isView(value)),
  Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))),
]);

const blobBytes = (value: typeof BlobRepresentationSchema.Type): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  return Uint8Array.from(value);
};

export const normalizeBlobBytes = flow(
  Schema.decodeUnknownResult(BlobRepresentationSchema),
  Result.match({
    onSuccess: blobBytes,
    onFailure: (): never => {
      throw new D1IntegrityError({
        reason: "BLOB_RUNTIME_TYPE",
        detail: "returned value is not a byte representation",
      });
    },
  }),
);

const normalizeBlob = flow(
  Schema.decodeUnknownEffect(BlobRepresentationSchema),
  Effect.map(blobBytes),
  Effect.mapError(
    () =>
      new D1IntegrityError({
        reason: "BLOB_RUNTIME_TYPE",
        detail: "returned value is not a byte representation",
      }),
  ),
);

const decodeCanonicalJson = (field: string) =>
  flow(
    normalizeBlob,
    Effect.flatMap((bytes) =>
      Effect.gen(function* () {
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: () =>
            new D1IntegrityError({ reason: "BLOB_UTF8", detail: `${field}: invalid UTF-8` }),
        });

        const roundTrip = new TextEncoder().encode(text);

        if (!bytesEqual(bytes, roundTrip)) {
          return yield* new D1IntegrityError({
            reason: "BLOB_UTF8",
            detail: `${field}: UTF-8 bytes changed`,
          });
        }

        const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
          Effect.mapError(
            () => new D1IntegrityError({ reason: "BLOB_UTF8", detail: `${field}: invalid JSON` }),
          ),
        );

        const canonical = yield* Effect.try({
          try: () => canonicalJsonBytes(parsed),
          catch: () =>
            new D1IntegrityError({
              reason: "BLOB_NON_CANONICAL",
              detail: `${field}: canonical encoding failed`,
            }),
        });

        if (!bytesEqual(bytes, canonical)) {
          return yield* new D1IntegrityError({
            reason: "BLOB_NON_CANONICAL",
            detail: `${field}: bytes are not canonical`,
          });
        }

        return { bytes, value: parsed };
      }),
    ),
  );

const decodeStoredCommand = flow(
  decodeCanonicalJson("command_bytes"),
  Effect.flatMap((decoded) =>
    Effect.gen(function* () {
      const command = yield* decodeConductInterviewV1(decoded.value).pipe(
        Effect.mapError(
          () =>
            new D1IntegrityError({
              reason: "BLOB_NON_CANONICAL",
              detail: "command_bytes: closed command decode failed",
            }),
        ),
      );

      const canonical = canonicalJsonBytes(command);

      if (!bytesEqual(decoded.bytes, canonical)) {
        return yield* new D1IntegrityError({
          reason: "BLOB_NON_CANONICAL",
          detail: "command_bytes: decoded bytes differ",
        });
      }

      return { bytes: decoded.bytes, command };
    }),
  ),
);

const decodeStoredDescriptor = flow(
  decodeCanonicalJson("descriptor_bytes"),
  Effect.flatMap((decoded) =>
    Effect.gen(function* () {
      const descriptor = yield* Schema.decodeUnknownEffect(DescriptorSchema, {
        onExcessProperty: "error",
      })(decoded.value).pipe(
        Effect.mapError(
          () =>
            new D1IntegrityError({
              reason: "BLOB_NON_CANONICAL",
              detail: "descriptor_bytes: descriptor decode failed",
            }),
        ),
      );

      return { bytes: decoded.bytes, descriptor };
    }),
  ),
);

const queryRows = <A extends object>(
  d1: D1Client.D1Client,
  sql: string,
  binds: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<A>, D1BatchError> =>
  d1.batch([d1.unsafe<A>(sql, binds)]).pipe(
    Effect.map((results) => results[0] ?? []),
    Effect.mapError(
      (error) => new D1BatchError({ operation: "read", detail: error.message, causeValue: error }),
    ),
  );

const readHead = (
  d1: D1Client.D1Client,
  stream: StreamKey,
): Effect.Effect<StreamHead | undefined, TutorD1Failure> =>
  Effect.gen(function* () {
    const rows = yield* queryRows<StreamHead>(d1, HEAD_LOOKUP_SQL, streamBinds(stream));

    if (rows.length === 0) return undefined;

    if (rows.length !== 1)
      return yield* new D1IntegrityError({
        reason: "ROW_SHAPE",
        detail: "head lookup returned more than one row",
      });
    const row = rows[0];

    if (row === undefined)
      return yield* new D1IntegrityError({ reason: "ROW_SHAPE", detail: "head row disappeared" });

    if (
      !Predicate.isString(row.person_id) ||
      !Predicate.isString(row.department_id) ||
      !Predicate.isNumber(row.semester_year) ||
      !Number.isInteger(row.semester_year) ||
      (row.semester_term !== "Vår" && row.semester_term !== "Høst") ||
      !Predicate.isNumber(row.current_version) ||
      !Number.isInteger(row.current_version) ||
      row.current_version < 0 ||
      (row.last_command_id !== null && !Predicate.isString(row.last_command_id))
    ) {
      return yield* new D1IntegrityError({
        reason: "ROW_SHAPE",
        detail: "head row has invalid indexed values",
      });
    }

    return row;
  });

const eventDecoderKeys = new Set([
  "ApplicationReceived:1",
  "InterviewInvited:1",
  "InterviewAccepted:1",
  "InterviewConducted:1",
]);

const indexedStream = (row: ReplayEventRow): Effect.Effect<StreamKey, D1IntegrityError> =>
  Effect.gen(function* () {
    if (
      !Predicate.isString(row.person_id) ||
      !Predicate.isString(row.department_id) ||
      !Predicate.isNumber(row.semester_year) ||
      !Number.isInteger(row.semester_year) ||
      (row.semester_term !== "Vår" && row.semester_term !== "Høst")
    ) {
      return yield* new D1IntegrityError({
        reason: "ROW_SHAPE",
        detail: "event stream columns have invalid values",
      });
    }

    return {
      personId: row.person_id,
      cycle: {
        departmentId: row.department_id,
        semester: { year: row.semester_year, term: row.semester_term },
      },
    };
  });

const decodeReplayEvent = (
  requestedStream: StreamKey,
  row: ReplayEventRow,
  index: number,
): Effect.Effect<EventEnvelopeV1, D1IntegrityError> =>
  Effect.gen(function* () {
    const rowStream = yield* indexedStream(row);

    if (!streamEqual(rowStream, requestedStream)) {
      return yield* new D1IntegrityError({
        reason: "ROW_STREAM",
        detail: `row ${index + 1} stream differs from query stream`,
      });
    }

    if (
      !Predicate.isString(row.event_id) ||
      !Predicate.isNumber(row.stream_version) ||
      !Number.isInteger(row.stream_version) ||
      !Predicate.isNumber(row.schema_version) ||
      !Number.isInteger(row.schema_version) ||
      !Predicate.isString(row.event_type) ||
      !Predicate.isString(row.occurred_at) ||
      !Predicate.isString(row.causation_id) ||
      !Predicate.isString(row.correlation_id)
    ) {
      return yield* new D1IntegrityError({
        reason: "ROW_SHAPE",
        detail: `row ${index + 1} has invalid indexed values`,
      });
    }

    const decoderKey = `${row.event_type}:${row.schema_version}`;

    if (!eventDecoderKeys.has(decoderKey)) {
      return yield* new D1IntegrityError({ reason: "UNKNOWN_DECODER", detail: decoderKey });
    }

    const decoded = yield* decodeCanonicalJson(`envelope_bytes[${index}]`)(row.envelope_bytes);

    const event = yield* decodeEventEnvelopeV1(decoded.value).pipe(
      Effect.mapError(
        () => new D1IntegrityError({ reason: "UNKNOWN_DECODER", detail: decoderKey }),
      ),
    );

    const expectedIndexed = {
      person_id: event.stream.personId,
      department_id: event.stream.cycle.departmentId,
      semester_year: event.stream.cycle.semester.year,
      semester_term: event.stream.cycle.semester.term,
      event_id: event.eventId,
      stream_version: event.streamVersion,
      schema_version: event.schemaVersion,
      event_type: event.eventType,
      occurred_at: event.occurredAt,
      causation_id: event.causationId,
      correlation_id: event.correlationId,
    };

    for (const [key, expected] of Record.toEntries(expectedIndexed)) {
      if (row[key] !== expected) {
        return yield* new D1IntegrityError({
          reason: "ROW_INDEX_MISMATCH",
          detail: `row ${index + 1} ${key} differs from envelope`,
        });
      }
    }

    if (!bytesEqual(decoded.bytes, canonicalJsonBytes(event))) {
      return yield* new D1IntegrityError({
        reason: "BLOB_NON_CANONICAL",
        detail: `row ${index + 1} envelope bytes changed`,
      });
    }

    return event;
  });

export const validateReplayRows = (
  requestedStream: StreamKey,
  rows: ReadonlyArray<ReplayEventRow>,
): Effect.Effect<ReplayResult, TutorD1Failure> =>
  Effect.gen(function* () {
    const events: Array<EventEnvelopeV1> = [];

    for (const [index, row] of rows.entries()) {
      events.push(yield* decodeReplayEvent(requestedStream, row, index));
    }

    if (events.length === 0) {
      return yield* new D1IntegrityError({
        reason: "EMPTY_STREAM",
        detail: "replay returned no events",
      });
    }

    const folded = yield* foldEvents(events).pipe(
      Effect.mapError(
        (error) =>
          new D1IntegrityError({
            reason: "REPLAY_FOLD",
            detail: `${error._tag}:${error.reasonCode}`,
          }),
      ),
    );

    return { rows, events, folded };
  });

const readStream = (
  d1: D1Client.D1Client,
  stream: StreamKey,
): Effect.Effect<ReplayResult, TutorD1Failure> =>
  Effect.gen(function* () {
    const rows = yield* queryRows<ReplayEventRow>(d1, REPLAY_SQL, streamBinds(stream));

    return yield* validateReplayRows(stream, rows);
  });

const readReceipt = (
  d1: D1Client.D1Client,
  commandId: string,
): Effect.Effect<StoredReceipt | undefined, TutorD1Failure> =>
  Effect.gen(function* () {
    const rows = yield* queryRows<{
      readonly command_id: string;
      readonly command_bytes: unknown;
      readonly result_bytes: unknown;
      readonly descriptor_bytes: unknown;
    }>(d1, RECEIPT_LOOKUP_SQL, [commandId]);

    if (rows.length === 0) return undefined;

    if (rows.length !== 1)
      return yield* new D1IntegrityError({
        reason: "ROW_SHAPE",
        detail: "receipt lookup returned more than one row",
      });
    const row = rows[0];

    if (row === undefined)
      return yield* new D1IntegrityError({
        reason: "ROW_SHAPE",
        detail: "receipt row disappeared",
      });

    if (row.command_id !== commandId) {
      return yield* new D1IntegrityError({
        reason: "ROW_SHAPE",
        detail: "receipt command ID differs from lookup",
      });
    }

    const command = yield* decodeStoredCommand(row.command_bytes);

    if (command.command.commandId !== commandId) {
      return yield* new D1IntegrityError({
        reason: "ROW_INDEX_MISMATCH",
        detail: "receipt command bytes differ from command_id",
      });
    }

    const result = yield* decodeCanonicalJson("result_bytes")(row.result_bytes);
    const descriptor = yield* decodeStoredDescriptor(row.descriptor_bytes);

    return {
      commandId,
      commandBytes: command.bytes,
      resultBytes: result.bytes,
      descriptorBytes: descriptor.bytes,
      result: result.value,
      descriptor: descriptor.descriptor,
    };
  });

export const buildBatchPlan = (
  command: ConductInterviewV1,
  event: EventEnvelopeV1,
  resultBytes: Uint8Array,
  descriptorBytes: Uint8Array,
  expectedLastCommandId: string,
): BatchPlan => {
  const stream = command.stream;
  const commandBytes = canonicalJsonBytes(command);
  const streamValues = streamBinds(stream);
  const newVersion = command.expectedVersion + 1;

  return {
    newVersion,
    commandId: command.commandId,
    eventId: event.eventId,
    statements: [
      {
        sql: HEAD_CAS_SQL,
        binds: [...streamValues, command.expectedVersion, expectedLastCommandId, command.commandId],
      },
      {
        sql: EVENT_INSERT_SQL,
        binds: [
          ...streamValues,
          newVersion,
          command.commandId,
          event.eventId,
          event.schemaVersion,
          event.eventType,
          canonicalJsonBytes(event),
          event.occurredAt,
          event.correlationId,
        ],
      },
      {
        sql: RECEIPT_INSERT_SQL,
        binds: [
          ...streamValues,
          command.commandId,
          commandBytes,
          sha256Hex(commandBytes),
          resultBytes,
          descriptorBytes,
          event.eventId,
          newVersion,
        ],
      },
    ],
  };
};

const classifyBatchFailure = (
  d1: D1Client.D1Client,
  command: ConductInterviewV1,
  expectedHead: StreamHead,
  original: D1BatchError,
): Effect.Effect<D1AppendResult, TutorD1Failure> =>
  Effect.gen(function* () {
    const commandBytes = canonicalJsonBytes(command);
    const competingReceipt = yield* readReceipt(d1, command.commandId);

    if (competingReceipt !== undefined) {
      if (bytesEqual(competingReceipt.commandBytes, commandBytes)) {
        return D1AppendResult.DuplicateResult({
          receipt: competingReceipt,
          resultBytes: competingReceipt.resultBytes,
          descriptorBytes: competingReceipt.descriptorBytes,
        });
      }

      return yield* new DuplicateCommandConflict({ commandId: command.commandId });
    }

    const currentHead = yield* readHead(d1, command.stream);

    if (currentHead === undefined) {
      return yield* new InvalidTransition({ reasonCode: "EMPTY_STREAM", lawRef: undefined });
    }

    if (
      currentHead.current_version !== expectedHead.current_version ||
      currentHead.last_command_id !== expectedHead.last_command_id
    ) {
      return yield* new StaleState({
        expectedVersion: command.expectedVersion,
        currentVersion: currentHead.current_version,
      });
    }

    return yield* original;
  });

export interface AppendOptions {
  readonly beforeBatch?: ((plan: BatchPlan) => Effect.Effect<void>) | undefined;
}

const appendAccepted = (
  d1: D1Client.D1Client,
  input: Schema.Json,
  options?: AppendOptions,
): Effect.Effect<D1AppendResult, TutorD1Failure> => {
  let preflightHead: StreamHead | undefined;

  return Effect.gen(function* () {
    const command = yield* decodeConductInterviewV1(input);
    const commandBytes = canonicalJsonBytes(command);
    const prior = yield* readReceipt(d1, command.commandId);

    if (prior !== undefined) {
      if (bytesEqual(prior.commandBytes, commandBytes)) {
        return D1AppendResult.DuplicateResult({
          receipt: prior,
          resultBytes: prior.resultBytes,
          descriptorBytes: prior.descriptorBytes,
        });
      }

      return yield* new DuplicateCommandConflict({ commandId: command.commandId });
    }

    const head = yield* readHead(d1, command.stream);

    if (head === undefined)
      return yield* new InvalidTransition({ reasonCode: "EMPTY_STREAM", lawRef: undefined });
    preflightHead = head;
    const replay = yield* readStream(d1, command.stream);

    if (head.current_version !== replay.events.length) {
      return yield* new D1IntegrityError({
        reason: "HEAD_MISMATCH",
        detail: "head version differs from folded event count",
      });
    }

    const lastEvent = replay.events[replay.events.length - 1];

    if (lastEvent === undefined || head.last_command_id !== lastEvent.causationId) {
      return yield* new D1IntegrityError({
        reason: "HEAD_MISMATCH",
        detail: "head token differs from last event causation",
      });
    }

    const transition = yield* conductInterview(
      {
        stream: replay.folded.stream,
        events: replay.events,
        receipts: [],
      },
      command,
    );

    if (!Predicate.isTagged(transition, "AcceptedResult")) {
      return yield* new D1IntegrityError({
        reason: "RESULT_SHAPE",
        detail: "accepted append transition returned duplicate",
      });
    }

    const event = transition.state.events[transition.state.events.length - 1];

    if (event === undefined)
      return yield* new D1IntegrityError({
        reason: "RESULT_SHAPE",
        detail: "accepted transition had no event",
      });
    const resultBytes = canonicalJsonBytes(transition.observation);
    const descriptorBytes = canonicalJsonBytes(transition.observation.descriptor);

    const plan = buildBatchPlan(
      command,
      event,
      resultBytes,
      descriptorBytes,
      lastEvent.causationId,
    );

    if (options?.beforeBatch !== undefined) {
      yield* options.beforeBatch(plan);
    }

    const result = yield* d1
      .batch([
        d1.unsafe<Pick<StreamHead, "current_version" | "last_command_id">>(
          plan.statements[0].sql,
          plan.statements[0].binds,
        ),
        d1.unsafe<never>(plan.statements[1].sql, plan.statements[1].binds),
        d1.unsafe<never>(plan.statements[2].sql, plan.statements[2].binds),
      ])
      .pipe(
        Effect.mapError(
          (error) =>
            new D1BatchError({ operation: "append", detail: error.message, causeValue: error }),
        ),
      );

    const resultZero = result[0] ?? [];

    if (
      resultZero.length !== 1 ||
      resultZero[0]?.current_version !== plan.newVersion ||
      resultZero[0]?.last_command_id !== command.commandId
    ) {
      return yield* new D1IntegrityError({
        reason: "RESULT_SHAPE",
        detail: "batch result 0 did not verify the CAS row",
      });
    }

    return D1AppendResult.AcceptedResult({
      observation: transition.observation,
      commandBytes,
      resultBytes,
      descriptorBytes,
      event,
      batchPlan: plan,
      batchResults: result,
    }) satisfies D1AcceptedAppend;
  }).pipe(
    Effect.catchTag("D1BatchError", (error) =>
      Effect.gen(function* () {
        const command = yield* decodeConductInterviewV1(input);

        if (preflightHead === undefined) return yield* error;

        return yield* classifyBatchFailure(d1, command, preflightHead, error);
      }),
    ),
  );
};

export const tutorD1Store = Effect.gen(function* () {
  const d1 = yield* D1Client.D1Client;

  return {
    readStream: (stream: StreamKey) => readStream(d1, stream),
    findReceipt: (commandId: string) => readReceipt(d1, commandId),
    appendAccepted: (input: Schema.Json, options?: AppendOptions) =>
      appendAccepted(d1, input, options),
  } as const;
});

export type TutorD1Store = Effect.Success<typeof tutorD1Store>;

export const runWithTutorD1 = <A, E>(
  db: D1Binding,
  effect: Effect.Effect<A, E, D1Client.D1Client>,
) => Effect.scoped(effect.pipe(Effect.provide(D1Client.layer({ db }))));

export const decodePersistedResult = flow(normalizeBlobBytes, (bytes): Schema.Json => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: Schema.Json = JSON.parse(text);

  if (!bytesEqual(bytes, canonicalJsonBytes(parsed))) {
    throw new D1IntegrityError({
      reason: "BLOB_NON_CANONICAL",
      detail: "persisted result is not canonical",
    });
  }

  return parsed;
});

export const commandSchema = ConductInterviewV1Schema;

export const canonicalCommand = canonicalJson;

export const streamKeyBinds = streamBinds;

export const streamKeysEqual = streamEqual;
