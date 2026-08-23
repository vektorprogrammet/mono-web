import { Database, type DatabaseShape } from "../database/service.js";
import { Effect, Schema } from "effect";
import {
  AdmissionDepartment,
  AdmissionFieldOfStudy,
  AdmissionPeriod,
} from "../admission-period/schema.js";
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
  publicApplicationActivationDigest,
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
  ApplicantRecord,
  PublicApplicationCatalogSchema,
  PublicApplicationConfirmationSchema,
  PublicApplicationActivationTokenSchema,
  PublicApplication,
  PublicApplicationSubmitObservationSchema,
  type PublicApplicationCatalog,
  type PublicApplicationCatalogContext,
  type PublicApplicationConfirmation,
  type PublicApplicationSubmitContext,
  type PublicApplicationSubmitInput,
  type PublicApplicationSubmitObservation,
  type PublicApplicationSubmitResult,
  type SubmitPublicApplicationCommand,
} from "./schema.js";

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
  row: typeof ApplicantRecord.Encoded,
): Effect.Effect<ApplicantRecord, PublicApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(ApplicantRecord)(row, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => persistenceError("decode applicant row")));

const decodeApplicationRow = (
  row: typeof PublicApplication.Encoded,
): Effect.Effect<PublicApplication, PublicApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(PublicApplication)(row, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => persistenceError("decode application row")));

const decodeAdmissionPeriodRow = (
  row: typeof AdmissionPeriod.Encoded,
): Effect.Effect<AdmissionPeriod, PublicApplicationPersistenceError> =>
  Schema.decodeUnknownEffect(AdmissionPeriod)(row, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => persistenceError("decode admission period row")));

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
  sql: DatabaseShape,
  departmentId: string,
): Effect.Effect<boolean, PublicApplicationPersistenceError> =>
  sql<typeof AdmissionDepartment.Encoded>`
    SELECT department_id AS "departmentId",
      COALESCE(NULLIF(name, ''), department_id) AS name
    FROM admission_period_departments
    WHERE department_id = ${departmentId}
  `.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read application department"))),
  );

const findEligiblePeriod = (
  sql: DatabaseShape,
  departmentId: string,
  now: string,
): Effect.Effect<AdmissionPeriod | undefined, PublicApplicationPersistenceError> =>
  sql<typeof AdmissionPeriod.Encoded>`
    SELECT p.admission_period_id AS id,
      p.department_id AS "departmentId",
      p.semester_id AS "semesterId",
      to_char(p.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(p.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt",
      p.revision,
      p.last_command_id AS "lastCommandId"
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
      rows[0] === undefined ? Effect.succeed(undefined) : decodeAdmissionPeriodRow(rows[0]),
    ),
    Effect.catchTag("SqlError", () =>
      Effect.fail(persistenceError("find eligible admission period")),
    ),
  );

const findFieldOfStudy = (
  sql: DatabaseShape,
  fieldOfStudyId: string,
): Effect.Effect<AdmissionFieldOfStudy | undefined, PublicApplicationPersistenceError> =>
  sql<typeof AdmissionFieldOfStudy.Encoded>`
    SELECT field_of_study_id AS "fieldOfStudyId", department_id AS "departmentId", name, active
    FROM admission_period_fields_of_study
    WHERE field_of_study_id = ${fieldOfStudyId}
    FOR SHARE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(AdmissionFieldOfStudy)(rows[0], {
            onExcessProperty: "error",
          }).pipe(Effect.mapError(() => persistenceError("decode field of study row"))),
    ),
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("read field of study"))),
  );

