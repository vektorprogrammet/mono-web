import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import {
  AdmissionApplicationAlreadyExists,
  AdmissionApplicationDecodeError,
  AdmissionApplicationPersistenceError,
  AdmissionPeriodDecodeError,
  AdmissionPeriodNotFound,
  AdmissionPeriodPersistenceError,
  AdmissionScopeDenied,
  AdmissionRoleDenied,
  DepartmentNotFound,
  DepartmentRequired,
  DuplicateAdmissionApplicationCommandConflict,
  DuplicateAdmissionPeriodCommandConflict,
  InactiveActor,
  NoOpenAdmissionPeriod,
  SemesterNotFound,
  StaleAdmissionPeriodRevision,
  type AdmissionApplicationFailure,
  type AdmissionPeriodFailure,
} from "./errors.js";
import { admissionPeriodCommandDigest, canonicalJson } from "./digest.js";
import type { AdmissionPeriodOutboxRequest } from "./effects.js";
import {
  AdmissionPeriodCommandSchema,
  AdmissionPeriodObservationSchema,
  AdmissionPeriodProjectionSchema,
  AdmissionPeriodSchema,
  AdmissionSemesterSchema,
  isRfc3339Instant,
  type AdmissionPeriod,
  type AdmissionPeriodActor,
  type AdmissionPeriodCommand,
  type AdmissionPeriodObservation,
  type AdmissionPeriodProjection,
  type AdmissionSemester,
} from "./schema.js";
import {
  AdmissionApplicationSchema,
  SubmitAdmissionApplicationCommandSchema,
  SubmitAdmissionApplicationInputSchema,
  type AdmissionApplication,
  type AdmissionApplicationSubmitContext,
  type AdmissionApplicationTransactionResult,
  type SubmitAdmissionApplicationCommand,
  type SubmitAdmissionApplicationInput,
} from "./application.js";
import type {
  AdmissionPeriodCommandContext,
  AdmissionPeriodManagementContext,
  AdmissionPeriodTransactionResult,
} from "./service.js";
import { contextForActor, decideAdmissionPeriod } from "./update.js";

interface AdmissionPeriodRow {
  readonly admission_period_id: string;
  readonly department_id: string;
  readonly semester_id: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly revision: number;
  readonly last_command_id: string;
}

interface AdmissionPeriodProjectionRow extends AdmissionPeriodRow {
  readonly eligible: boolean;
}

interface SemesterRow {
  readonly semester_id: string;
  readonly start_at: string;
  readonly end_at: string;
}

interface PeriodCommandReceiptRow {
  readonly command_sha256: string;
  readonly observation_json: unknown;
  readonly admission_period_id: string;
}

interface ApplicationCommandReceiptRow {
  readonly command_sha256: string;
  readonly application_json: unknown;
}

interface ApplicationRow {
  readonly application_id: string;
  readonly applicant_id: string;
  readonly admission_period_id: string;
}

const periodPersistenceError = (operation: string, cause: unknown) =>
  new AdmissionPeriodPersistenceError({ operation, message: String(cause) });

const applicationPersistenceError = (operation: string, cause: unknown) =>
  new AdmissionApplicationPersistenceError({ operation, message: String(cause) });

const decodePeriodRow = (
  row: AdmissionPeriodRow,
): Effect.Effect<AdmissionPeriod, AdmissionPeriodPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionPeriodSchema)({
    id: row.admission_period_id,
    departmentId: row.department_id,
    semesterId: row.semester_id,
    startAt: row.start_at,
    endAt: row.end_at,
    revision: row.revision,
    lastCommandId: row.last_command_id,
  }).pipe(Effect.mapError((cause) => periodPersistenceError("decode admission period row", cause)));

const decodeProjectionRow = (
  row: AdmissionPeriodProjectionRow,
): Effect.Effect<AdmissionPeriodProjection, AdmissionPeriodPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionPeriodProjectionSchema)({
    id: row.admission_period_id,
    departmentId: row.department_id,
    semesterId: row.semester_id,
    startAt: row.start_at,
    endAt: row.end_at,
    revision: row.revision,
    lastCommandId: row.last_command_id,
    eligible: row.eligible,
  }).pipe(
    Effect.mapError((cause) => periodPersistenceError("decode admission period projection", cause)),
  );

