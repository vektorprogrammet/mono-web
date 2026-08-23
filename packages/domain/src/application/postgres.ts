import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import {
  DuplicatePublicApplication,
  DuplicatePublicApplicationCommandConflict,
  FieldOfStudyDepartmentMismatch,
  FieldOfStudyInactive,
  FieldOfStudyNotFound,
  NoEligibleAdmissionPeriod,
  PublicApplicationDecodeError,
  PublicApplicationDepartmentNotFound,
  PublicApplicationNotFound,
  PublicApplicationPersistenceError,
  type PublicApplicationError,
} from "./errors.js";
import {
  makePublicApplicationOutboxRequests,
  type PublicApplicationOutboxRequest,
} from "./effects.js";
import {
  publicApplicantIdForCommand,
  publicApplicationCommandDigest,
  publicApplicationIdForCommand,
  canonicalJson,
} from "./digest.js";
import {
  decodePublicApplicationNow,
  decodePublicApplicationSubmitInput,
  decodeSubmitPublicApplicationCommand,
} from "./validation.js";
import {
  ApplicantRecordSchema,
  PublicApplicationCatalogSchema,
  PublicApplicationConfirmationSchema,
  PublicApplicationSchema,
  PublicApplicationSubmitObservationSchema,
  type ApplicantRecord,
  type PublicApplication,
  type PublicApplicationCatalog,
  type PublicApplicationCatalogContext,
  type PublicApplicationConfirmation,
  type PublicApplicationSubmitContext,
  type PublicApplicationSubmitInput,
  type PublicApplicationSubmitObservation,
  type PublicApplicationSubmitResult,
  type SubmitPublicApplicationCommand,
} from "./schema.js";

interface DepartmentRow {
  readonly department_id: string;
  readonly name: string;
}

interface PeriodRow {
  readonly admission_period_id: string;
  readonly department_id: string;
  readonly start_at: string;
  readonly end_at: string;
}

interface FieldOfStudyRow {
  readonly field_of_study_id: string;
  readonly department_id: string;
  readonly name: string;
  readonly active: boolean;
}

interface ApplicantRow {
  readonly applicant_id: string;
  readonly normalized_email: string;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly phone: string;
  readonly gender: number;
  readonly field_of_study_id: string;
  readonly year_of_study: number;
  readonly activation_digest: string | null;
}

interface ApplicationRow {
  readonly application_id: string;
  readonly applicant_id: string;
  readonly admission_period_id: string;
  readonly department_id: string;
  readonly field_of_study_id: string;
  readonly year_of_study: number;
  readonly submitted_at: string;
  readonly revision: number;
}

interface CommandReceiptRow {
  readonly command_sha256: string;
  readonly observation_json: unknown;
}

interface CatalogRow {
  readonly department_id: string;
  readonly department_name: string;
  readonly closes_at: string;
  readonly field_of_study_id: string | null;
  readonly field_of_study_name: string | null;
}

const persistenceError = (operation: string): PublicApplicationPersistenceError =>
  new PublicApplicationPersistenceError({
    operation,
    message: "public application persistence failed",
  });

const decodeApplicantRow = (
  row: ApplicantRow,
): Effect.Effect<ApplicantRecord, PublicApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(ApplicantRecordSchema)({
    id: row.applicant_id,
    normalizedEmail: row.normalized_email,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    gender: row.gender,
    fieldOfStudyId: row.field_of_study_id,
    yearOfStudy: row.year_of_study,
    ...(row.activation_digest === null ? {} : { activationDigest: row.activation_digest }),
  }).pipe(Effect.mapError(() => persistenceError("decode applicant row")));

const decodeApplicationRow = (
  row: ApplicationRow,
): Effect.Effect<PublicApplication, PublicApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(PublicApplicationSchema)({
    id: row.application_id,
    applicantId: row.applicant_id,
    admissionPeriodId: row.admission_period_id,
    departmentId: row.department_id,
    fieldOfStudyId: row.field_of_study_id,
    yearOfStudy: row.year_of_study,
    submittedAt: row.submitted_at,
    revision: row.revision,
  }).pipe(Effect.mapError(() => persistenceError("decode application row")));

