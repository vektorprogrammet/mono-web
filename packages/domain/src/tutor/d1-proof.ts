import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { Effect } from "effect";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "./evidence.js";
import {
  REPLAY_SQL,
  type BatchPlan,
  type D1Binding,
  type D1AppendResult,
  type ReplayEventRow,
  type ReplayResult,
  type TutorD1Failure,
  type TutorD1Store,
  makeTutorD1Store,
  normalizeBlobBytes,
  runWithTutorD1,
  validateReplayRows,
} from "./d1.js";
import { projectFoldedState } from "./tracer.js";
import type { CommandObservation } from "./tracer.js";
import type { Descriptor, EventEnvelopeV1, StreamKey } from "./schema.js";
import {
  FIXTURE_COMMAND,
  FIXTURE_CORRELATION_ID,
  FIXTURE_DEPARTMENT_ID,
  FIXTURE_ID,
  FIXTURE_PERSON_ID,
  FIXTURE_SEED_EVENTS,
} from "./fixture.js";
const PINNED_BUN_VERSION = "1.3.10";
const EFFECT_VERSION = "4.0.0-rc.109";
const MINIFLARE_VERSION = "4.20260706.0";
const SPEC_ID = "0017";
const BASE_COMMIT = "a8dafe618907dfd623718802fdaf5712d55f70d4";
const SOURCE_CANDIDATE_PARENT = "266185e98d22718576653df9973ece8246da124a";
const SOURCE_CANDIDATE_COMMIT = "7ddca9eb18c307f7c6baf47134793eda5c299db6";
const CANONICAL_INTEGRATION_BASE = "0f09064d4d85039f51127bd25b6501b71696980e";
const CANONICAL_D1_INTEGRATION_COMMIT = "9a166a327a21924537a3a3ac23ede88619b64c98";
const PREDECESSOR_COMMIT = "a8dafe618907dfd623718802fdaf5712d55f70d4";
const ADR_SHA256 = "94a2dbe93d353ddf98af784d3d6a66903c69631f8adc656c07f98a329491c830";
const D1_CLIENT_SOURCE_HASH = "33d086b2b5599349e012f93241d40f079ff78d09ddea00857744217e39b8647e";
const STATEMENT_SOURCE_HASH = "d0217382c9cded3a4f143058461b96aecf18c0f2daedd7995e726831d7cc12f5";
const SQL_EVENT_JOURNAL_SOURCE_HASH = "832b3143d50baeb589a6739f6938357d57a794d22bae5cb28bad51b94c4748ac";
const MIGRATOR_SOURCE_HASH = "c94e7d36a4d253210e76e694bde656aeace439e541e503b9442e06bf95878de9";
const SQL_CLIENT_SOURCE_HASH = "aed2fc43ca7582797a4762198318936ed9e743696b7aa4ec43002bbc1622d27f";
const D1_BINDING_NAME = "TUTOR_D1";

const stream: StreamKey = FIXTURE_COMMAND.stream;

interface LocalPrepared {
  bind: (...values: ReadonlyArray<unknown>) => LocalPrepared;
  all: <A extends Record<string, unknown>>() => Promise<{ readonly results: ReadonlyArray<A> }>;
  run: () => Promise<unknown>;
}

interface LocalBinding {
  prepare: (query: string) => LocalPrepared;
}

interface LocalRuntime {
  readonly miniflare: Miniflare;
  readonly db: LocalBinding;
}
let activeRuntime: LocalRuntime | undefined;

interface HeadSnapshot {
  readonly current_version: number;
  readonly last_command_id: string | null;
}

interface RowCounts {
  readonly stream_heads: number;
  readonly tutor_events: number;
  readonly command_receipts: number;
}

const readFixtureHead = async (db: LocalBinding): Promise<HeadSnapshot | null> => {
  const rows = await dbRows<Record<string, unknown>>(
    db,
    `SELECT current_version, last_command_id
     FROM stream_heads
     WHERE person_id = ?1
       AND department_id = ?2
       AND semester_year = ?3
       AND semester_term = ?4;`,
    [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term],
  );
  const row = rows[0];
  if (row === undefined) return null;
  assert(Number.isInteger(row.current_version), "head snapshot version is not an integer");
  assert(row.last_command_id === null || typeof row.last_command_id === "string", "head snapshot token is not text/null");
  return { current_version: Number(row.current_version), last_command_id: row.last_command_id as string | null };
};

interface CaseRecord {
  readonly caseId: string;
  readonly status: "accepted" | "rejected" | "stale" | "terminal" | "duplicate" | "duplicate-conflict" | "drift";
  readonly reasonCode: string;
  readonly commandId: string;
  readonly before: RowCounts;
  readonly after: RowCounts;
  readonly rows: ReadonlyArray<string>;
  readonly details: Readonly<Record<string, unknown>>;
}

interface D1Evidence {
  readonly formatVersion: 1;
  readonly specId: typeof SPEC_ID;
  readonly baseCommit: string;
  readonly adrSha256: string;
  readonly predecessorCommit: string;
  readonly fixtureId: string;
  readonly schemaMigrationId: string;
  readonly schemaHash: string;
  readonly localEffectVersion: string;
  readonly localEffectSourceHashes: Readonly<Record<string, string>>;
  readonly localMiniflareVersion: string;
  readonly correlationId: string;
  readonly stream: StreamKey;
  readonly seedHead: Readonly<Record<string, unknown>>;
  readonly seedEvents: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly batch: Readonly<Record<string, unknown>>;
  readonly cases: ReadonlyArray<CaseRecord>;
  readonly replay: Readonly<Record<string, unknown>>;
  readonly projection: Readonly<Record<string, unknown>>;
  readonly effectDescriptors: ReadonlyArray<Descriptor>;
  readonly rowCounts: Readonly<Record<string, unknown>>;
  readonly limits: ReadonlyArray<string>;
  readonly provenance: Readonly<Record<string, unknown>>;
}

