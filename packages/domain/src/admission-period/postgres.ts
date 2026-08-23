import { Database, type DatabaseShape } from "../database/service.js";
import type { DepartmentId } from "../organization/schema.js";
import { Effect, Schema } from "effect";
import { compareRfc3339Instants } from "../time.js";
import {
  AdmissionPeriodDecodeError,
  AdmissionPeriodNotFound,
  AdmissionPeriodPersistenceError,
  AdmissionScopeDenied,
  AdmissionRoleDenied,
  DepartmentNotFound,
  DepartmentRequired,
  DuplicateAdmissionPeriodCommandConflict,
  InactiveActor,
  SemesterNotFound,
  StaleAdmissionPeriodRevision,
  type AdmissionPeriodFailure,
} from "./errors.js";
import { admissionPeriodCommandDigest, canonicalJson } from "./digest.js";
import type { AdmissionPeriodOutboxRequest } from "./effects.js";
import {
  AdmissionDepartment,
  AdmissionPeriod,
  AdmissionPeriodCommandSchema,
  AdmissionPeriodObservationSchema,
  AdmissionPeriodProjectionSchema,
  AdmissionSemester,
  isRfc3339Instant,
  type AdmissionPeriodCommandId,
  type AdmissionPeriodActor,
  type AdmissionPeriodCommand,
  type AdmissionPeriodObservation,
  type AdmissionPeriodProjection,
  type AdmissionSemester as AdmissionSemesterValue,
} from "./schema.js";
import type {
  AdmissionPeriodCommandContext,
  AdmissionPeriodManagementContext,
  AdmissionPeriodTransactionResult,
} from "./context.js";
import { contextForActor, decideAdmissionPeriod } from "./update.js";

interface PeriodCommandReceiptRow {
  readonly command_sha256: string;
  readonly observation_json: unknown;
  readonly admission_period_id: string;
}

const periodPersistenceError = (operation: string, cause: unknown) =>
  new AdmissionPeriodPersistenceError({ operation, message: String(cause) });

const decodePeriodRow = (
  row: typeof AdmissionPeriod.Encoded,
): Effect.Effect<AdmissionPeriod, AdmissionPeriodPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionPeriod)(row, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => periodPersistenceError("decode admission period row", cause)));

const decodeSemesterRow = (
  row: typeof AdmissionSemester.Encoded,
): Effect.Effect<AdmissionSemester, AdmissionPeriodPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionSemester)(row, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => periodPersistenceError("decode admission semester row", cause)),
  );

const decodeProjectionRow = (
  row: typeof AdmissionPeriodProjectionSchema.Encoded,
): Effect.Effect<AdmissionPeriodProjection, AdmissionPeriodPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionPeriodProjectionSchema)(row, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => periodPersistenceError("decode admission period projection", cause)),
  );

const findPeriodForUpdate = (
  sql: DatabaseShape,
  admissionPeriodId: string,
): Effect.Effect<AdmissionPeriod | undefined, AdmissionPeriodPersistenceError> =>
  sql<typeof AdmissionPeriod.Encoded>`
    SELECT admission_period_id AS id, department_id AS "departmentId", semester_id AS "semesterId",
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt",
      revision, last_command_id AS "lastCommandId"
    FROM admission_periods
    WHERE admission_period_id = ${admissionPeriodId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodePeriodRow(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("read admission period", cause)),
    ),
  );

const findPeriodByPairForUpdate = (
  sql: DatabaseShape,
  departmentId: string,
  semesterId: string,
): Effect.Effect<AdmissionPeriod | undefined, AdmissionPeriodPersistenceError> =>
  sql<typeof AdmissionPeriod.Encoded>`
    SELECT admission_period_id AS id, department_id AS "departmentId", semester_id AS "semesterId",
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt",
      revision, last_command_id AS "lastCommandId"
    FROM admission_periods
    WHERE department_id = ${departmentId} AND semester_id = ${semesterId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodePeriodRow(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("read admission period by scope", cause)),
    ),
  );