const decodeStoredObservation = (
  value: unknown,
): Effect.Effect<PublicApplicationSubmitObservation, PublicApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(PublicApplicationSubmitObservationSchema)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => persistenceError("decode stored application observation")));

const decodeCatalog = (
  value: unknown,
): Effect.Effect<PublicApplicationCatalog, PublicApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(PublicApplicationCatalogSchema)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => persistenceError("decode application catalog")));

const departmentExists = (
  sql: PgClient.PgClient,
  departmentId: string,
): Effect.Effect<boolean, PublicApplicationPersistenceError> =>
  sql<DepartmentRow>`
    SELECT department_id, COALESCE(NULLIF(name, ''), department_id) AS name
    FROM admission_period_departments
    WHERE department_id = ${departmentId}
  `.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read application department"))),
  );

const findEligiblePeriod = (
  sql: PgClient.PgClient,
  departmentId: string,
  now: string,
): Effect.Effect<PeriodRow | undefined, PublicApplicationPersistenceError> =>
  sql<PeriodRow>`
    SELECT p.admission_period_id, p.department_id,
      to_char(p.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
      to_char(p.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at
    FROM admission_periods p
    INNER JOIN admission_period_semesters s ON s.semester_id = p.semester_id
    WHERE p.department_id = ${departmentId}
      AND s.start_at <= ${now}::timestamptz AND ${now}::timestamptz < s.end_at
      AND p.start_at <= ${now}::timestamptz AND ${now}::timestamptz < p.end_at
    ORDER BY p.start_at DESC, p.admission_period_id ASC
    LIMIT 1
    FOR UPDATE OF p
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("find eligible admission period"))),
  );

const findFieldOfStudy = (
  sql: PgClient.PgClient,
  fieldOfStudyId: string,
): Effect.Effect<FieldOfStudyRow | undefined, PublicApplicationPersistenceError> =>
  sql<FieldOfStudyRow>`
    SELECT field_of_study_id, department_id, name, active
    FROM admission_period_fields_of_study
    WHERE field_of_study_id = ${fieldOfStudyId}
    FOR SHARE
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read field of study"))),
  );

const findApplicantForUpdate = (
  sql: PgClient.PgClient,
  normalizedEmail: string,
): Effect.Effect<ApplicantRecord | undefined, PublicApplicationPersistenceError> =>
  sql<ApplicantRow>`
    SELECT applicant_id, normalized_email, email, first_name, last_name, phone,
      gender, field_of_study_id, year_of_study, activation_digest
    FROM admission_applicants
    WHERE normalized_email = ${normalizedEmail}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeApplicantRow(rows[0]),
    ),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("lock applicant identity"))),
  );

const findApplicationForApplicantPeriod = (
  sql: PgClient.PgClient,
  applicantId: string,
  admissionPeriodId: string,
): Effect.Effect<PublicApplication | undefined, PublicApplicationPersistenceError> =>
  sql<ApplicationRow>`
    SELECT application_id, applicant_id, admission_period_id,
      department_id, field_of_study_id, year_of_study,
      to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
      revision
    FROM admission_applications
    WHERE applicant_id = ${applicantId} AND admission_period_id = ${admissionPeriodId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeApplicationRow(rows[0]),
    ),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read duplicate application"))),
  );

const findApplicationById = (
  sql: PgClient.PgClient,
  applicationId: string,
): Effect.Effect<PublicApplication | undefined, PublicApplicationPersistenceError> =>
  sql<ApplicationRow>`
    SELECT application_id, applicant_id, admission_period_id,
      department_id, field_of_study_id, year_of_study,
      to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
      revision
    FROM admission_applications
    WHERE application_id = ${applicationId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeApplicationRow(rows[0]),
    ),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read application identity"))),
  );

const findCommandReceipt = (
  sql: PgClient.PgClient,
  commandId: string,
): Effect.Effect<CommandReceiptRow | undefined, PublicApplicationPersistenceError> =>
  sql<CommandReceiptRow>`
    SELECT command_sha256, observation_json
    FROM admission_application_command_receipts
    WHERE command_id = ${commandId}
    FOR UPDATE
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read application command receipt"))),
  );