const findApplicantForUpdate = (
  sql: DatabaseShape,
  normalizedEmail: string,
): Effect.Effect<ApplicantRecord | undefined, PublicApplicationPersistenceError> =>
  sql<typeof ApplicantRecord.Encoded>`
    SELECT applicant_id AS id,
      normalized_email AS "normalizedEmail",
      email,
      first_name AS "firstName",
      last_name AS "lastName",
      phone,
      gender,
      field_of_study_id AS "fieldOfStudyId",
      year_of_study AS "yearOfStudy",
      activation_digest AS "activationDigest"
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
  sql: DatabaseShape,
  applicantId: string,
  admissionPeriodId: string,
): Effect.Effect<PublicApplication | undefined, PublicApplicationPersistenceError> =>
  sql<typeof PublicApplication.Encoded>`
    SELECT application_id AS id,
      applicant_id AS "applicantId",
      admission_period_id AS "admissionPeriodId",
      department_id AS "departmentId",
      field_of_study_id AS "fieldOfStudyId",
      year_of_study AS "yearOfStudy",
      to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "submittedAt",
      revision,
      activation_digest AS "activationDigest"
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
  sql: DatabaseShape,
  applicationId: string,
): Effect.Effect<PublicApplication | undefined, PublicApplicationPersistenceError> =>
  sql<typeof PublicApplication.Encoded>`
    SELECT application_id AS id,
      applicant_id AS "applicantId",
      admission_period_id AS "admissionPeriodId",
      department_id AS "departmentId",
      field_of_study_id AS "fieldOfStudyId",
      year_of_study AS "yearOfStudy",
      to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "submittedAt",
      revision,
      activation_digest AS "activationDigest"
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
  sql: DatabaseShape,
  commandId: string,
): Effect.Effect<CommandReceiptRow | undefined, PublicApplicationPersistenceError> =>
  sql<CommandReceiptRow>`
    SELECT command_sha256, observation_json
    FROM admission_application_command_receipts
    WHERE command_id = ${commandId}
    FOR UPDATE
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", () =>
      Effect.fail(persistenceError("read application command receipt")),
    ),
  );

const writeApplicant = (
  sql: DatabaseShape,
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
    ${applicant.activationDigest}
  )
`.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("insert applicant"))),
  );

const updateApplicant = (
  sql: DatabaseShape,
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
    activation_digest = COALESCE(${applicant.activationDigest}, activation_digest)
  WHERE applicant_id = ${applicant.id}
`.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("update applicant profile"))),
  );

const writeApplication = (
  sql: DatabaseShape,
  application: PublicApplication,
): Effect.Effect<void, PublicApplicationPersistenceError> =>
  sql`
  INSERT INTO admission_applications (
    application_id, applicant_id, admission_period_id, department_id,
    field_of_study_id, year_of_study, submitted_at, revision, activation_digest
  ) VALUES (
    ${application.id}, ${application.applicantId}, ${application.admissionPeriodId},
    ${application.departmentId}, ${application.fieldOfStudyId},
    ${application.yearOfStudy}, ${application.submittedAt}, ${application.revision},
    ${application.activationDigest}
  )
`.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("insert application"))),
  );

const writeCommandReceipt = (
  sql: DatabaseShape,
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
    Effect.catchTag("SqlError", () =>
      Effect.fail(persistenceError("insert application command receipt")),
    ),
  );

