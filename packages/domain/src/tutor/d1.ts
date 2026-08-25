import * as D1Client from "@effect/sql-d1/D1Client";
import { Effect, Schema } from "effect";
import { runDomainPromise } from "../../runtime/node.js";
import { canonicalJsonBytes, canonicalJson, sha256Hex } from "./evidence.js";
import {
  ConductInterviewV1Schema,
  DescriptorSchema,
  decodeConductInterviewV1,
  decodeEventEnvelopeV1,
  type ConductInterviewV1,
  type Descriptor,
  type EventEnvelopeV1,
  type StreamKey,
} from "./schema.js";
import {
  DuplicateCommandConflict,
  InvalidTransition,
  StaleState,
  conductInterview,
  foldEvents,
  type CommandObservation,
  type FoldedState,
  type TutorFailure,
} from "./tracer.js";

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

export class D1IntegrityError extends Error {
  readonly _tag = "D1IntegrityError";
  readonly reasonCode = "D1_INTEGRITY";
  readonly lifecycle = "Drift";

  constructor(
    readonly reason: D1IntegrityReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "D1IntegrityError";
  }
}

export class D1BatchError extends Error {
  readonly _tag = "D1BatchError";
  readonly reasonCode = "D1_BATCH_FAILURE";
  readonly lifecycle = "Drift";

  constructor(
    readonly operation: "read" | "append",
    readonly detail: string,
    readonly causeValue?: unknown,
  ) {
    super(`${operation} batch failed: ${detail}`);
    this.name = "D1BatchError";
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
  readonly result: unknown;
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
  readonly batchResults: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
}

export interface D1DuplicateAppend {
  readonly _tag: "DuplicateResult";
  readonly receipt: StoredReceipt;
  readonly resultBytes: Uint8Array;
  readonly descriptorBytes: Uint8Array;
}

export type D1AppendResult = D1AcceptedAppend | D1DuplicateAppend;

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

const sqlErrorDetail = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown D1 error";
};

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
export const normalizeBlobBytes = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
  ) {
    return Uint8Array.from(value);
  }
  throw new D1IntegrityError("BLOB_RUNTIME_TYPE", "returned value is not a byte representation");
};

const normalizeBlob = (
  value: unknown,
  field: string,
): Effect.Effect<Uint8Array, D1IntegrityError> =>
  Effect.try({
    try: () => normalizeBlobBytes(value),
    catch: (error) =>
      error instanceof D1IntegrityError
        ? error
        : new D1IntegrityError("BLOB_RUNTIME_TYPE", `${field}: unknown byte representation`),
  });

const decodeCanonicalJson = (
  value: unknown,
  field: string,
): Effect.Effect<{ readonly bytes: Uint8Array; readonly value: unknown }, D1IntegrityError> =>
  Effect.gen(function* () {
    const bytes = yield* normalizeBlob(value, field);
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => new D1IntegrityError("BLOB_UTF8", `${field}: invalid UTF-8`),
    });
    const roundTrip = new TextEncoder().encode(text);
    if (!bytesEqual(bytes, roundTrip)) {
      return yield* Effect.fail(new D1IntegrityError("BLOB_UTF8", `${field}: UTF-8 bytes changed`));
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new D1IntegrityError("BLOB_UTF8", `${field}: invalid JSON`),
    });
    const canonical = yield* Effect.try({
      try: () => canonicalJsonBytes(parsed),
      catch: () =>
        new D1IntegrityError("BLOB_NON_CANONICAL", `${field}: canonical encoding failed`),
    });
    if (!bytesEqual(bytes, canonical)) {
      return yield* Effect.fail(
        new D1IntegrityError("BLOB_NON_CANONICAL", `${field}: bytes are not canonical`),
      );
    }
    return { bytes, value: parsed };
  });

const decodeStoredCommand = (
  value: unknown,
): Effect.Effect<
  { readonly bytes: Uint8Array; readonly command: ConductInterviewV1 },
  D1IntegrityError
> =>
  Effect.gen(function* () {
    const decoded = yield* decodeCanonicalJson(value, "command_bytes");
    const command = yield* decodeConductInterviewV1(decoded.value).pipe(
      Effect.mapError(
        () =>
          new D1IntegrityError("BLOB_NON_CANONICAL", "command_bytes: closed command decode failed"),
      ),
    );
    const canonical = canonicalJsonBytes(command);
    if (!bytesEqual(decoded.bytes, canonical)) {
      return yield* Effect.fail(
        new D1IntegrityError("BLOB_NON_CANONICAL", "command_bytes: decoded bytes differ"),
      );
    }
    return { bytes: decoded.bytes, command };
  });