const findSemester = (
  sql: DatabaseShape,
  semesterId: string,
): Effect.Effect<AdmissionSemester | undefined, AdmissionPeriodPersistenceError> =>
  sql<typeof AdmissionSemester.Encoded>`
    SELECT semester_id AS "semesterId",
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
    FROM admission_period_semesters
    WHERE semester_id = ${semesterId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeSemesterRow(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("read admission semester", cause)),
    ),
  );

const departmentExists = (
  sql: DatabaseShape,
  departmentId: string,
): Effect.Effect<boolean, AdmissionPeriodPersistenceError> =>
  sql<typeof AdmissionDepartment.Encoded>`
    SELECT department_id AS "departmentId", department_id AS name
    FROM admission_period_departments
    WHERE department_id = ${departmentId}
  `.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("read admission department", cause)),
    ),
  );

const findPeriodCommandReceipt = (
  sql: DatabaseShape,
  commandId: string,
): Effect.Effect<PeriodCommandReceiptRow | undefined, AdmissionPeriodPersistenceError> =>
  sql<PeriodCommandReceiptRow>`
    SELECT command_sha256, observation_json, admission_period_id
    FROM admission_period_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("read admission command receipt", cause)),
    ),
  );

const observationFromStored = (
  json: unknown,
): Effect.Effect<
  Extract<AdmissionPeriodObservation, { readonly _tag: "Created" | "Revised" }>,
  AdmissionPeriodPersistenceError
> =>
  Schema.decodeUnknownEffect(AdmissionPeriodObservationSchema)(json, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap((observation) =>
      observation._tag === "Created" || observation._tag === "Revised"
        ? Effect.succeed(observation)
        : Effect.fail(
            periodPersistenceError(
              "stored admission observation is not replayable",
              observation._tag,
            ),
          ),
    ),
    Effect.mapError((cause) =>
      periodPersistenceError("decode stored admission observation", cause),
    ),
  );

const checkActor = (
  actor: AdmissionPeriodActor,
): Effect.Effect<void, InactiveActor | AdmissionRoleDenied> =>
  Effect.gen(function* () {
    if (!actor.active) return yield* new InactiveActor({ personId: actor.personId });
    if (actor._tag !== "DepartmentLeader" && actor._tag !== "GlobalAdmin") {
      return yield* new AdmissionRoleDenied({ personId: actor.personId });
    }
  });

const checkNow = (now: string): Effect.Effect<void, AdmissionPeriodDecodeError> =>
  isRfc3339Instant(now)
    ? Effect.void
    : Effect.fail(new AdmissionPeriodDecodeError({ message: "now must be an RFC 3339 instant" }));

const actorCanAccessDepartment = (actor: AdmissionPeriodActor, departmentId: string): boolean =>
  actor._tag === "GlobalAdmin" || actor.departmentId === departmentId;