const decodeSemesterRow = (
  row: SemesterRow,
): Effect.Effect<AdmissionSemester, AdmissionPeriodPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionSemesterSchema)({
    semesterId: row.semester_id,
    startAt: row.start_at,
    endAt: row.end_at,
  }).pipe(Effect.mapError((cause) => periodPersistenceError("decode admission semester row", cause)));

const findPeriodForUpdate = (
  sql: PgClient.PgClient,
  admissionPeriodId: string,
): Effect.Effect<AdmissionPeriod | undefined, AdmissionPeriodPersistenceError> =>
  sql<AdmissionPeriodRow>`
    SELECT admission_period_id, department_id, semester_id,
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at,
      revision, last_command_id
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
  sql: PgClient.PgClient,
  departmentId: string,
  semesterId: string,
): Effect.Effect<AdmissionPeriod | undefined, AdmissionPeriodPersistenceError> =>
  sql<AdmissionPeriodRow>`
    SELECT admission_period_id, department_id, semester_id,
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at,
      revision, last_command_id
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
  sql: PgClient.PgClient,
  semesterId: string,
): Effect.Effect<AdmissionSemester | undefined, AdmissionPeriodPersistenceError> =>
  sql<SemesterRow>`
    SELECT semester_id,
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at
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
  sql: PgClient.PgClient,
  departmentId: string,
): Effect.Effect<boolean, AdmissionPeriodPersistenceError> =>
  sql<{ readonly department_id: string }>`
    SELECT department_id
    FROM admission_period_departments
    WHERE department_id = ${departmentId}
  `.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(periodPersistenceError("read admission department", cause)),
    ),
  );

const findPeriodCommandReceipt = (
  sql: PgClient.PgClient,
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
        : Effect.fail(periodPersistenceError("stored admission observation is not replayable", observation._tag)),
    ),
    Effect.mapError((cause) => periodPersistenceError("decode stored admission observation", cause)),
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
  sql: PgClient.PgClient,
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
  sql: PgClient.PgClient,
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
  sql: PgClient.PgClient,
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
  sql: PgClient.PgClient,
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
  commandId: string,
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
): Effect.Effect<string, AdmissionPeriodFailure> => {
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

export const migrateAdmissionPeriodPostgres = (
  migrationSql: string,
): Effect.Effect<void, AdmissionPeriodPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql.unsafe(migrationSql).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(periodPersistenceError("migrate admission period schema", cause)),
      ),
    );
  });

export const executeAdmissionPeriodCommand = (
  input: unknown,
  context: AdmissionPeriodCommandContext,
): Effect.Effect<AdmissionPeriodTransactionResult, AdmissionPeriodFailure, PgClient.PgClient> =>
  Effect.gen(function* () {
    const command = yield* decodeAdmissionPeriodCommand(input);
    yield* checkActor(context.actor);
    yield* checkNow(context.now);
    const sql = yield* PgClient.PgClient;
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
          let semester: AdmissionSemester | undefined;
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
  sql: PgClient.PgClient,
  now: string,
  departmentId?: string,
): Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodPersistenceError> => {
  const query =
    departmentId === undefined
      ? sql<AdmissionPeriodProjectionRow>`
          SELECT p.admission_period_id, p.department_id, p.semester_id,
            to_char(p.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
            to_char(p.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at,
            p.revision, p.last_command_id,
            (
              s.start_at <= ${now}::timestamptz AND ${now}::timestamptz < s.end_at
              AND p.start_at <= ${now}::timestamptz AND ${now}::timestamptz < p.end_at
            ) AS eligible
          FROM admission_periods p
          INNER JOIN admission_period_semesters s ON s.semester_id = p.semester_id
          ORDER BY p.department_id, p.semester_id, p.admission_period_id
        `
      : sql<AdmissionPeriodProjectionRow>`
          SELECT p.admission_period_id, p.department_id, p.semester_id,
            to_char(p.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
            to_char(p.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at,
            p.revision, p.last_command_id,
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
): Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure, PgClient.PgClient> =>
  Effect.gen(function* () {
    yield* checkActor(context.actor);
    yield* checkNow(context.now);
    const sql = yield* PgClient.PgClient;
    return yield* projectionRows(
      sql,
      context.now,
      context.actor._tag === "DepartmentLeader" ? context.actor.departmentId : undefined,
    );
  });

export const listOpenAdmissionPeriods = (
  now: string,
): Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure, PgClient.PgClient> =>
  Effect.gen(function* () {
    yield* checkNow(now);
    const sql = yield* PgClient.PgClient;
    const rows = yield* projectionRows(sql, now);
    return rows.filter((row) => row.eligible);
  });

export const admissionPeriodProjectionFor = (
  period: AdmissionPeriod,
  semester: AdmissionSemester,
  now: string,
): AdmissionPeriodProjection => ({
  ...period,
  eligible:
    Date.parse(semester.startAt) <= Date.parse(now) &&
    Date.parse(now) < Date.parse(semester.endAt) &&
    Date.parse(period.startAt) <= Date.parse(now) &&
    Date.parse(now) < Date.parse(period.endAt),
});

const decodeApplicationRow = (
  row: ApplicationRow,
): Effect.Effect<AdmissionApplication, AdmissionApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionApplicationSchema)({
    id: row.application_id,
    applicantId: row.applicant_id,
    admissionPeriodId: row.admission_period_id,
  }).pipe(
    Effect.mapError((cause) => applicationPersistenceError("decode admission application row", cause)),
  );

const decodeStoredApplication = (
  json: unknown,
): Effect.Effect<AdmissionApplication, AdmissionApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionApplicationSchema)(json, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) =>
      applicationPersistenceError("decode stored admission application", cause),
    ),
  );