const decodeStoredDescriptor = (
  value: unknown,
): Effect.Effect<
  { readonly bytes: Uint8Array; readonly descriptor: Descriptor },
  D1IntegrityError
> =>
  Effect.gen(function* () {
    const decoded = yield* decodeCanonicalJson(value, "descriptor_bytes");
    const descriptor = yield* Schema.decodeUnknownEffect(DescriptorSchema, {
      onExcessProperty: "error",
    })(decoded.value).pipe(
      Effect.mapError(
        () =>
          new D1IntegrityError("BLOB_NON_CANONICAL", "descriptor_bytes: descriptor decode failed"),
      ),
    );
    return { bytes: decoded.bytes, descriptor };
  });

const queryRows = <A extends Record<string, unknown>>(
  d1: D1Client.D1Client,
  sql: string,
  binds: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<A>, D1BatchError> =>
  d1.batch([d1.unsafe<A>(sql, binds)]).pipe(
    Effect.map((results) => (results as unknown as ReadonlyArray<ReadonlyArray<A>>)[0] ?? []),
    Effect.mapError((error) => new D1BatchError("read", sqlErrorDetail(error), error)),
  );

const readHead = (
  d1: D1Client.D1Client,
  stream: StreamKey,
): Effect.Effect<StreamHead | undefined, TutorD1Failure> =>
  Effect.gen(function* () {
    const rows = yield* queryRows<Record<string, unknown>>(
      d1,
      HEAD_LOOKUP_SQL,
      streamBinds(stream),
    );
    if (rows.length === 0) return undefined;
    if (rows.length !== 1)
      return yield* Effect.fail(
        new D1IntegrityError("ROW_SHAPE", "head lookup returned more than one row"),
      );
    const row = rows[0];
    if (row === undefined)
      return yield* Effect.fail(new D1IntegrityError("ROW_SHAPE", "head row disappeared"));
    if (
      typeof row.person_id !== "string" ||
      typeof row.department_id !== "string" ||
      typeof row.semester_year !== "number" ||
      !Number.isInteger(row.semester_year) ||
      (row.semester_term !== "Vår" && row.semester_term !== "Høst") ||
      typeof row.current_version !== "number" ||
      !Number.isInteger(row.current_version) ||
      row.current_version < 0 ||
      (row.last_command_id !== null && typeof row.last_command_id !== "string")
    ) {
      return yield* Effect.fail(
        new D1IntegrityError("ROW_SHAPE", "head row has invalid indexed values"),
      );
    }
    return row as unknown as StreamHead;
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
      typeof row.person_id !== "string" ||
      typeof row.department_id !== "string" ||
      typeof row.semester_year !== "number" ||
      !Number.isInteger(row.semester_year) ||
      (row.semester_term !== "Vår" && row.semester_term !== "Høst")
    ) {
      return yield* Effect.fail(
        new D1IntegrityError("ROW_SHAPE", "event stream columns have invalid values"),
      );
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
      return yield* Effect.fail(
        new D1IntegrityError("ROW_STREAM", `row ${index + 1} stream differs from query stream`),
      );
    }
    if (
      typeof row.event_id !== "string" ||
      typeof row.stream_version !== "number" ||
      !Number.isInteger(row.stream_version) ||
      typeof row.schema_version !== "number" ||
      !Number.isInteger(row.schema_version) ||
      typeof row.event_type !== "string" ||
      typeof row.occurred_at !== "string" ||
      typeof row.causation_id !== "string" ||
      typeof row.correlation_id !== "string"
    ) {
      return yield* Effect.fail(
        new D1IntegrityError("ROW_SHAPE", `row ${index + 1} has invalid indexed values`),
      );
    }
    const decoderKey = `${row.event_type}:${row.schema_version}`;
    if (!eventDecoderKeys.has(decoderKey)) {
      return yield* Effect.fail(new D1IntegrityError("UNKNOWN_DECODER", decoderKey));
    }
    const decoded = yield* decodeCanonicalJson(row.envelope_bytes, `envelope_bytes[${index}]`);
    const event = yield* decodeEventEnvelopeV1(decoded.value).pipe(
      Effect.mapError(() => new D1IntegrityError("UNKNOWN_DECODER", decoderKey)),
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
    for (const [key, expected] of Object.entries(expectedIndexed)) {
      if (row[key as keyof ReplayEventRow] !== expected) {
        return yield* Effect.fail(
          new D1IntegrityError(
            "ROW_INDEX_MISMATCH",
            `row ${index + 1} ${key} differs from envelope`,
          ),
        );
      }
    }
    if (!bytesEqual(decoded.bytes, canonicalJsonBytes(event))) {
      return yield* Effect.fail(
        new D1IntegrityError("BLOB_NON_CANONICAL", `row ${index + 1} envelope bytes changed`),
      );
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
      return yield* Effect.fail(new D1IntegrityError("EMPTY_STREAM", "replay returned no events"));
    }
    const folded = yield* foldEvents(events).pipe(
      Effect.mapError(
        (error) => new D1IntegrityError("REPLAY_FOLD", `${error._tag}:${error.reasonCode}`),
      ),
    );
    return { rows, events, folded } as ReplayResult;
  });

const readStream = (
  d1: D1Client.D1Client,
  stream: StreamKey,
): Effect.Effect<ReplayResult, TutorD1Failure> =>
  Effect.gen(function* () {
    const rows = yield* queryRows<Record<string, unknown>>(d1, REPLAY_SQL, streamBinds(stream));
    return yield* validateReplayRows(stream, rows as unknown as ReadonlyArray<ReplayEventRow>);
  });

const readReceipt = (
  d1: D1Client.D1Client,
  commandId: string,
): Effect.Effect<StoredReceipt | undefined, TutorD1Failure> =>
  Effect.gen(function* () {
    const rows = yield* queryRows<Record<string, unknown>>(d1, RECEIPT_LOOKUP_SQL, [commandId]);
    if (rows.length === 0) return undefined;
    if (rows.length !== 1)
      return yield* Effect.fail(
        new D1IntegrityError("ROW_SHAPE", "receipt lookup returned more than one row"),
      );
    const row = rows[0];
    if (row === undefined)
      return yield* Effect.fail(new D1IntegrityError("ROW_SHAPE", "receipt row disappeared"));
    if (row.command_id !== commandId) {
      return yield* Effect.fail(
        new D1IntegrityError("ROW_SHAPE", "receipt command ID differs from lookup"),
      );
    }
    const command = yield* decodeStoredCommand(row.command_bytes);
    if (command.command.commandId !== commandId) {
      return yield* Effect.fail(
        new D1IntegrityError("ROW_INDEX_MISMATCH", "receipt command bytes differ from command_id"),
      );
    }
    const result = yield* decodeCanonicalJson(row.result_bytes, "result_bytes");
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
        return {
          _tag: "DuplicateResult" as const,
          receipt: competingReceipt,
          resultBytes: competingReceipt.resultBytes,
          descriptorBytes: competingReceipt.descriptorBytes,
        };
      }
      return yield* Effect.fail(new DuplicateCommandConflict(command.commandId));
    }
    const currentHead = yield* readHead(d1, command.stream);
    if (currentHead === undefined) {
      return yield* Effect.fail(new InvalidTransition("EMPTY_STREAM", undefined));
    }
    if (
      currentHead.current_version !== expectedHead.current_version ||
      currentHead.last_command_id !== expectedHead.last_command_id
    ) {
      return yield* Effect.fail(
        new StaleState(command.expectedVersion, currentHead.current_version),
      );
    }
    return yield* Effect.fail(original);
  });