const writeApplicant = (
  sql: PgClient.PgClient,
  applicant: ApplicantRecord,
): Effect.Effect<void, PublicApplicationPersistenceError> =>
  sql`
    INSERT INTO admission_applicants (
      applicant_id, normalized_email, email, first_name, last_name, phone,
      gender, field_of_study_id, year_of_study, activation_digest
    ) VALUES (
      ${applicant.id}, ${applicant.normalizedEmail}, ${applicant.email},
      ${applicant.firstName}, ${applicant.lastName}, ${applicant.phone},
      ${applicant.gender}, ${applicant.fieldOfStudyId}, ${applicant.yearOfStudy},
      ${applicant.activationDigest ?? null}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("insert applicant"))),
  );

const updateApplicant = (
  sql: PgClient.PgClient,
  applicant: ApplicantRecord,
): Effect.Effect<void, PublicApplicationPersistenceError> =>
  sql`
    UPDATE admission_applicants
    SET email = ${applicant.email},
      first_name = ${applicant.firstName},
      last_name = ${applicant.lastName},
      phone = ${applicant.phone},
      gender = ${applicant.gender},
      field_of_study_id = ${applicant.fieldOfStudyId},
      year_of_study = ${applicant.yearOfStudy},
      activation_digest = COALESCE(${applicant.activationDigest ?? null}, activation_digest)
    WHERE applicant_id = ${applicant.id}
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("update applicant profile"))),
  );

const writeApplication = (
  sql: PgClient.PgClient,
  application: PublicApplication,
): Effect.Effect<void, PublicApplicationPersistenceError> =>
  sql`
    INSERT INTO admission_applications (
      application_id, applicant_id, admission_period_id, department_id,
      field_of_study_id, year_of_study, submitted_at, revision
    ) VALUES (
      ${application.id}, ${application.applicantId}, ${application.admissionPeriodId},
      ${application.departmentId}, ${application.fieldOfStudyId},
      ${application.yearOfStudy}, ${application.submittedAt}, ${application.revision}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("insert application"))),
  );

const writeCommandReceipt = (
  sql: PgClient.PgClient,
  command: PublicApplicationSubmitInput,
  commandDigest: string,
  observation: PublicApplicationSubmitObservation,
  application: PublicApplication,
  now: string,
): Effect.Effect<void, PublicApplicationPersistenceError> =>
  sql`
    INSERT INTO admission_application_command_receipts (
      command_id, command_sha256, command_json, observation_json,
      application_id, committed_at
    ) VALUES (
      ${command.commandId}, ${commandDigest}, ${sql.json(JSON.parse(canonicalJson(command)))},
      ${sql.json(observation)}, ${application.id}, ${now}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("insert application command receipt"))),
  );