const findApplication = (
  sql: PgClient.PgClient,
  applicationId: string,
): Effect.Effect<AdmissionApplication | undefined, AdmissionApplicationPersistenceError> =>
  sql<ApplicationRow>`
    SELECT application_id, applicant_id, admission_period_id
    FROM admission_applications
    WHERE application_id = ${applicationId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeApplicationRow(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(applicationPersistenceError("read admission application", cause)),
    ),
  );

const findApplicationCommandReceipt = (
  sql: PgClient.PgClient,
  commandId: string,
): Effect.Effect<ApplicationCommandReceiptRow | undefined, AdmissionApplicationPersistenceError> =>
  sql<ApplicationCommandReceiptRow>`
    SELECT command_sha256, application_json
    FROM admission_application_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(applicationPersistenceError("read admission application command receipt", cause)),
    ),
  );

const findOpenPeriodForDepartment = (
  sql: PgClient.PgClient,
  departmentId: string,
  now: string,
): Effect.Effect<AdmissionPeriod | undefined, AdmissionApplicationPersistenceError> =>
  sql<AdmissionPeriodRow>`
    SELECT p.admission_period_id, p.department_id, p.semester_id,
      to_char(p.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
      to_char(p.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at,
      p.revision, p.last_command_id
    FROM admission_periods p
    INNER JOIN admission_period_semesters s ON s.semester_id = p.semester_id
    WHERE p.department_id = ${departmentId}
      AND s.start_at <= ${now}::timestamptz AND ${now}::timestamptz < s.end_at
      AND p.start_at <= ${now}::timestamptz AND ${now}::timestamptz < p.end_at
    ORDER BY p.start_at DESC, p.admission_period_id ASC
    LIMIT 1
    FOR UPDATE OF p
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decodePeriodRow(rows[0]).pipe(
            Effect.mapError((cause) =>
              applicationPersistenceError("decode open admission period", cause),
            ),
          ),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(applicationPersistenceError("find open admission period", cause)),
    ),
  );

const writeApplication = (
  sql: PgClient.PgClient,
  application: AdmissionApplication,
  now: string,
): Effect.Effect<void, AdmissionApplicationPersistenceError> =>
  sql`
    INSERT INTO admission_applications (
      application_id, applicant_id, admission_period_id, created_at
    ) VALUES (
      ${application.id}, ${application.applicantId}, ${application.admissionPeriodId}, ${now}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(applicationPersistenceError("insert admission application", cause)),
    ),
  );