export interface AppendOptions {
  readonly beforeBatch?: ((plan: BatchPlan) => Promise<void>) | undefined;
}

const appendAccepted = (
  d1: D1Client.D1Client,
  input: unknown,
  options?: AppendOptions,
): Effect.Effect<D1AppendResult, TutorD1Failure> => {
  let preflightHead: StreamHead | undefined;
  return Effect.gen(function* () {
    const command = yield* decodeConductInterviewV1(input);
    const commandBytes = canonicalJsonBytes(command);
    const prior = yield* readReceipt(d1, command.commandId);
    if (prior !== undefined) {
      if (bytesEqual(prior.commandBytes, commandBytes)) {
        return {
          _tag: "DuplicateResult" as const,
          receipt: prior,
          resultBytes: prior.resultBytes,
          descriptorBytes: prior.descriptorBytes,
        };
      }
      return yield* Effect.fail(new DuplicateCommandConflict(command.commandId));
    }

    const head = yield* readHead(d1, command.stream);
    if (head === undefined)
      return yield* Effect.fail(new InvalidTransition("EMPTY_STREAM", undefined));
    preflightHead = head;
    const replay = yield* readStream(d1, command.stream);
    if (head.current_version !== replay.events.length) {
      return yield* Effect.fail(
        new D1IntegrityError("HEAD_MISMATCH", "head version differs from folded event count"),
      );
    }
    const lastEvent = replay.events[replay.events.length - 1];
    if (lastEvent === undefined || head.last_command_id !== lastEvent.causationId) {
      return yield* Effect.fail(
        new D1IntegrityError("HEAD_MISMATCH", "head token differs from last event causation"),
      );
    }

    const transition = yield* conductInterview(
      {
        stream: replay.folded.stream,
        events: replay.events,
        receipts: [],
      },
      command,
    );
    if (transition._tag !== "AcceptedResult") {
      return yield* Effect.fail(
        new D1IntegrityError("RESULT_SHAPE", "accepted append transition returned duplicate"),
      );
    }
    const event = transition.state.events[transition.state.events.length - 1];
    if (event === undefined)
      return yield* Effect.fail(
        new D1IntegrityError("RESULT_SHAPE", "accepted transition had no event"),
      );
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
      yield* Effect.promise(() => options.beforeBatch!(plan));
    }

    const result = yield* d1
      .batch([
        d1.unsafe<Record<string, unknown>>(plan.statements[0].sql, plan.statements[0].binds),
        d1.unsafe<Record<string, unknown>>(plan.statements[1].sql, plan.statements[1].binds),
        d1.unsafe<Record<string, unknown>>(plan.statements[2].sql, plan.statements[2].binds),
      ])
      .pipe(Effect.mapError((error) => new D1BatchError("append", sqlErrorDetail(error), error)));
    const resultZero = (result[0] ?? []) as ReadonlyArray<Record<string, unknown>>;
    if (
      resultZero.length !== 1 ||
      resultZero[0]?.current_version !== plan.newVersion ||
      resultZero[0]?.last_command_id !== command.commandId
    ) {
      return yield* Effect.fail(
        new D1IntegrityError("RESULT_SHAPE", "batch result 0 did not verify the CAS row"),
      );
    }
    return {
      _tag: "AcceptedResult" as const,
      observation: transition.observation,
      commandBytes,
      resultBytes,
      descriptorBytes,
      event,
      batchPlan: plan,
      batchResults: result as unknown as ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
    } satisfies D1AcceptedAppend;
  }).pipe(
    Effect.catchTag("D1BatchError", (error) =>
      Effect.gen(function* () {
        const command = yield* decodeConductInterviewV1(input);
        if (preflightHead === undefined) return yield* Effect.fail(error);
        return yield* classifyBatchFailure(d1, command, preflightHead, error);
      }),
    ),
  );
};