interface RenderedEvidence {
  readonly document: D1Evidence;
  readonly canonicalJson: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const errorTag = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : error instanceof Error
      ? error.name
      : "UnknownError";

const errorReason = (error: unknown): string =>
  typeof error === "object" && error !== null && "reasonCode" in error && typeof error.reasonCode === "string"
    ? error.reasonCode
    : error instanceof Error
      ? error.name
      : "UNKNOWN";

const expectFailure = async <E>(
  promise: Promise<unknown>,
  predicate: (error: E) => boolean,
  message: string,
): Promise<E> => {
  try {
    await promise;
  } catch (error) {
    if (predicate(error as E)) return error as E;
    throw new Error(`${message}: observed ${errorTag(error)}:${errorReason(error)}`);
  }
  throw new Error(`${message}: operation unexpectedly succeeded`);
};

const dbExec = (db: LocalBinding, sql: string, binds: ReadonlyArray<unknown> = []): Promise<unknown> =>
  db.prepare(sql).bind(...binds).run();

const dbRows = async <A extends Record<string, unknown>>(
  db: LocalBinding,
  sql: string,
  binds: ReadonlyArray<unknown> = [],
): Promise<ReadonlyArray<A>> => (await db.prepare(sql).bind(...binds).all<A>()).results;

const rowCounts = async (db: LocalBinding): Promise<RowCounts> => {
  const rows = await dbRows<Record<string, number>>(
    db,
    `SELECT
      (SELECT COUNT(*) FROM stream_heads) AS stream_heads,
      (SELECT COUNT(*) FROM tutor_events) AS tutor_events,
      (SELECT COUNT(*) FROM command_receipts) AS command_receipts;`,
  );
  const row = rows[0];
  assert(row !== undefined, "count query returned no row");
  return {
    stream_heads: Number(row.stream_heads),
    tutor_events: Number(row.tutor_events),
    command_receipts: Number(row.command_receipts),
  };
};

const openRuntime = async (): Promise<LocalRuntime> => {
  const miniflare = new Miniflare({ modules: true, script: "", d1Databases: [D1_BINDING_NAME] });
  const db = (await miniflare.getD1Database(D1_BINDING_NAME)) as unknown as LocalBinding;
  return { miniflare, db };
};

const migrationSql = async (): Promise<string> =>
  readFile(fileURLToPath(new URL("./migrations/0001-tutor-event-store.sql", import.meta.url)), "utf8");

const applyMigration = async (db: LocalBinding, sql: string): Promise<void> => {
  const statements = sql.split(/;\s*(?=CREATE TABLE|CREATE TRIGGER)/);
  for (const statement of statements) {
    const sqlText = statement.trim();
    await db.prepare(sqlText.endsWith(";") ? sqlText : `${sqlText};`).run();
  }
};

const seedStream = async (
  db: LocalBinding,
  seedEvents: ReadonlyArray<EventEnvelopeV1> = FIXTURE_SEED_EVENTS,
  headVersion = 3,
  headToken: string | null = FIXTURE_ID,
): Promise<void> => {
  await dbExec(
    db,
    `INSERT INTO stream_heads (person_id, department_id, semester_year, semester_term, current_version, last_command_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6);`,
    [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term, headVersion, headToken],
  );
  for (const event of seedEvents) {
    await dbExec(
      db,
      `INSERT INTO tutor_events (
        person_id, department_id, semester_year, semester_term, event_id, stream_version,
        schema_version, event_type, envelope_bytes, occurred_at, causation_id, correlation_id
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);`,
      [
        event.stream.personId,
        event.stream.cycle.departmentId,
        event.stream.cycle.semester.year,
        event.stream.cycle.semester.term,
        event.eventId,
        event.streamVersion,
        event.schemaVersion,
        event.eventType,
        canonicalJsonBytes(event),
        event.occurredAt,
        event.causationId,
        event.correlationId,
      ],
    );
  }
};
const resetDatabase = async (db: LocalBinding): Promise<void> => {
  for (const sql of [
    "DROP TRIGGER IF EXISTS tutor_events_immutable_update;",
    "DROP TRIGGER IF EXISTS tutor_events_immutable_delete;",
    "DROP TRIGGER IF EXISTS command_receipts_immutable_update;",
    "DROP TRIGGER IF EXISTS command_receipts_immutable_delete;",
    "DROP TABLE IF EXISTS command_receipts;",
    "DROP TABLE IF EXISTS tutor_events;",
    "DROP TABLE IF EXISTS stream_heads;",
  ]) {
    await dbExec(db, sql);
  }
};
const withMigration = async <A>(run: (runtime: LocalRuntime) => Promise<A>): Promise<A> => {
  const ownsRuntime = activeRuntime === undefined;
  const runtime = activeRuntime ?? await openRuntime();
  try {
    await resetDatabase(runtime.db);
    await applyMigration(runtime.db, await migrationSql());
    return await run(runtime);
  } finally {
    if (ownsRuntime) {
      await runtime.miniflare.dispose();
    }
  }
};

const withSeed = async <A>(run: (runtime: LocalRuntime) => Promise<A>): Promise<A> =>
  withMigration(async (runtime) => {
    await seedStream(runtime.db);
    return run(runtime);
  });

const withStore = async <A, E>(
  db: LocalBinding,
  operation: (store: TutorD1Store) => Effect.Effect<A, E>,
): Promise<A> =>
  runWithTutorD1(
    db as unknown as D1Binding,
    Effect.flatMap(makeTutorD1Store, operation),
  );
const append = (db: LocalBinding, input: unknown, options?: { readonly beforeBatch?: ((plan: BatchPlan) => Promise<void>) | undefined }): Promise<D1AppendResult> =>
  withStore(db, (store) => store.appendAccepted(input, options));

const readReplay = (db: LocalBinding): Promise<unknown> =>
  withStore(db, (store) => store.readStream(stream));

const caseRecord = (
  caseId: string,
  status: CaseRecord["status"],
  reasonCode: string,
  commandId: string,
  before: RowCounts,
  after: RowCounts,
  rows: ReadonlyArray<string> = ["candidate"],
  details: Readonly<Record<string, unknown>> = {},
): CaseRecord => ({ caseId, status, reasonCode, commandId, before, after, rows, details });

const conductedEventFor = (commandId: string, correlationId = FIXTURE_CORRELATION_ID): EventEnvelopeV1 => ({
  schemaVersion: 1,
  eventId: "evt-0014-004",
  stream,
  streamVersion: 4,
  eventType: "InterviewConducted",
  payload: {
    scores: {
      ...FIXTURE_COMMAND.scores,
      conductedAt: "2026-08-11T09:03:00Z",
    },
  },
  occurredAt: "2026-08-11T09:03:00Z",
  causationId: commandId,
  correlationId,
});

const descriptorFor = (commandId: string): Descriptor => ({
  descriptorVersion: 1,
  kind: "InterviewConductedDescriptor",
  sourceEventId: "evt-0014-004",
  causationId: commandId,
  correlationId: FIXTURE_CORRELATION_ID,
  idempotencyKey: "post-commit:evt-0014-004",
});

const observationFor = (commandId: string): CommandObservation => ({
  outcome: "accepted",
  commandId,
  eventId: "evt-0014-004",
  streamVersion: 4,
  eventCount: 4,
  descriptorCount: 1,
  projection: {
    projectionVersion: 1,
    stream,
    streamVersion: 4,
    status: "completed",
    eventTypes: ["ApplicationReceived", "InterviewInvited", "InterviewAccepted", "InterviewConducted"],
    conductedAt: "2026-08-11T09:03:00Z",
    lawRefs: ["T-INT-1", "S-INT-1", "T-INT-2", "R-APP-1"],
  },
  descriptor: descriptorFor(commandId),
});

const migrationCase = async (sql: string): Promise<CaseRecord> =>
  withMigration(async ({ db }) => {
    const before = await rowCounts(db);
    const schemaRows = await dbRows<Record<string, unknown>>(
      db,
      `SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY type, name;`,
    );
    const tableNames = schemaRows.filter((row) => row.type === "table").map((row) => String(row.name));
    const triggerNames = schemaRows.filter((row) => row.type === "trigger").map((row) => String(row.name));
    const requiredTables = ["command_receipts", "stream_heads", "tutor_events"];
    assert(requiredTables.every((tableName) => tableNames.includes(tableName)), "migration table set mismatch");
    assert(!/\bBEGIN\s+TRANSACTION\b|\bCOMMIT\b/i.test(sql), "migration contains explicit transaction delimiter");
    const after = await rowCounts(db);
    return caseRecord("adr-01-migration", "accepted", "MIGRATION_APPLIED", "migration", before, after, ["schema"], {
      migrationOperation: "D1Database.prepare(...).run",
      tableNames,
      triggerNames,
      strictTables: true,
    });
  });

const seedCase = async (): Promise<CaseRecord> =>
  withMigration(async ({ db }) => {
    const before = await rowCounts(db);
    await seedStream(db);
    const after = await rowCounts(db);
    const replay = (await readReplay(db)) as { readonly events: ReadonlyArray<EventEnvelopeV1>; readonly folded: { readonly events: ReadonlyArray<EventEnvelopeV1> } };
    assert(replay.events.length === 3 && replay.folded.events.length === 3, "seed replay count mismatch");
    assert(after.command_receipts === 0, "seed created receipt");
    return caseRecord("adr-02-seed", "accepted", "SEED_ACCEPTED", FIXTURE_ID, before, after, ["fixture", "seed"], {
      currentVersion: 3,
      lastCommandId: FIXTURE_ID,
      eventIds: replay.events.map((event) => event.eventId),
      projectionStatus: "accepted",
    });
  });

const appendAcceptedCase = async (): Promise<{ readonly record: CaseRecord; readonly result: D1AppendResult; readonly observation: CommandObservation; readonly plan: Readonly<Record<string, unknown>> }> =>
  withSeed(async ({ db }) => {
    const before = await rowCounts(db);
    const result = await append(db, FIXTURE_COMMAND);
    assert(result._tag === "AcceptedResult", "accepted command did not append");
    assert(result.batchResults[0]?.length === 1, "CAS result did not contain one row");
    const returned = result.batchResults[0]?.[0];
    assert(returned?.current_version === 4 && returned.last_command_id === FIXTURE_COMMAND.commandId, "CAS result tuple mismatch");
    const after = await rowCounts(db);
    assert(after.stream_heads === before.stream_heads && after.tutor_events === before.tutor_events + 1 && after.command_receipts === before.command_receipts + 1, "accepted counts mismatch");
    return {
      result,
      observation: result.observation,
      plan: {
        sql: result.batchPlan.statements.map((statement) => statement.sql),
        binds: result.batchPlan.statements.map((statement) => statement.binds),
        resultIndexes: [0, 1, 2],
        returned,
      },
      record: caseRecord("adr-04-accepted-append", "accepted", "APPEND_COMMITTED", FIXTURE_COMMAND.commandId, before, after, ["candidate"], {
        resultZero: returned,
        eventId: result.event.eventId,
        newVersion: result.batchPlan.newVersion,
        descriptorExposedAfterCommit: true,
      }),
    };
  });

const runJourney = async (schemaHash: string): Promise<D1Evidence> => {
  const runtime = await openRuntime();
  activeRuntime = runtime;
  try {
    const cases: Array<CaseRecord> = [];
  cases.push(await migrationCase(await migrationSql()));
  cases.push(await seedCase());
  cases.push(
    await withMigration(async ({ db }) => {
      const before = await rowCounts(db);
      const missingCommand = { ...FIXTURE_COMMAND, commandId: "cmd-0017-missing-head", stream: { ...stream, personId: "person-synth-0017-missing-head" } };
      const failure = await expectFailure<TutorD1Failure>(append(db, missingCommand), (error) => errorReason(error) === "EMPTY_STREAM", "missing head");
      const after = await rowCounts(db);
      assert(JSON.stringify(before) === JSON.stringify(after), "missing head changed rows");
      return caseRecord("adr-03-no-stream-creation", "rejected", "EMPTY_STREAM", missingCommand.commandId, before, after, ["candidate"], { failureTag: errorTag(failure), noWrite: true });
    }),
  );
  const accepted = await appendAcceptedCase();
  cases.push(accepted.record);
  cases.push(
    await withSeed(async ({ db }) => {
      const acceptedResult = await append(db, FIXTURE_COMMAND);
      assert(acceptedResult._tag === "AcceptedResult", "replay fixture append failed");
      const before = await rowCounts(db);
      const replay = (await readReplay(db)) as { readonly events: ReadonlyArray<EventEnvelopeV1>; readonly folded: { readonly events: ReadonlyArray<EventEnvelopeV1> } };
      assert(replay.events.map((event) => event.eventId).join(",") === "evt-0014-001,evt-0014-002,evt-0014-003,evt-0014-004", "replay event order mismatch");
      assert(replay.folded.events.length === 4, "replay fold count mismatch");
      const after = await rowCounts(db);
      return caseRecord("adr-05-replay-accepted", "accepted", "REPLAY_ACCEPTED", FIXTURE_COMMAND.commandId, before, after, ["fixture", "replay"], { eventOrder: replay.events.map((event) => event.eventId), streamVersion: 4 });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      await append(db, FIXTURE_COMMAND);
      const before = await rowCounts(db);
      const malformed = { ...FIXTURE_COMMAND, commandId: "cmd-0014-malformed", extraField: "reject" };
      const failure = await expectFailure<TutorD1Failure>(append(db, malformed), (error) => errorReason(error) === "DECODE_ERROR", "malformed command");
      const after = await rowCounts(db);
      assert(JSON.stringify(before) === JSON.stringify(after), "malformed command changed rows");
      return caseRecord("adr-06-malformed", "rejected", "DECODE_ERROR", malformed.commandId, before, after, ["candidate"], { failureTag: errorTag(failure), noWrite: true });
    }),
  );
  cases.push(
    await withMigration(async ({ db }) => {
      const before = await rowCounts(db);
      const command = { ...FIXTURE_COMMAND, commandId: "cmd-0017-missing-head", stream: { ...stream, personId: "person-synth-0017-missing-head" } };
      const failure = await expectFailure<TutorD1Failure>(append(db, command), (error) => errorReason(error) === "EMPTY_STREAM", "missing head classification");
      const after = await rowCounts(db);
      assert(JSON.stringify(before) === JSON.stringify(after), "missing head classification wrote rows");
      return caseRecord("adr-07-empty-stream", "rejected", "EMPTY_STREAM", command.commandId, before, after, ["candidate"], { failureTag: errorTag(failure) });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      const before = await rowCounts(db);
      const headBefore = await readFixtureHead(db);
      assert(headBefore !== null, "divergence preflight head missing");
      await dbExec(db, `UPDATE stream_heads SET current_version = 2, last_command_id = ?1 WHERE person_id = ?2;`, ["diverged-head", stream.personId]);
      const failure = await expectFailure<TutorD1Failure>(append(db, { ...FIXTURE_COMMAND, commandId: "cmd-0017-divergence" }), (error) => errorTag(error) === "D1IntegrityError", "head divergence");
      const after = await rowCounts(db);
      const headAfter = await readFixtureHead(db);
      assert(headAfter !== null && headBefore.current_version === 3 && headBefore.last_command_id === FIXTURE_ID, "divergence preflight head mismatch");
      assert(headAfter.current_version === 2 && headAfter.last_command_id === "diverged-head", "divergence head was repaired");
      assert(after.tutor_events === before.tutor_events && after.command_receipts === before.command_receipts, "divergence changed event or receipt rows");
      return caseRecord("adr-08-head-event-divergence", "drift", "D1_INTEGRITY", "cmd-0017-divergence", before, after, ["fixture", "candidate"], { failureTag: errorTag(failure), preservedHead: true, headBefore, headAfter });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      const before = await rowCounts(db);
      const headBefore = await readFixtureHead(db);
      assert(headBefore !== null, "stale preflight head missing");
      const command = { ...FIXTURE_COMMAND, commandId: "cmd-0014-stale", expectedVersion: 2 };
      const failure = await expectFailure<TutorD1Failure>(append(db, command), (error) => errorReason(error) === "STALE_VERSION", "stale version");
      const after = await rowCounts(db);
      const headAfter = await readFixtureHead(db);
      assert(headAfter !== null && JSON.stringify(headBefore) === JSON.stringify(headAfter), "stale changed head");
      assert(JSON.stringify(before) === JSON.stringify(after), "stale changed rows");
      return caseRecord("adr-09-stale-version", "stale", "STALE_VERSION", command.commandId, before, after, ["candidate"], { failureTag: errorTag(failure), headBefore, headAfter });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      await append(db, FIXTURE_COMMAND);
      const before = await rowCounts(db);
      const command = { ...FIXTURE_COMMAND, commandId: "cmd-0014-terminal", expectedVersion: 4 };
      const failure = await expectFailure<TutorD1Failure>(append(db, command), (error) => errorReason(error) === "TERMINAL_CONDUCTED", "terminal command");
      const after = await rowCounts(db);
      assert(JSON.stringify(before) === JSON.stringify(after), "terminal changed rows");
      return caseRecord("adr-10-terminal", "terminal", "TERMINAL_CONDUCTED", command.commandId, before, after, ["fixture", "candidate"], { failureTag: errorTag(failure) });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      await append(db, FIXTURE_COMMAND);
      const before = await rowCounts(db);
      const duplicate = await append(db, FIXTURE_COMMAND);
      assert(duplicate._tag === "DuplicateResult", "exact duplicate did not return stored result");
      const after = await rowCounts(db);
      assert(JSON.stringify(before) === JSON.stringify(after), "duplicate changed rows");
      return caseRecord("adr-11-global-duplicate", "duplicate", "DUPLICATE_IDEMPOTENT", FIXTURE_COMMAND.commandId, before, after, ["fixture", "ledger"], { resultBytesEqual: duplicate.resultBytes.length > 0, terminalValidationSkipped: true });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      await append(db, FIXTURE_COMMAND);
      const before = await rowCounts(db);
      const command = { ...FIXTURE_COMMAND, stream: { ...stream, personId: "person-synth-0014-other" } };
      const failure = await expectFailure<TutorD1Failure>(append(db, command), (error) => errorReason(error) === "DUPLICATE_COMMAND_CONFLICT", "changed global duplicate");
      const after = await rowCounts(db);
      assert(JSON.stringify(before) === JSON.stringify(after), "duplicate conflict changed rows");
      return caseRecord("adr-12-cross-stream-duplicate", "duplicate-conflict", "DUPLICATE_COMMAND_CONFLICT", FIXTURE_COMMAND.commandId, before, after, ["fixture", "ledger"], { failureTag: errorTag(failure), streamValidationSkipped: true });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      const before = await rowCounts(db);
      const headBefore = await readFixtureHead(db);
      assert(headBefore !== null, "race preflight head missing");
      let markAReady: () => void = () => {};
      let markBReady: () => void = () => {};
      let releaseA: () => void = () => {};
      let releaseB: () => void = () => {};
      const readyA = new Promise<void>((resolve) => { markAReady = resolve; });
      const readyB = new Promise<void>((resolve) => { markBReady = resolve; });
      const allowA = new Promise<void>((resolve) => { releaseA = resolve; });
      const allowB = new Promise<void>((resolve) => { releaseB = resolve; });
      const bothReady = Promise.all([readyA, readyB]);
      const commandA = { ...FIXTURE_COMMAND, commandId: "cmd-0017-race-a" };
      const commandB = { ...FIXTURE_COMMAND, commandId: "cmd-0017-race-b" };
      const capture = (command: typeof commandA, markReady: () => void, allow: Promise<void>) =>
        append(db, command, {
          beforeBatch: async (_plan) => {
            markReady();
            await bothReady;
            await allow;
          },
        }).then((result) => ({ ok: true as const, result })).catch((error) => ({ ok: false as const, error }));
      const outcomeAPromise = capture(commandA, markAReady, allowA);
      const outcomeBPromise = capture(commandB, markBReady, allowB);
      await bothReady;
      releaseA();
      const outcomeA = await outcomeAPromise;
      assert(outcomeA.ok && outcomeA.result._tag === "AcceptedResult", "race A did not win");
      releaseB();
      const outcomeB = await outcomeBPromise;
      assert(!outcomeB.ok && errorReason(outcomeB.error) === "STALE_VERSION", "race B was not stale");
      const after = await rowCounts(db);
      const headAfter = await readFixtureHead(db);
      assert(headAfter !== null && headAfter.current_version === 4 && headAfter.last_command_id === commandA.commandId, "race winner head mismatch");
      assert(after.tutor_events === before.tutor_events + 1 && after.command_receipts === before.command_receipts + 1, "race wrote more than one append");
      return caseRecord("adr-13-same-version-race", "accepted", "RACE_ONE_CAS_WINNER", `${commandA.commandId}|${commandB.commandId}`, before, after, ["competing-writer", "candidate"], { outcomeTags: ["A:AcceptedResult", "B:StaleState:STALE_VERSION"], headBefore, headAfter });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      const before = await rowCounts(db);
      const headBefore = await readFixtureHead(db);
      assert(headBefore !== null, "older-event preflight head missing");
      const oldEvent = conductedEventFor("cmd-0017-old-event");
      const candidateCommand = { ...FIXTURE_COMMAND, commandId: "cmd-0017-advance-a" };
      let candidatePlan: BatchPlan | undefined;
      const failure = await expectFailure<TutorD1Failure>(append(db, candidateCommand, {
        beforeBatch: async (plan) => {
          candidatePlan = plan;
          await dbExec(db, `INSERT INTO tutor_events (person_id, department_id, semester_year, semester_term, event_id, stream_version, schema_version, event_type, envelope_bytes, occurred_at, causation_id, correlation_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);`, [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term, oldEvent.eventId, oldEvent.streamVersion, oldEvent.schemaVersion, oldEvent.eventType, canonicalJsonBytes(oldEvent), oldEvent.occurredAt, oldEvent.causationId, oldEvent.correlationId]);
          await dbExec(db, `UPDATE stream_heads SET current_version = ?1, last_command_id = ?2 WHERE person_id = ?3 AND department_id = ?4 AND semester_year = ?5 AND semester_term = ?6;`, [4, oldEvent.causationId, stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term]);
        },
      }), (error) => errorReason(error) === "STALE_VERSION", "older event causation FK");
      const after = await rowCounts(db);
      const headAfter = await readFixtureHead(db);
      assert(candidatePlan !== undefined, "older-event candidate plan missing");
      const candidateEventBinds = candidatePlan.statements[1].binds;
      const candidateReceiptBinds = candidatePlan.statements[2].binds;
      const candidateCausationId = candidateEventBinds[5];
      assert(candidatePlan.commandId === candidateCommand.commandId && candidatePlan.eventId === oldEvent.eventId && candidatePlan.newVersion === oldEvent.streamVersion, "older-event candidate plan identity mismatch");
      assert(candidateCausationId === candidateCommand.commandId && candidateCausationId !== oldEvent.causationId, "older-event candidate causation mismatch");
      assert(candidateReceiptBinds[4] === candidateCommand.commandId && candidateReceiptBinds[9] === candidatePlan.eventId && candidateReceiptBinds[10] === candidatePlan.newVersion, "older-event receipt plan mismatch");
      const fkCandidateReceipt = { eventId: candidateReceiptBinds[9], eventStreamVersion: candidateReceiptBinds[10], commandId: candidateReceiptBinds[4] };
      const existingOldEvent = (await dbRows<Record<string, unknown>>(db, `SELECT event_id, stream_version, causation_id FROM tutor_events WHERE event_id = ?1 AND stream_version = ?2;`, [oldEvent.eventId, oldEvent.streamVersion]))[0];
      assert(headAfter !== null && headAfter.current_version === 4 && headAfter.last_command_id === oldEvent.causationId, "older-event setup head mismatch");
      assert(existingOldEvent?.event_id === candidatePlan.eventId && existingOldEvent.stream_version === candidatePlan.newVersion && existingOldEvent.causation_id === oldEvent.causationId, "older-event causation fixture mismatch");
      assert(fkCandidateReceipt.eventId === existingOldEvent.event_id && fkCandidateReceipt.eventStreamVersion === existingOldEvent.stream_version && fkCandidateReceipt.commandId === candidateCausationId, "older-event FK candidate mismatch");
      assert(after.stream_heads === before.stream_heads && after.tutor_events === before.tutor_events + 1 && after.command_receipts === before.command_receipts, "older event candidate was not rolled back");
      return caseRecord("adr-14a-older-event-causation", "stale", "STALE_VERSION", candidateCommand.commandId, before, after, ["fixture-setup", "candidate"], { failureTag: errorTag(failure), setupCausationId: existingOldEvent.causation_id, candidateCausationId, receiptAttachment: false, fkRejected: true, fkColumns: ["person_id", "department_id", "semester_year", "semester_term", "event_id", "event_stream_version", "command_id"], fkExistingEvent: { eventId: existingOldEvent.event_id, streamVersion: existingOldEvent.stream_version, causationId: existingOldEvent.causation_id }, fkCandidateReceipt, candidateRollback: true, headBefore, headAfter });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      const before = await rowCounts(db);
      const headBefore = await readFixtureHead(db);
      assert(headBefore !== null, "beyond-version preflight head missing");
      const failure = await expectFailure<TutorD1Failure>(append(db, { ...FIXTURE_COMMAND, commandId: "cmd-0017-advance-a" }, {
        beforeBatch: async () => {
          await dbExec(db, `UPDATE stream_heads SET current_version = 5, last_command_id = ?1 WHERE person_id = ?2;`, ["cmd-0017-advance-b", stream.personId]);
        },
      }), (error) => errorReason(error) === "STALE_VERSION", "beyond version race");
      const after = await rowCounts(db);
      const headAfter = await readFixtureHead(db);
      assert(headAfter !== null && headAfter.current_version === 5 && headAfter.last_command_id === "cmd-0017-advance-b", "beyond-version setup head mismatch");
      assert(after.tutor_events === before.tutor_events && after.command_receipts === before.command_receipts, "beyond-version batch left candidate rows");
      return caseRecord("adr-14b-beyond-version", "stale", "STALE_VERSION", "cmd-0017-advance-a", before, after, ["fixture-setup", "candidate"], { failureTag: errorTag(failure), setupHeadVersion: 5, setupHeadToken: "cmd-0017-advance-b", lawfulFifthEvent: false, candidateRollback: true, headBefore, headAfter });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      const before = await rowCounts(db);
      const headBefore = await readFixtureHead(db);
      assert(headBefore !== null, "receipt-conflict preflight head missing");
      const competingCommand = { ...FIXTURE_COMMAND, correlationId: "corr-0017-competing" };
      const event = { ...conductedEventFor(FIXTURE_COMMAND.commandId), eventId: "evt-0017-receipt-competing", streamVersion: 5 };
      const observation = observationFor(FIXTURE_COMMAND.commandId);
      const failure = await expectFailure<TutorD1Failure>(append(db, { ...FIXTURE_COMMAND }, {
        beforeBatch: async (_plan) => {
          await dbExec(db, `INSERT INTO tutor_events (person_id, department_id, semester_year, semester_term, event_id, stream_version, schema_version, event_type, envelope_bytes, occurred_at, causation_id, correlation_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);`, [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term, event.eventId, event.streamVersion, event.schemaVersion, event.eventType, canonicalJsonBytes(event), event.occurredAt, event.causationId, event.correlationId]);
          await dbExec(db, `INSERT INTO command_receipts (person_id, department_id, semester_year, semester_term, command_id, command_bytes, command_sha256, result_bytes, descriptor_bytes, event_id, event_stream_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);`, [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term, FIXTURE_COMMAND.commandId, canonicalJsonBytes(competingCommand), sha256Hex(canonicalJsonBytes(competingCommand)), canonicalJsonBytes(observation), canonicalJsonBytes(observation.descriptor), event.eventId, event.streamVersion]);
        },
      }), (error) => errorReason(error) === "DUPLICATE_COMMAND_CONFLICT", "receipt primary-key conflict");
      const after = await rowCounts(db);
      const headAfter = await readFixtureHead(db);
      assert(headAfter !== null && JSON.stringify(headBefore) === JSON.stringify(headAfter), "receipt conflict changed head");
      assert(after.stream_heads === before.stream_heads && after.tutor_events === before.tutor_events + 1 && after.command_receipts === before.command_receipts + 1, "receipt conflict candidate changed rows");
      return caseRecord("adr-15a-receipt-primary-key", "duplicate-conflict", "DUPLICATE_COMMAND_CONFLICT", FIXTURE_COMMAND.commandId, before, after, ["fixture-setup", "competing-writer", "candidate"], { uniqueness: "command_receipts PRIMARY KEY", failureTag: errorTag(failure), candidateRollback: true, secondLedgerClassification: true, headBefore, headAfter });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      const before = await rowCounts(db);
      const headBefore = await readFixtureHead(db);
      assert(headBefore !== null, "event-unique preflight head missing");
      const event = conductedEventFor("cmd-0017-event-unique");
      const failure = await expectFailure<TutorD1Failure>(append(db, { ...FIXTURE_COMMAND, commandId: "cmd-0017-event-unique" }, {
        beforeBatch: async () => {
          await dbExec(db, `INSERT INTO tutor_events (person_id, department_id, semester_year, semester_term, event_id, stream_version, schema_version, event_type, envelope_bytes, occurred_at, causation_id, correlation_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);`, [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term, event.eventId, event.streamVersion, event.schemaVersion, event.eventType, canonicalJsonBytes(event), event.occurredAt, event.causationId, event.correlationId]);
        },
      }), (error) => errorTag(error) === "D1BatchError", "event uniqueness failure");
      const after = await rowCounts(db);
      const headAfter = await readFixtureHead(db);
      assert(headAfter !== null && JSON.stringify(headBefore) === JSON.stringify(headAfter), "event uniqueness changed head");
      assert(after.stream_heads === before.stream_heads && after.tutor_events === before.tutor_events + 1 && after.command_receipts === before.command_receipts, "event uniqueness candidate changed rows");
      return caseRecord("adr-15b-event-unique", "drift", "D1_BATCH_FAILURE", "cmd-0017-event-unique", before, after, ["fixture-setup", "candidate"], { failureTag: errorTag(failure), uniqueness: "tutor_events stream_version/event_id", candidateRollback: true, headBefore, headAfter });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      await append(db, FIXTURE_COMMAND);
      const before = await rowCounts(db);
      const event = (await dbRows<Record<string, unknown>>(db, `SELECT event_id FROM tutor_events WHERE event_id = ?1;`, ["evt-0014-004"]))[0];
      assert(event !== undefined, "trigger fixture event missing");
      const triggerErrors: string[] = [];
      for (const sql of ["UPDATE tutor_events SET occurred_at = occurred_at WHERE event_id = 'evt-0014-004';", "DELETE FROM tutor_events WHERE event_id = 'evt-0014-004';", "UPDATE command_receipts SET command_sha256 = command_sha256 WHERE command_id = 'cmd-0014-conduct';", "DELETE FROM command_receipts WHERE command_id = 'cmd-0014-conduct';"]) {
        try {
          await dbExec(db, sql);
        } catch (error) {
          triggerErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      assert(triggerErrors.length === 4, "not all immutable trigger operations failed");
      assert(triggerErrors.every((message) => message.includes("immutable")), "immutable trigger message missing");
      const after = await rowCounts(db);
      assert(JSON.stringify(before) === JSON.stringify(after), "trigger operations changed rows");
      return caseRecord("adr-16-immutable-triggers", "rejected", "IMMUTABLE_TRIGGER_ABORT", FIXTURE_COMMAND.commandId, before, after, ["fixture", "trigger"], { triggerMessages: triggerErrors.map((message) => message.includes("tutor_events") ? "tutor_events are immutable" : "command_receipts are immutable") });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      await append(db, FIXTURE_COMMAND);
      const rows = (await dbRows<Record<string, unknown>>(db, REPLAY_SQL, [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term])) as unknown as ReadonlyArray<ReplayEventRow>;
      const normalizedRows = rows.map((row) => ({ ...row, envelope_bytes: Array.from(normalizeBlobBytes(row.envelope_bytes)) }));
      const replay = await runWithTutorD1(db as unknown as D1Binding, validateReplayRows(stream, normalizedRows));
      assert(replay.events.length === 4 && replay.folded.events.length === 4, "number-array normalization did not replay");
      const before = await rowCounts(db);
      const after = await rowCounts(db);
      return caseRecord("adr-17-number-array-blob", "accepted", "BLOB_NORMALIZED", FIXTURE_COMMAND.commandId, before, after, ["fixture", "adapter-boundary"], { runtimeType: "number[]", normalizedType: "Uint8Array", fatalUtf8: true, exactReencode: true });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      const rows = (await dbRows<Record<string, unknown>>(db, REPLAY_SQL, [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term])) as unknown as ReadonlyArray<ReplayEventRow>;
      const wrongValues: ReadonlyArray<unknown> = ["not-bytes", { bytes: [1, 2] }, null, [0, 256]];
      const failures: string[] = [];
      for (const wrong of wrongValues) {
        try {
          await runWithTutorD1(db as unknown as D1Binding, validateReplayRows(stream, [{ ...rows[0]!, envelope_bytes: wrong }]));
        } catch (error) {
          failures.push(`${errorTag(error)}:${errorReason(error)}`);
        }
      }
      assert(failures.length === wrongValues.length && failures.every((failure) => failure.startsWith("D1IntegrityError:D1_INTEGRITY")), "wrong BLOB values did not fail closed");
      const counts = await rowCounts(db);
      return caseRecord("adr-18-wrong-blob-runtime-type", "drift", "BLOB_INTEGRITY_FAILURE", "adapter-boundary", counts, counts, ["fixture", "adapter-boundary"], { failures, foldInvoked: false, descriptorExposed: false });
    }),
  );
  cases.push(
    await withSeed(async ({ db }) => {
      assert(accepted.result._tag === "AcceptedResult", "accepted SQL plan missing");
      const acceptedResult = accepted.result;
      const before = await rowCounts(db);
      const headBefore = await readFixtureHead(db);
      assert(headBefore !== null, "stale SQL preflight head missing");
      const staleCommand = { ...FIXTURE_COMMAND, commandId: "cmd-0017-sql-stale" };
      let stalePlan: BatchPlan | undefined;
      const stale = await expectFailure<TutorD1Failure>(append(db, staleCommand, {
        beforeBatch: async (plan) => {
          stalePlan = plan;
          await dbExec(db, `UPDATE stream_heads SET current_version = current_version + 1, last_command_id = ?1 WHERE person_id = ?2;`, ["cmd-0017-sql-race", stream.personId]);
        },
      }), (error) => errorReason(error) === "STALE_VERSION", "stale SQL batch");
      assert(stalePlan !== undefined, "stale batch plan was not captured");
      const acceptedSql = acceptedResult.batchPlan.statements.map((statement) => statement.sql);
      const staleSql = stalePlan.statements.map((statement) => statement.sql);
      const sqlTexts = [...acceptedSql, ...staleSql];
      assert(sqlTexts.every((sql) => /\?[0-9]+/.test(sql) && !/:[a-zA-Z]/.test(sql)), "SQL placeholder contract failed");
      assert(acceptedResult.batchPlan.statements[0]?.binds.length === 7 && acceptedResult.batchPlan.statements[1]?.binds.length === 12 && acceptedResult.batchPlan.statements[2]?.binds.length === 11, "bind cardinality mismatch");
      const after = await rowCounts(db);
      const headAfter = await readFixtureHead(db);
      assert(headBefore.current_version === 3 && headBefore.last_command_id === FIXTURE_ID, "stale SQL preflight head mismatch");
      assert(headAfter !== null && headAfter.current_version === 4 && headAfter.last_command_id === "cmd-0017-sql-race", "stale SQL setup head mismatch");
      assert(JSON.stringify(before) === JSON.stringify(after), "stale SQL batch changed rows");
      return caseRecord("adr-19-numbered-sql-binds", "stale", "NUMBERED_SQL_VERIFIED", staleCommand.commandId, before, after, ["candidate", "batch-result"], { sqlTexts, bindOrder: { accepted: acceptedResult.batchPlan.statements.map((statement) => statement.binds), stale: stalePlan.statements.map((statement) => statement.binds) }, resultIndexes: [0, 1, 2], resultZero: acceptedResult.batchResults[0], staleFailure: `${errorTag(stale)}:${errorReason(stale)}`, headBefore, headAfter });
    }),
  );
  cases.push(await replayCases());

  const acceptedReplay = await withSeed(async ({ db }) => {
    await append(db, FIXTURE_COMMAND);
    const result = (await readReplay(db)) as ReplayResult;
    const projection = projectFoldedState(result.folded);
    const counts = await rowCounts(db);
    return { result, projection, counts };
  });
  const descriptor = accepted.observation.descriptor;
  const reasonCounts: Record<string, number> = {};
  for (const item of cases) reasonCounts[item.reasonCode] = (reasonCounts[item.reasonCode] ?? 0) + 1;
  return {
    formatVersion: 1,
    specId: SPEC_ID,
    baseCommit: BASE_COMMIT,
    adrSha256: ADR_SHA256,
    predecessorCommit: PREDECESSOR_COMMIT,
    fixtureId: FIXTURE_ID,
    schemaMigrationId: "0017-0001-tutor-event-store",
    schemaHash,
    localEffectVersion: EFFECT_VERSION,
    localEffectSourceHashes: {
      d1Client: D1_CLIENT_SOURCE_HASH,
      statement: STATEMENT_SOURCE_HASH,
      sqlEventJournal: SQL_EVENT_JOURNAL_SOURCE_HASH,
      migrator: MIGRATOR_SOURCE_HASH,
      sqlClient: SQL_CLIENT_SOURCE_HASH,
    },
    localMiniflareVersion: MINIFLARE_VERSION,
    correlationId: FIXTURE_CORRELATION_ID,
    stream,
    seedHead: {
      person_id: FIXTURE_PERSON_ID,
      department_id: FIXTURE_DEPARTMENT_ID,
      semester_year: 2026,
      semester_term: "Vår",
      current_version: 3,
      last_command_id: FIXTURE_ID,
    },
    seedEvents: FIXTURE_SEED_EVENTS.map((event) => ({ eventId: event.eventId, streamVersion: event.streamVersion, eventType: event.eventType, occurredAt: event.occurredAt, causationId: event.causationId, correlationId: event.correlationId })),
    batch: {
      accepted: accepted.plan,
      stale: cases.find((item) => item.caseId === "adr-19-numbered-sql-binds")?.details,
      resultIndexes: [0, 1, 2],
      exactBindCardinality: [7, 12, 11],
    },
    cases,
    replay: {
      query: REPLAY_SQL,
      bindOrder: ["personId", "departmentId", "semesterYear", "semesterTerm"],
      eventOrder: acceptedReplay.result.events.map((event) => event.eventId),
      decoder: ["ApplicationReceived:1", "InterviewInvited:1", "InterviewAccepted:1", "InterviewConducted:1"],
      persistedBadRowsFailClosed: true,
      adapterArrayLimit: ["duplicate-event-id", "duplicate-stream-version", "cross-stream-row"],
    },
    projection: acceptedReplay.projection,
    effectDescriptors: [descriptor],
    rowCounts: {
      finalCanonicalStream: acceptedReplay.counts,
      acceptedStreamVersion: 4,
      acceptedReceiptCount: 1,
      eventIds: acceptedReplay.result.events.map((event) => event.eventId),
    },
    limits: [
      "local-miniflare-only",
      "one-disposable-binding-per-journey-run-reset-between-cases",
      "no-provider-or-remote-binding",
      "no-worker-route-or-public-url",
      "no-credentials-or-production-data",
      "no-remote-d1-result-shape-proof",
      "no-replica-session-or-bookmark-proof",
      "no-deployment-cutover-or-operator-proof",
      "no-status-or-projection-table",
      "descriptor-is-inert-and-not-interpreted",
      "adapter-array-duplicate-and-cross-stream-cases-are-fold-input-only",
    ],
    provenance: {
      pinnedBunVersion: PINNED_BUN_VERSION,
      miniflareSetup: { modules: true, script: "", d1Binding: D1_BINDING_NAME, operation: "D1Database.prepare(...).run" },
      migrationAppliedOrder: ["0017-0001-tutor-event-store"],
      reasonCounts,
      sourceCommit: BASE_COMMIT,
      sourceCandidateParent: SOURCE_CANDIDATE_PARENT,
      sourceCandidateCommit: SOURCE_CANDIDATE_COMMIT,
      canonicalIntegrationBase: CANONICAL_INTEGRATION_BASE,
      canonicalD1IntegrationCommit: CANONICAL_D1_INTEGRATION_COMMIT,
      noNetwork: true,
    },
  };
  } finally {
    activeRuntime = undefined;
    await runtime.miniflare.dispose();
  }
};

const replayCases = async (): Promise<CaseRecord> => {
  type BadRow = {
    readonly caseId: string;
    readonly reasonCode: string;
    readonly makeEvent: (base: EventEnvelopeV1) => {
      readonly event: EventEnvelopeV1;
      readonly indexed: Readonly<Record<string, unknown>>;
    };
  };
  const badRows: ReadonlyArray<BadRow> = [
    { caseId: "unknown-schema", reasonCode: "UNKNOWN_DECODER", makeEvent: (base) => ({ event: base, indexed: { schema_version: 99 } }) },
    { caseId: "version-gap", reasonCode: "REPLAY_FOLD", makeEvent: (base) => ({ event: { ...base, streamVersion: 5 }, indexed: {} }) },
    { caseId: "occurred-at-rewind", reasonCode: "REPLAY_FOLD", makeEvent: (base) => ({ event: { ...base, occurredAt: "2026-08-11T08:59:00Z" }, indexed: {} }) },
    { caseId: "correlation-mismatch", reasonCode: "REPLAY_FOLD", makeEvent: (base) => ({ event: { ...base, correlationId: "corr-0017-other" }, indexed: {} }) },
    { caseId: "indexed-envelope-mismatch", reasonCode: "ROW_INDEX_MISMATCH", makeEvent: (base) => ({ event: base, indexed: { event_id: "evt-0017-index" } }) },
    { caseId: "decoded-envelope-stream-mismatch", reasonCode: "ROW_INDEX_MISMATCH", makeEvent: (base) => ({ event: { ...base, stream: { ...stream, personId: "person-synth-0017-other" } }, indexed: {} }) },
  ];
  const insertReplayRow = async (db: LocalBinding, event: EventEnvelopeV1, indexed: Readonly<Record<string, unknown>>): Promise<void> => {
    const row = {
      person_id: stream.personId,
      department_id: stream.cycle.departmentId,
      semester_year: stream.cycle.semester.year,
      semester_term: stream.cycle.semester.term,
      event_id: event.eventId,
      stream_version: event.streamVersion,
      schema_version: event.schemaVersion,
      event_type: event.eventType,
      envelope_bytes: canonicalJsonBytes(event),
      occurred_at: event.occurredAt,
      causation_id: event.causationId,
      correlation_id: event.correlationId,
      ...indexed,
    };
    await dbExec(db, `INSERT INTO tutor_events (person_id, department_id, semester_year, semester_term, event_id, stream_version, schema_version, event_type, envelope_bytes, occurred_at, causation_id, correlation_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);`, [row.person_id, row.department_id, row.semester_year, row.semester_term, row.event_id, row.stream_version, row.schema_version, row.event_type, row.envelope_bytes, row.occurred_at, row.causation_id, row.correlation_id]);
  };
  const observations: string[] = [];
  for (const bad of badRows) {
    await withSeed(async ({ db }) => {
      const before = await rowCounts(db);
      const { event, indexed } = bad.makeEvent(conductedEventFor(`cmd-0017-replay-${bad.caseId}`));
      await insertReplayRow(db, event, indexed);
      const failure = await expectFailure<TutorD1Failure>(readReplay(db), (error) => errorTag(error) === "D1IntegrityError", `persisted replay ${bad.caseId}`);
      assert(errorReason(failure) === "D1_INTEGRITY", `persisted replay ${bad.caseId} did not enter Drift`);
      const after = await rowCounts(db);
      assert(after.tutor_events === before.tutor_events + 1 && after.command_receipts === before.command_receipts, `persisted replay ${bad.caseId} changed unexpected rows`);
      observations.push(`${bad.caseId}:persisted:D1IntegrityError:${bad.reasonCode}`);
    });
  }
  await withSeed(async ({ db }) => {
    const rows = (await dbRows<Record<string, unknown>>(db, REPLAY_SQL, [stream.personId, stream.cycle.departmentId, stream.cycle.semester.year, stream.cycle.semester.term])) as unknown as ReadonlyArray<ReplayEventRow>;
    const duplicateFailure = await expectFailure<TutorD1Failure>(runWithTutorD1(db as unknown as D1Binding, validateReplayRows(stream, [rows[0]!, rows[0]!, rows[1]!])), (error) => errorTag(error) === "D1IntegrityError", "adapter duplicate event");
    const crossStreamFailure = await expectFailure<TutorD1Failure>(runWithTutorD1(db as unknown as D1Binding, validateReplayRows(stream, [{ ...rows[0]!, person_id: "person-synth-0017-other" }])), (error) => errorTag(error) === "D1IntegrityError", "adapter cross-stream row");
    observations.push(`duplicate-event-id-version:adapter:${errorReason(duplicateFailure)}`, `cross-stream-row:adapter:${errorReason(crossStreamFailure)}`);
  });
  return withSeed(async ({ db }) => {
    const before = await rowCounts(db);
    const valid = (await readReplay(db)) as { readonly events: ReadonlyArray<EventEnvelopeV1>; readonly folded: { readonly events: ReadonlyArray<EventEnvelopeV1> } };
    assert(valid.events.length === 3 && valid.folded.events.length === 3, "valid replay baseline failed");
    const after = await rowCounts(db);
    return caseRecord("adr-20-replay-integrity", "rejected", "REPLAY_BAD_ROWS_FAIL_CLOSED", "replay", before, after, ["fresh-persisted-row", "adapter-row-array"], { observations, validEventOrder: valid.events.map((event) => event.eventId), localPersistenceLimit: ["duplicate-event-id", "duplicate-stream-version", "cross-stream-row"] });
  });
};

const canonicalEvidenceJson = (evidence: D1Evidence): string => {
  const entries: ReadonlyArray<readonly [string, unknown]> = [
    ["formatVersion", evidence.formatVersion],
    ["specId", evidence.specId],
    ["baseCommit", evidence.baseCommit],
    ["adrSha256", evidence.adrSha256],
    ["predecessorCommit", evidence.predecessorCommit],
    ["fixtureId", evidence.fixtureId],
    ["schemaMigrationId", evidence.schemaMigrationId],
    ["schemaHash", evidence.schemaHash],
    ["localEffectVersion", evidence.localEffectVersion],
    ["localEffectSourceHashes", evidence.localEffectSourceHashes],
    ["localMiniflareVersion", evidence.localMiniflareVersion],
    ["correlationId", evidence.correlationId],
    ["stream", evidence.stream],
    ["seedHead", evidence.seedHead],
    ["seedEvents", evidence.seedEvents],
    ["batch", evidence.batch],
    ["cases", evidence.cases],
    ["replay", evidence.replay],
    ["projection", evidence.projection],
    ["effectDescriptors", evidence.effectDescriptors],
    ["rowCounts", evidence.rowCounts],
    ["limits", evidence.limits],
    ["provenance", evidence.provenance],
  ];
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`).join(",")}}`;
};

const renderEvidence = (document: D1Evidence): RenderedEvidence => {
  const canonical = canonicalEvidenceJson(document);
  const bytes = new TextEncoder().encode(`${canonical}\n`);
  return { document, canonicalJson: canonical, bytes, digest: sha256Hex(bytes) };
};

export interface D1ProofRun {
  readonly passed: true;
  readonly evidence: RenderedEvidence;
  readonly secondRender: RenderedEvidence;
  readonly reasonCounts: Readonly<Record<string, number>>;
}

export const runD1Proof = async (): Promise<D1ProofRun> => {
  const sql = await migrationSql();
  const schemaHash = sha256Hex(new TextEncoder().encode(sql));
  const first = await runJourney(schemaHash);
  const second = await runJourney(schemaHash);
  const firstBase = renderEvidence(first);
  const secondBase = renderEvidence(second);
  assert(firstBase.digest === secondBase.digest, "clean local evidence digest changed");
  assert(firstBase.bytes.length === secondBase.bytes.length && firstBase.bytes.every((byte, index) => byte === secondBase.bytes[index]), "clean local evidence bytes changed");
  const repeatDetails = {
    firstByteLength: firstBase.bytes.length,
    secondByteLength: secondBase.bytes.length,
    firstSha256: firstBase.digest,
    secondSha256: secondBase.digest,
    byteIdentical: true,
  };
  const finalDocument: D1Evidence = {
    ...first,
    cases: [...first.cases, caseRecord("adr-21-evidence-repeatability", "accepted", "EVIDENCE_REPEATABLE", FIXTURE_COMMAND.commandId, { stream_heads: 1, tutor_events: 4, command_receipts: 1 }, { stream_heads: 1, tutor_events: 4, command_receipts: 1 }, ["clean-run-a", "clean-run-b"], repeatDetails)],
    provenance: { ...first.provenance, twoRunCanonicalEvidence: repeatDetails },
  };
  const firstRender = renderEvidence(finalDocument);
  const secondRender = renderEvidence(finalDocument);
  assert(firstRender.canonicalJson === secondRender.canonicalJson, "same-document evidence JSON changed");
  assert(firstRender.bytes.length === secondRender.bytes.length && firstRender.bytes.every((byte, index) => byte === secondRender.bytes[index]), "same-document evidence bytes changed");
  const reasonCounts: Record<string, number> = {};
  for (const item of finalDocument.cases) reasonCounts[item.reasonCode] = (reasonCounts[item.reasonCode] ?? 0) + 1;
  return { passed: true, evidence: firstRender, secondRender, reasonCounts };
};

export const main = async (args: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> => {
  if (args.length !== 0) {
    process.stderr.write("usage: bun run src/tutor/d1-proof.ts\n");
    return 1;
  }
  try {
    const run = await runD1Proof();
    process.stdout.write(`${canonicalJson({
      specId: SPEC_ID,
      passed: run.passed,
      caseCount: run.evidence.document.cases.length,
      reasonCounts: run.reasonCounts,
      evidenceByteLength: run.evidence.bytes.length,
      evidenceSha256: run.evidence.digest,
      secondEvidenceSha256: run.secondRender.digest,
      byteIdentical: run.evidence.bytes.every((byte, index) => byte === run.secondRender.bytes[index]),
    })}\n${run.evidence.canonicalJson}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${canonicalJson({ specId: SPEC_ID, passed: false, error: `${errorTag(error)}:${errorReason(error)}` })}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = await main();