const writeAudit = (
  sql: DatabaseShape,
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
  sql: DatabaseShape,
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

const executeCommandInTransaction = (
  command: SubmitPublicApplicationCommand,
  context: PublicApplicationSubmitContext,
  sql: DatabaseShape,
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
        return yield* new DuplicatePublicApplicationCommandConflict({
          commandId: command.commandId,
        });
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
    if (field.departmentId !== command.departmentId) {
      return yield* new FieldOfStudyDepartmentMismatch({
        fieldOfStudyId: command.fieldOfStudyId,
        departmentId: command.departmentId,
      });
    }
    if (!field.active) {
      return yield* new FieldOfStudyInactive({ fieldOfStudyId: command.fieldOfStudyId });
    }

    const existingApplicant = yield* findApplicantForUpdate(sql, normalizedEmail);
    const applicantId =
      existingApplicant?.id ??
      (context.applicantId?.trim() || publicApplicantIdForCommand(command));
    const requiresActivation =
      existingApplicant === undefined || existingApplicant.activationDigest !== null;
    const activationToken = requiresActivation
      ? yield* Schema.decodeUnknownEffect(PublicApplicationActivationTokenSchema)(
          context.activationToken,
        ).pipe(
          Effect.mapError(
            () => new PublicApplicationDecodeError({ message: "invalid activation token" }),
          ),
        )
      : undefined;
    const activationDigest =
      activationToken === undefined ? null : publicApplicationActivationDigest(activationToken);
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
      activationDigest,
    };
    const duplicate = yield* findApplicationForApplicantPeriod(sql, applicant.id, period.id);
    if (duplicate !== undefined) return yield* new DuplicatePublicApplication();

    const applicationId = context.applicationId?.trim() || publicApplicationIdForCommand(command);
    const collidingApplication = yield* findApplicationById(sql, applicationId);
    if (collidingApplication !== undefined) return yield* new DuplicatePublicApplication();

    if (existingApplicant === undefined) yield* writeApplicant(sql, applicant);
    else yield* updateApplicant(sql, applicant);

    const application: PublicApplication = {
      id: applicationId,
      applicantId: applicant.id,
      admissionPeriodId: period.id,
      departmentId: period.departmentId,
      fieldOfStudyId: command.fieldOfStudyId,
      yearOfStudy: command.yearOfStudy,
      submittedAt: now,
      revision: 0,
      activationDigest,
    };
    yield* writeApplication(sql, application);
    const observation: PublicApplicationSubmitObservation = {
      _tag: "Submitted",
      commandId: command.commandId,
      applicationId,
    };
    yield* writeCommandReceipt(sql, command, commandDigest, observation, application, now);
    yield* writeAudit(sql, command.commandId, application, now);
    const requests = makePublicApplicationOutboxRequests(
      command,
      application,
      applicant,
      command.email,
      activationToken,
    );
    yield* writeOutbox(sql, requests);
    return { observation, replayed: false, outboxCount: requests.length };
  });

export const executePublicApplicationCommand = (
  input: unknown,
  context: PublicApplicationSubmitContext,
): Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError, Database> =>
  Effect.gen(function* () {
    const command = yield* decodeSubmitPublicApplicationCommand(input);
    const now = yield* decodePublicApplicationNow(context.now);
    const sql = yield* Database;
    return yield* sql
      .withTransaction(executeCommandInTransaction(command, context, sql, now))
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(persistenceError("public application transaction")),
        ),
      );
  });

export const submitPublicApplication = (
  input: unknown,
  context: PublicApplicationSubmitContext,
): Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError, Database> =>
  executePublicApplicationCommand(input, context);

export const listPublicApplicationCatalog = (
  context: PublicApplicationCatalogContext,
): Effect.Effect<PublicApplicationCatalog, PublicApplicationError, Database> =>
  Effect.gen(function* () {
    const now = yield* decodePublicApplicationNow(context.now);
    const sql = yield* Database;
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
      Effect.catchTag("SqlError", () =>
        Effect.fail(persistenceError("read public application catalog")),
      ),
    );
    const departments = new Map<
      string,
      {
        departmentId: string;
        name: string;
        closesAt: string;
        fieldsOfStudy: Array<{ fieldOfStudyId: string; name: string }>;
      }
    >();
    for (const row of rows) {
      const existing = departments.get(row.department_id);
      const department = existing ?? {
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
): Effect.Effect<PublicApplicationConfirmation, PublicApplicationError, Database> =>
  Effect.gen(function* () {
    const normalizedId = applicationId.trim();
    if (normalizedId.length === 0) {
      return yield* new PublicApplicationDecodeError({ message: "invalid application identifier" });
    }
    const sql = yield* Database;
    const rows = yield* sql<{ readonly application_id: string }>`
    SELECT application_id
    FROM admission_applications
    WHERE application_id = ${normalizedId}
  `.pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(persistenceError("read application confirmation")),
      ),
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