const writeAudit = (
  sql: PgClient.PgClient,
  commandId: string,
  application: PublicApplication,
  now: string,
): Effect.Effect<void, PublicApplicationPersistenceError> =>
  sql`
    INSERT INTO admission_application_audit (
      command_id, application_id, applicant_id, action, application_revision, occurred_at
    ) VALUES (
      ${commandId}, ${application.id}, ${application.applicantId},
      'PublicApplicationSubmitted', ${application.revision}, ${now}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("insert application audit"))),
  );

const writeOutbox = (
  sql: PgClient.PgClient,
  requests: ReadonlyArray<PublicApplicationOutboxRequest>,
): Effect.Effect<void, PublicApplicationPersistenceError> =>
  Effect.forEach(
    requests,
    (request, ordinal) =>
      sql`
        INSERT INTO admission_application_outbox (
          effect_id, effect_type, application_id, applicant_id, command_id,
          ordinal, payload_json
        ) VALUES (
          ${request.effectId}, ${request._tag}, ${request.applicationId},
          ${request.applicantId}, ${request.commandId}, ${ordinal}, ${sql.json(request)}
        )
      `.pipe(Effect.asVoid),
    { discard: true },
  ).pipe(
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("insert application outbox"))),
  );

export const migratePublicApplicationPostgres = (
  migrationSql: string,
): Effect.Effect<void, PublicApplicationPersistenceError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql.unsafe(migrationSql).pipe(
      Effect.catchTag("SqlError", () => Effect.fail(persistenceError("migrate public application schema"))),
    );
  });

const executeCommandInTransaction = (
  command: SubmitPublicApplicationCommand,
  context: PublicApplicationSubmitContext,
  sql: PgClient.PgClient,
  now: string,
): Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError> =>
  Effect.gen(function* () {
    const commandDigest = publicApplicationCommandDigest(command);
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", () => Effect.fail(persistenceError("lock application command"))),
    );
    const stored = yield* findCommandReceipt(sql, command.commandId);
    if (stored !== undefined) {
      if (stored.command_sha256 !== commandDigest) {
        return yield* new DuplicatePublicApplicationCommandConflict({ commandId: command.commandId });
      }
      const observation = yield* decodeStoredObservation(stored.observation_json);
      return { observation, replayed: true, outboxCount: 0 };
    }

    const normalizedEmail = command.email;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${"applicant:" + normalizedEmail}, 0))`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", () => Effect.fail(persistenceError("lock applicant identity"))),
    );
    if (!(yield* departmentExists(sql, command.departmentId))) {
      return yield* new PublicApplicationDepartmentNotFound({ departmentId: command.departmentId });
    }
    const period = yield* findEligiblePeriod(sql, command.departmentId, now);
    if (period === undefined) {
      return yield* new NoEligibleAdmissionPeriod({ departmentId: command.departmentId });
    }
    const field = yield* findFieldOfStudy(sql, command.fieldOfStudyId);
    if (field === undefined) {
      return yield* new FieldOfStudyNotFound({ fieldOfStudyId: command.fieldOfStudyId });
    }
    if (field.department_id !== command.departmentId) {
      return yield*
        new FieldOfStudyDepartmentMismatch({
          fieldOfStudyId: command.fieldOfStudyId,
          departmentId: command.departmentId,
        });
    }
    if (!field.active) {
      return yield* new FieldOfStudyInactive({ fieldOfStudyId: command.fieldOfStudyId });
    }

    const existingApplicant = yield* findApplicantForUpdate(sql, normalizedEmail);
    const applicantId =
      existingApplicant?.id ?? (context.applicantId?.trim() || publicApplicantIdForCommand(command));
    const activationDigest =
      existingApplicant === undefined ? publicApplicationCommandDigest(command) : existingApplicant.activationDigest;
    const applicant: ApplicantRecord = {
      id: applicantId,
      normalizedEmail,
      email: command.email,
      firstName: command.firstName,
      lastName: command.lastName,
      phone: command.phone,
      gender: command.gender,
      fieldOfStudyId: command.fieldOfStudyId,
      yearOfStudy: command.yearOfStudy,
      ...(activationDigest === undefined ? {} : { activationDigest }),
    };
    const duplicate = yield* findApplicationForApplicantPeriod(sql, applicant.id, period.admission_period_id);
    if (duplicate !== undefined) return yield* new DuplicatePublicApplication();

    const applicationId = context.applicationId?.trim() || publicApplicationIdForCommand(command);
    const collidingApplication = yield* findApplicationById(sql, applicationId);
    if (collidingApplication !== undefined) return yield* new DuplicatePublicApplication();

    if (existingApplicant === undefined) yield* writeApplicant(sql, applicant);
    else yield* updateApplicant(sql, applicant);

    const application: PublicApplication = {
      id: applicationId,
      applicantId: applicant.id,
      admissionPeriodId: period.admission_period_id,
      departmentId: period.department_id,
      fieldOfStudyId: command.fieldOfStudyId,
      yearOfStudy: command.yearOfStudy,
      submittedAt: now,
      revision: 0,
    };
    yield* writeApplication(sql, application);
    const observation: PublicApplicationSubmitObservation = {
      _tag: "Submitted",
      commandId: command.commandId,
      applicationId,
    };
    yield* writeCommandReceipt(sql, command, commandDigest, observation, application, now);
    yield* writeAudit(sql, command.commandId, application, now);
    const requests = makePublicApplicationOutboxRequests(command, application, applicant, command.email);
    yield* writeOutbox(sql, requests);
    return { observation, replayed: false, outboxCount: requests.length };
  });