export const makeTutorD1Store = Effect.gen(function* () {
  const d1 = yield* D1Client.D1Client;
  return {
    readStream: (stream: StreamKey) => readStream(d1, stream),
    findReceipt: (commandId: string) => readReceipt(d1, commandId),
    appendAccepted: (input: unknown, options?: AppendOptions) => appendAccepted(d1, input, options),
  } as const;
});

export type TutorD1Store = Effect.Success<typeof makeTutorD1Store>;

export const runWithTutorD1 = <A, E>(
  db: D1Binding,
  effect: Effect.Effect<A, E, D1Client.D1Client>,
): Promise<A> =>
  runDomainPromise(
    Effect.scoped(effect.pipe(Effect.provide(D1Client.layer({ db })))) as Effect.Effect<A, E>,
  );

export const decodePersistedResult = (value: unknown): unknown => {
  const bytes = normalizeBlobBytes(value);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text) as unknown;
  if (!bytesEqual(bytes, canonicalJsonBytes(parsed))) {
    throw new D1IntegrityError("BLOB_NON_CANONICAL", "persisted result is not canonical");
  }
  return parsed;
};

export const commandSchema = ConductInterviewV1Schema;
export const canonicalCommand = canonicalJson;
export const streamKeyBinds = streamBinds;
export const streamKeysEqual = streamEqual;