const writeApplicationCommandReceipt = (
  sql: PgClient.PgClient,
  command: SubmitAdmissionApplicationCommand,
  commandDigest: string,
  application: AdmissionApplication,
  now: string,
): Effect.Effect<void, AdmissionApplicationPersistenceError> =>
  sql`
    INSERT INTO admission_application_command_receipts (
      command_id, command_sha256, command_json, application_json, committed_at
    ) VALUES (
      ${command.commandId}, ${commandDigest},
      ${sql.json(JSON.parse(canonicalJson(command)))}, ${sql.json(application)}, ${now}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(applicationPersistenceError("insert admission application command receipt", cause)),
    ),
  );

export const decodeSubmitAdmissionApplicationCommand = (
  input: unknown,
): Effect.Effect<SubmitAdmissionApplicationCommand, AdmissionApplicationDecodeError> =>
  Schema.decodeUnknownEffect(SubmitAdmissionApplicationCommandSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => new AdmissionApplicationDecodeError({ message: String(cause) })),
  );

export const decodeSubmitAdmissionApplicationInput = (
  input: unknown,
): Effect.Effect<SubmitAdmissionApplicationInput, AdmissionApplicationDecodeError> =>
  Schema.decodeUnknownEffect(SubmitAdmissionApplicationInputSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => new AdmissionApplicationDecodeError({ message: String(cause) })),
  );

export const migrateAdmissionApplicationPostgres = (
  migrationSql: string,
): Effect.Effect<void, AdmissionApplicationPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql.unsafe(migrationSql).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(applicationPersistenceError("migrate admission application schema", cause)),
      ),
    );
  });

const executeApplicationCommand = (
  command: SubmitAdmissionApplicationCommand,
  context: AdmissionApplicationSubmitContext,
  sql: PgClient.PgClient,
): Effect.Effect<AdmissionApplicationTransactionResult, AdmissionApplicationFailure> =>
  Effect.gen(function* () {
    if (!isRfc3339Instant(context.now)) {
      return yield* new AdmissionApplicationDecodeError({
        message: "now must be an RFC 3339 instant",
      });
    }
    const commandDigest = admissionPeriodCommandDigest(command);
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(applicationPersistenceError("lock admission application command", cause)),
      ),
    );
    const stored = yield* findApplicationCommandReceipt(sql, command.commandId);
    if (stored !== undefined) {
      if (stored.command_sha256 !== commandDigest) {
        return yield* new DuplicateAdmissionApplicationCommandConflict({
          commandId: command.commandId,
        });
      }
      const application = yield* decodeStoredApplication(stored.application_json);
      return { application, replayed: true };
    }

    const applicationId =
      context.applicationId ?? `admission-application-${commandDigest.slice(0, 32)}`;
    const existing = yield* findApplication(sql, applicationId);
    if (existing !== undefined) {
      return yield* new AdmissionApplicationAlreadyExists({ applicationId });
    }
    const period = yield* findOpenPeriodForDepartment(sql, command.departmentId, context.now);
    if (period === undefined) {
      return yield* new NoOpenAdmissionPeriod({ departmentId: command.departmentId });
    }
    const application: AdmissionApplication = {
      id: applicationId,
      applicantId: command.applicantId,
      admissionPeriodId: period.id,
    };
    yield* writeApplication(sql, application, context.now);
    yield* writeApplicationCommandReceipt(sql, command, commandDigest, application, context.now);
    return { application, replayed: false };
  });

export const executeAdmissionApplicationCommand = (
  input: unknown,
  context: AdmissionApplicationSubmitContext,
): Effect.Effect<AdmissionApplicationTransactionResult, AdmissionApplicationFailure, PgClient.PgClient> =>
  Effect.gen(function* () {
    const command = yield* decodeSubmitAdmissionApplicationCommand(input);
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(executeApplicationCommand(command, context, sql)).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(applicationPersistenceError("admission application transaction", cause)),
      ),
    );
  });

export const submitAdmissionApplication = (
  input: unknown,
  context: AdmissionApplicationSubmitContext,
): Effect.Effect<AdmissionApplicationTransactionResult, AdmissionApplicationFailure, PgClient.PgClient> =>
  Effect.gen(function* () {
    const inputValue = yield* decodeSubmitAdmissionApplicationInput(input);
    return yield* executeAdmissionApplicationCommand(
      { _tag: "SubmitAdmissionApplication", ...inputValue },
      context,
    );
  });

export const findAdmissionApplication = (
  applicationId: string,
): Effect.Effect<AdmissionApplication | undefined, AdmissionApplicationPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* findApplication(sql, applicationId);
  });