export const executePublicApplicationCommand = (
  input: unknown,
  context: PublicApplicationSubmitContext,
): Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const command = yield* decodeSubmitPublicApplicationCommand(input);
    const now = yield* decodePublicApplicationNow(context.now);
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(executeCommandInTransaction(command, context, sql, now)).pipe(
      Effect.catchTag("SqlError", () => Effect.fail(persistenceError("public application transaction"))),
    );
  });

export const submitPublicApplication = (
  input: unknown,
  context: PublicApplicationSubmitContext,
): Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError, PgClient.PgClient> =>
  executePublicApplicationCommand(input, context);

export const listPublicApplicationCatalog = (
  context: PublicApplicationCatalogContext,
): Effect.Effect<PublicApplicationCatalog, PublicApplicationError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const now = yield* decodePublicApplicationNow(context.now);
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<CatalogRow>`
      WITH eligible AS (
        SELECT p.department_id, p.end_at,
          ROW_NUMBER() OVER (
            PARTITION BY p.department_id
            ORDER BY p.start_at DESC, p.admission_period_id ASC
          ) AS period_rank
        FROM admission_periods p
        INNER JOIN admission_period_semesters s ON s.semester_id = p.semester_id
        WHERE s.start_at <= ${now}::timestamptz AND ${now}::timestamptz < s.end_at
          AND p.start_at <= ${now}::timestamptz AND ${now}::timestamptz < p.end_at
      )
      SELECT d.department_id,
        COALESCE(NULLIF(d.name, ''), d.department_id) AS department_name,
        to_char(e.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS closes_at,
        f.field_of_study_id,
        f.name AS field_of_study_name
      FROM eligible e
      INNER JOIN admission_period_departments d ON d.department_id = e.department_id
      LEFT JOIN admission_period_fields_of_study f
        ON f.department_id = e.department_id AND f.active = TRUE
      WHERE e.period_rank = 1
      ORDER BY d.department_id, f.field_of_study_id
    `.pipe(
      Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read public application catalog"))),
    );
    const departments = new Map<
      string,
      { departmentId: string; name: string; closesAt: string; fieldsOfStudy: Array<{ fieldOfStudyId: string; name: string }> }
    >();
    for (const row of rows) {
      const existing = departments.get(row.department_id);
      const department =
        existing ?? {
          departmentId: row.department_id,
          name: row.department_name,
          closesAt: row.closes_at,
          fieldsOfStudy: [],
        };
      if (row.field_of_study_id !== null && row.field_of_study_name !== null) {
        department.fieldsOfStudy.push({
          fieldOfStudyId: row.field_of_study_id,
          name: row.field_of_study_name,
        });
      }
      departments.set(row.department_id, department);
    }
    return yield* decodeCatalog({ departments: [...departments.values()] });
  });
export const findPublicApplicationConfirmation = (
  applicationId: string,
): Effect.Effect<PublicApplicationConfirmation, PublicApplicationError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const normalizedId = applicationId.trim();
    if (normalizedId.length === 0) {
      return yield* new PublicApplicationDecodeError({ message: "invalid application identifier" });
    }
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly application_id: string }>`
      SELECT application_id
      FROM admission_applications
      WHERE application_id = ${normalizedId}
    `.pipe(
      Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read application confirmation"))),
    );
    if (rows[0] === undefined) {
      return yield* new PublicApplicationNotFound({ applicationId: normalizedId });
    }
    return yield* Schema.decodeUnknownEffect(PublicApplicationConfirmationSchema)({
      _tag: "ApplicationConfirmed",
      applicationId: rows[0].application_id,
    }).pipe(Effect.mapError(() => persistenceError("decode application confirmation")));
  });

export const decodePublicApplicationCommand = decodeSubmitPublicApplicationCommand;
export const decodePublicApplicationSubmit = decodePublicApplicationSubmitInput;