const writePeriod = (
  sql: DatabaseShape,
  period: AdmissionPeriod,
  previous: AdmissionPeriod | undefined,
): Effect.Effect<void, AdmissionPeriodFailure> => {
  if (previous === undefined) {
    return sql`
      INSERT INTO admission_periods (
        admission_period_id, department_id, semester_id, start_at, end_at,
        revision, last_command_id
      ) VALUES (
        ${period.id}, ${period.departmentId}, ${period.semesterId},
        ${period.startAt}, ${period.endAt}, ${period.revision}, ${period.lastCommandId}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(periodPersistenceError("insert admission period", cause)),
      ),
    );
  }

  return sql`
    UPDATE admission_periods
    SET start_at = ${period.startAt},
        end_at = ${period.endAt},
        revision = ${period.revision},
        last_command_id = ${period.lastCommandId}
    WHERE admission_period_id = ${period.id}
      AND revision = ${previous.revision}
    RETURNING admission_period_id
  `.pipe(
    Effect.flatMap((rows) =>
      rows.length === 1
        ? Effect.void
        : Effect.fail(
            new StaleAdmissionPeriodRevision({
              admissionPeriodId: period.id,
              expected: previous.revision,
              actual: previous.revision,
            }),
          ),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("update admission period", cause)),
    ),
  );
};

const writePeriodCommandReceipt = (
  sql: DatabaseShape,
  command: AdmissionPeriodCommand,
  commandDigest: string,
  observation: AdmissionPeriodObservation,
  period: AdmissionPeriod,
  now: string,
): Effect.Effect<void, AdmissionPeriodPersistenceError> =>
  sql`
  INSERT INTO admission_period_command_receipts (
    command_id, command_sha256, command_json, observation_json,
    admission_period_id, committed_at
  ) VALUES (
    ${command.commandId}, ${commandDigest}, ${sql.json(JSON.parse(canonicalJson(command)))},
    ${sql.json(observation)}, ${period.id}, ${now}
  )
`.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("insert admission command receipt", cause)),
    ),
  );

const writeOutbox = (
  sql: DatabaseShape,
  requests: ReadonlyArray<AdmissionPeriodOutboxRequest>,
): Effect.Effect<void, AdmissionPeriodPersistenceError> =>
  Effect.forEach(
    requests,
    (request, ordinal) =>
      sql`
      INSERT INTO admission_period_outbox (
        effect_id, effect_type, admission_period_id, command_id, ordinal, payload_json
      ) VALUES (
        ${request.effectId}, ${request._tag}, ${request.admissionPeriodId},
        ${request.commandId}, ${ordinal}, ${sql.json(request)}
      )
    `.pipe(Effect.asVoid),
    { discard: true },
  ).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("insert admission outbox", cause)),
    ),
  );

const writeAudit = (
  sql: DatabaseShape,
  command: AdmissionPeriodCommand,
  period: AdmissionPeriod,
  actorPersonId: string,
  action: string,
  now: string,
): Effect.Effect<void, AdmissionPeriodPersistenceError> =>
  sql`
  INSERT INTO admission_period_audit (
    command_id, admission_period_id, actor_person_id, action,
    admission_period_revision, occurred_at
  ) VALUES (
    ${command.commandId}, ${period.id}, ${actorPersonId},
    ${action}, ${period.revision}, ${now}
  )
`.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("insert admission audit", cause)),
    ),
  );

const replayPeriodResult = (
  commandId: AdmissionPeriodCommandId,
  observation: Extract<AdmissionPeriodObservation, { readonly _tag: "Created" | "Revised" }>,
): AdmissionPeriodTransactionResult => ({
  period: observation.period,
  observation: { _tag: "Replayed", commandId, original: observation },
  replayed: true,
  outboxCount: 0,
});

const effectiveCreateDepartment = (
  command: Extract<AdmissionPeriodCommand, { readonly _tag: "CreateAdmissionPeriod" }>,
  actor: AdmissionPeriodActor,
): Effect.Effect<DepartmentId, AdmissionPeriodFailure> => {
  if (actor._tag === "DepartmentLeader") {
    if (command.departmentId !== undefined && command.departmentId !== actor.departmentId) {
      return Effect.fail(
        new AdmissionScopeDenied({
          personId: actor.personId,
          departmentId: command.departmentId,
        }),
      );
    }
    return Effect.succeed(actor.departmentId);
  }
  if (command.departmentId === undefined) return Effect.fail(new DepartmentRequired());
  return Effect.succeed(command.departmentId);
};

export const decodeAdmissionPeriodCommand = (
  input: unknown,
): Effect.Effect<AdmissionPeriodCommand, AdmissionPeriodDecodeError> =>
  Schema.decodeUnknownEffect(AdmissionPeriodCommandSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => new AdmissionPeriodDecodeError({ message: String(cause) })));

export const executeAdmissionPeriodCommand = (
  input: unknown,
  context: AdmissionPeriodCommandContext,
): Effect.Effect<AdmissionPeriodTransactionResult, AdmissionPeriodFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* decodeAdmissionPeriodCommand(input);
    yield* checkActor(context.actor);
    yield* checkNow(context.now);
    const sql = yield* Database;
    const commandDigest = admissionPeriodCommandDigest(command);

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(periodPersistenceError("lock admission command receipt", cause)),
            ),
          );
          const stored = yield* findPeriodCommandReceipt(sql, command.commandId);
          if (stored !== undefined) {
            if (stored.command_sha256 !== commandDigest) {
              return yield* new DuplicateAdmissionPeriodCommandConflict({
                commandId: command.commandId,
              });
            }
            const original = yield* observationFromStored(stored.observation_json);
            if (!actorCanAccessDepartment(context.actor, original.period.departmentId)) {
              return yield* new AdmissionScopeDenied({
                personId: context.actor.personId,
                departmentId: original.period.departmentId,
                admissionPeriodId: original.period.id,
              });
            }
            return replayPeriodResult(command.commandId, original);
          }

          let previous: AdmissionPeriod | undefined;
          let semester: AdmissionSemesterValue | undefined;
          if (command._tag === "CreateAdmissionPeriod") {
            const departmentId = yield* effectiveCreateDepartment(command, context.actor);
            yield* sql`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${`${departmentId}:${command.semesterId}`}, 0)
            )
          `.pipe(
              Effect.asVoid,
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(periodPersistenceError("lock admission department semester", cause)),
              ),
            );
            if (!(yield* departmentExists(sql, departmentId))) {
              return yield* new DepartmentNotFound({ departmentId });
            }
            previous = yield* findPeriodByPairForUpdate(sql, departmentId, command.semesterId);
            semester = yield* findSemester(sql, command.semesterId);
            if (semester === undefined) {
              return yield* new SemesterNotFound({ semesterId: command.semesterId });
            }
          } else {
            previous = yield* findPeriodForUpdate(sql, command.admissionPeriodId);
            if (previous === undefined) {
              return yield* new AdmissionPeriodNotFound({
                admissionPeriodId: command.admissionPeriodId,
              });
            }
            if (!actorCanAccessDepartment(context.actor, previous.departmentId)) {
              return yield* new AdmissionScopeDenied({
                personId: context.actor.personId,
                departmentId: previous.departmentId,
                admissionPeriodId: previous.id,
              });
            }
            semester = yield* findSemester(sql, previous.semesterId);
            if (semester === undefined) {
              return yield* new SemesterNotFound({ semesterId: previous.semesterId });
            }
          }

          const decision = yield* decideAdmissionPeriod(
            previous,
            command,
            contextForActor(context, semester),
          );
          yield* writePeriod(sql, decision.period, previous);
          yield* writePeriodCommandReceipt(
            sql,
            command,
            commandDigest,
            decision.observation,
            decision.period,
            context.now,
          );
          yield* writeOutbox(sql, decision.outbox);
          yield* writeAudit(
            sql,
            command,
            decision.period,
            context.actor.personId,
            decision.auditAction,
            context.now,
          );
          return {
            period: decision.period,
            observation: decision.observation,
            replayed: false,
            outboxCount: decision.outbox.length,
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(periodPersistenceError("admission period transaction", cause)),
        ),
      );
  });

const projectionRows = (
  sql: DatabaseShape,
  now: string,
  departmentId?: string,
): Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodPersistenceError> => {
  const query =
    departmentId === undefined
      ? sql<typeof AdmissionPeriodProjectionSchema.Encoded>`
          SELECT p.admission_period_id AS id, p.department_id AS "departmentId",
            p.semester_id AS "semesterId",
            to_char(p.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
            to_char(p.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt",
            p.revision, p.last_command_id AS "lastCommandId",
            (
              s.start_at <= ${now}::timestamptz AND ${now}::timestamptz < s.end_at
              AND p.start_at <= ${now}::timestamptz AND ${now}::timestamptz < p.end_at
            ) AS eligible
          FROM admission_periods p
          INNER JOIN admission_period_semesters s ON s.semester_id = p.semester_id
          ORDER BY p.department_id, p.semester_id, p.admission_period_id
        `
      : sql<typeof AdmissionPeriodProjectionSchema.Encoded>`
          SELECT p.admission_period_id AS id, p.department_id AS "departmentId",
            p.semester_id AS "semesterId",
            to_char(p.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
            to_char(p.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt",
            p.revision, p.last_command_id AS "lastCommandId",
            (
              s.start_at <= ${now}::timestamptz AND ${now}::timestamptz < s.end_at
              AND p.start_at <= ${now}::timestamptz AND ${now}::timestamptz < p.end_at
            ) AS eligible
          FROM admission_periods p
          INNER JOIN admission_period_semesters s ON s.semester_id = p.semester_id
          WHERE p.department_id = ${departmentId}
          ORDER BY p.department_id, p.semester_id, p.admission_period_id
        `;
  return query.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, decodeProjectionRow)),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("read admission period projection", cause)),
    ),
  );
};

export const listAdmissionPeriodsForManagement = (
  context: AdmissionPeriodManagementContext,
): Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure, Database> =>
  Effect.gen(function* () {
    yield* checkActor(context.actor);
    yield* checkNow(context.now);
    const sql = yield* Database;
    return yield* projectionRows(
      sql,
      context.now,
      context.actor._tag === "DepartmentLeader" ? context.actor.departmentId : undefined,
    );
  });

export const listOpenAdmissionPeriods = (
  now: string,
): Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure, Database> =>
  Effect.gen(function* () {
    yield* checkNow(now);
    const sql = yield* Database;
    const rows = yield* projectionRows(sql, now);
    return rows.filter((row) => row.eligible);
  });

export const admissionPeriodProjectionFor = (
  period: AdmissionPeriod,
  semester: AdmissionSemesterValue,
  now: string,
): AdmissionPeriodProjection => ({
  ...period,
  eligible:
    compareRfc3339Instants(semester.startAt, now) <= 0 &&
    compareRfc3339Instants(now, semester.endAt) < 0 &&
    compareRfc3339Instants(period.startAt, now) <= 0 &&
    compareRfc3339Instants(now, period.endAt) < 0,
});
