import { Database, type DatabaseOperations } from "../service.js";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { flow, Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  AdmissionDepartment,
  AdmissionFieldOfStudy,
  AdmissionPeriod,
} from "@vektorprogrammet/domain/admission-period";
import {
  ApplicantProgressItemSchema,
  PublicApplicationSubmitInputSchema,
  PublicApplicationConfirmationSchema,
  ApplicantProgressStateSchema,
  type ApplicantContactProjectionFailure,
  AmbiguousAdmissionPeriod,
  DuplicatePublicApplication,
  DuplicatePublicApplicationCommandConflict,
  FieldOfStudyDepartmentMismatch,
  FieldOfStudyInactive,
  FieldOfStudyNotFound,
  NoEligibleAdmissionPeriod,
  PublicApplicationDecodeError,
  PublicApplicationDepartmentNotFound,
  PublicApplicationNotFound,
  PublicApplicationQueryLimitExceeded,
  PublicApplicationPersistenceError,
  type PublicApplicationError,
} from "@vektorprogrammet/domain/application";
import {
  makePublicApplicationOutboxRequests,
  type PublicApplicationOutboxRequest,
} from "@vektorprogrammet/domain/application";
import {
  publicApplicantIdForCommand,
  publicApplicationActivationDigest,
  publicApplicationCommandDigest,
  publicApplicationIdForCommand,
  canonicalJson,
} from "@vektorprogrammet/domain/application";
import {
  decodePublicApplicationNow,
  decodePublicApplicationSubmitInput,
  decodeSubmitPublicApplicationCommand,
} from "@vektorprogrammet/domain/application";
import {
  ApplicantContactProjectionSchema,
  ApplicantProgressResponseSchema,
  ApplicantRecord,
  PublicApplicationCatalogSchema,
  PublicApplicationActivationTokenSchema,
  PublicApplication,
  PublicApplicationIdSchema,
  type ApplicantContactProjection,
  type ApplicantProgressResponse,
  type PublicApplicationId,
  PublicApplicationSubmitObservationSchema,
  type PublicApplicationCatalogContext,
  type PublicApplicationCatalogHttpSource,
  type PublicApplicationConfirmation,
  type PublicApplicationSubmitContext,
  type PublicApplicationSubmitInput,
  type PublicApplicationSubmitObservation,
  type PublicApplicationSubmitResult,
  type SubmitPublicApplicationCommand,
} from "@vektorprogrammet/domain/application";

export const ADMISSIONS_APPLICANT_CONTACT_READ_LIMIT = 100;

interface ApplicantContactRow {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
}

interface CommandReceiptRow {
  readonly command_sha256: string;
  readonly observation_json: unknown;
}

interface CatalogRow {
  readonly admission_period_id: string;
  readonly admission_period_revision: number;
  readonly semester_id: string;
  readonly semester_revision: number;
  readonly department_id: string;
  readonly department_revision: number;
  readonly department_name: string;
  readonly closes_at: string;
  readonly field_of_study_id: string | null;
  readonly field_of_study_revision: number | null;
  readonly field_of_study_name: string | null;
}

interface CatalogIntervalRow {
  readonly lowerBound: string | null;
  readonly upperBound: string | null;
}

interface ApplicantProgressRow {
  readonly applicationId: string;
  readonly admissionPeriodId: string;
  readonly departmentId: string;
  readonly departmentName: string;
  readonly semesterId: string;
  readonly submittedAt: string;
  readonly interviewId: string | null;
  readonly responseState: string | null;
  readonly scheduledAt: string | null;
  readonly room: string | null;
  readonly campus: string | null;
  readonly mapLink: string | null;
  readonly hasConduct: boolean;
  readonly hasCancellation: boolean;
  readonly hasReturningRegistration: boolean;
  readonly affiliationStatus: string | null;
  readonly hasActivePlacement: boolean;
}

/**
 * The SQL failure stays the standard error cause, so the HTTP command executor can
 * recognize a lost serialization race and restart the transaction on a fresh snapshot.
 */
const persistenceError = (
  operation: string,
  cause?: SqlError,
): PublicApplicationPersistenceError => {
  const error = new PublicApplicationPersistenceError({
    operation,
    message: "public application persistence failed",
  });

  if (cause !== undefined) error.cause = cause;

  return error;
};

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

const decodeStoredObservation = flow(
  Schema.decodeUnknownEffect(PublicApplicationSubmitObservationSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError(() => persistenceError("decode stored application observation")),
);

const decodeCatalog = flow(
  Schema.decodeUnknownEffect(PublicApplicationCatalogSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError(() => persistenceError("decode application catalog")),
);

const departmentExists = (
  sql: DatabaseOperations,
  departmentId: string,
): Effect.Effect<boolean, PublicApplicationPersistenceError> =>
  sql<typeof AdmissionDepartment.Encoded>`
    SELECT department_id AS "departmentId",
      COALESCE(NULLIF(name, ''), department_id) AS name
    FROM admission_period_departments
    WHERE department_id = ${departmentId}
  `.pipe(
    Effect.map((rows) => rows.length === 1),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read application department", cause)),
    ),
  );

const findEligiblePeriod = (
  sql: DatabaseOperations,
  departmentId: string,
  now: string,
): Effect.Effect<
  AdmissionPeriod | undefined,
  PublicApplicationPersistenceError | AmbiguousAdmissionPeriod
> =>
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
    FOR UPDATE OF p
  `.pipe(
    Effect.flatMap(
      (
        rows,
      ): Effect.Effect<
        AdmissionPeriod | undefined,
        PublicApplicationPersistenceError | AmbiguousAdmissionPeriod
      > => {
        if (rows.length > 1) {
          return Effect.fail(
            new AmbiguousAdmissionPeriod({ departmentId: DepartmentId.make(departmentId) }),
          );
        }

        return rows[0] === undefined
          ? Effect.succeed(undefined)
          : decodeAdmissionPeriodRow(rows[0]);
      },
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("find eligible admission period", cause)),
    ),
  );

const findFieldOfStudy = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read field of study", cause)),
    ),
  );

const findApplicantForUpdate = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock applicant identity", cause)),
    ),
  );

const findApplicationForApplicantPeriod = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read duplicate application", cause)),
    ),
  );

const findApplicationById = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read application identity", cause)),
    ),
  );

const findCommandReceipt = (
  sql: DatabaseOperations,
  commandId: string,
): Effect.Effect<CommandReceiptRow | undefined, PublicApplicationPersistenceError> =>
  sql<CommandReceiptRow>`
    SELECT command_sha256, observation_json
    FROM admission_application_command_receipts
    WHERE command_id = ${commandId}
    FOR UPDATE
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read application command receipt", cause)),
    ),
  );

const writeApplicant = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert applicant", cause)),
    ),
  );

const updateApplicant = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("update applicant profile", cause)),
    ),
  );

const writeApplication = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert application", cause)),
    ),
  );

const writeCommandReceipt = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert application command receipt", cause)),
    ),
  );

const writeAudit = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert application audit", cause)),
    ),
  );

const writeOutbox = (
  sql: DatabaseOperations,
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
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert application outbox", cause)),
    ),
  );

const executeCommandInTransaction = (
  command: SubmitPublicApplicationCommand,
  context: PublicApplicationSubmitContext,
  sql: DatabaseOperations,
  now: string,
): Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError> =>
  Effect.gen(function* () {
    const commandDigest = publicApplicationCommandDigest(command);
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock application command", cause)),
      ),
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
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock applicant identity", cause)),
      ),
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
      existingApplicant?.id ?? context.applicantId ?? publicApplicantIdForCommand(command);

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

    const applicationId = context.applicationId ?? publicApplicationIdForCommand(command);
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

    const observation: PublicApplicationSubmitObservation =
      PublicApplicationSubmitObservationSchema.cases.Submitted.make({
        commandId: command.commandId,
        applicationId,
      });

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
  input: typeof PublicApplicationSubmitInputSchema.Encoded,
  context: PublicApplicationSubmitContext,
): Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError, Database> =>
  Effect.gen(function* () {
    const command = yield* decodeSubmitPublicApplicationCommand(input);
    const now = yield* decodePublicApplicationNow(context.now);
    const sql = yield* Database;

    return yield* sql
      .withTransaction(executeCommandInTransaction(command, context, sql, now))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("public application transaction", cause)),
        ),
      );
  });

export const submitPublicApplication = (
  input: typeof PublicApplicationSubmitInputSchema.Encoded,
  context: PublicApplicationSubmitContext,
): Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError, Database> =>
  executePublicApplicationCommand(input, context);

export const listPublicApplicationCatalog = (
  context: PublicApplicationCatalogContext,
): Effect.Effect<PublicApplicationCatalogHttpSource, PublicApplicationError, Database> =>
  Effect.gen(function* () {
    const now = yield* decodePublicApplicationNow(context.now);
    const sql = yield* Database;

    const rows = yield* sql<CatalogRow>`
    WITH eligible AS (
      SELECT p.admission_period_id, p.revision AS admission_period_revision,
        s.semester_id, s.revision AS semester_revision,
        p.department_id, p.end_at,
        ROW_NUMBER() OVER (
          PARTITION BY p.department_id
          ORDER BY p.start_at DESC, p.admission_period_id ASC
        ) AS period_rank,
        COUNT(*) OVER (PARTITION BY p.department_id) AS period_count
      FROM admission_periods p
      INNER JOIN admission_period_semesters s ON s.semester_id = p.semester_id
      WHERE s.start_at <= ${now}::timestamptz AND ${now}::timestamptz < s.end_at
        AND p.start_at <= ${now}::timestamptz AND ${now}::timestamptz < p.end_at
    )
    SELECT e.admission_period_id,
      e.admission_period_revision,
      e.semester_id,
      e.semester_revision,
      d.department_id,
      d.revision AS department_revision,
      COALESCE(NULLIF(d.name, ''), d.department_id) AS department_name,
      to_char(e.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS closes_at,
      f.field_of_study_id,
      f.revision AS field_of_study_revision,
      f.name AS field_of_study_name
    FROM eligible e
    INNER JOIN admission_period_departments d ON d.department_id = e.department_id
    LEFT JOIN admission_period_fields_of_study f
      ON f.department_id = e.department_id AND f.active = TRUE
    WHERE e.period_rank = 1 AND e.period_count = 1
    ORDER BY d.department_id, f.field_of_study_id
  `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read public application catalog", cause)),
      ),
    );

    const intervalRows = yield* sql<CatalogIntervalRow>`
      WITH boundaries AS (
        SELECT start_at AS boundary_at FROM admission_periods
        UNION
        SELECT end_at AS boundary_at FROM admission_periods
        UNION
        SELECT start_at AS boundary_at FROM admission_period_semesters
        UNION
        SELECT end_at AS boundary_at FROM admission_period_semesters
      )
      SELECT
        to_char(
          (MAX(boundary_at) FILTER (WHERE boundary_at <= ${now}::timestamptz))
            AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "lowerBound",
        to_char(
          (MIN(boundary_at) FILTER (WHERE ${now}::timestamptz < boundary_at))
            AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "upperBound"
      FROM boundaries
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read public application catalog interval", cause)),
      ),
    );

    const interval = intervalRows[0];

    if (interval === undefined) {
      return yield* persistenceError("read public application catalog interval");
    }

    const departments = new Map<
      string,
      {
        departmentId: string;
        name: string;
        closesAt: string;
        fieldsOfStudy: Array<{ fieldOfStudyId: string; name: string }>;
      }
    >();

    const versions = new Map<string, number>();

    for (const row of rows) {
      versions.set(`admission-period:${row.admission_period_id}`, row.admission_period_revision);
      versions.set(`admission-semester:${row.semester_id}`, row.semester_revision);
      versions.set(`admission-department:${row.department_id}`, row.department_revision);
      const existing = departments.get(row.department_id);

      const department = existing ?? {
        departmentId: row.department_id,
        name: row.department_name,
        closesAt: row.closes_at,
        fieldsOfStudy: [],
      };

      if (
        row.field_of_study_id !== null &&
        row.field_of_study_name !== null &&
        row.field_of_study_revision !== null
      ) {
        department.fieldsOfStudy.push({
          fieldOfStudyId: row.field_of_study_id,
          name: row.field_of_study_name,
        });
        versions.set(
          `admission-field-of-study:${row.field_of_study_id}`,
          row.field_of_study_revision,
        );
      }

      departments.set(row.department_id, department);
    }

    const catalog = yield* decodeCatalog({ departments: [...departments.values()] });

    return {
      catalog,
      validatorSource: {
        intervalIdentity: `${interval.lowerBound ?? "-infinity"}/${interval.upperBound ?? "infinity"}`,
        itemRevisions: [...versions].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      },
    };
  });

export const findPublicApplicationConfirmation = (
  applicationId: string,
): Effect.Effect<PublicApplicationConfirmation, PublicApplicationError, Database> =>
  Effect.gen(function* () {
    const normalizedId = yield* Schema.decodeUnknownEffect(PublicApplicationIdSchema)(
      applicationId.trim(),
    ).pipe(
      Effect.mapError(
        () => new PublicApplicationDecodeError({ message: "invalid application identifier" }),
      ),
    );

    const sql = yield* Database;

    const rows = yield* sql<{ readonly application_id: string }>`
    SELECT application_id
    FROM admission_applications
    WHERE application_id = ${normalizedId}
  `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read application confirmation", cause)),
      ),
    );

    if (rows[0] === undefined) {
      return yield* new PublicApplicationNotFound({ applicationId: normalizedId });
    }

    // The row only proves that the application exists; its identity is the decoded one.
    return PublicApplicationConfirmationSchema.make({ applicationId: normalizedId });
  });

/**
 * Reads canonical applicant contacts in one bounded batch. The application identity remains the
 * key so callers cannot substitute a contact from another application owned by the same applicant.
 */
export const readApplicantContacts = (
  applicationIds: ReadonlyArray<PublicApplicationId>,
): Effect.Effect<
  ReadonlyArray<ApplicantContactProjection>,
  ApplicantContactProjectionFailure,
  Database
> =>
  Effect.gen(function* () {
    if (applicationIds.length > ADMISSIONS_APPLICANT_CONTACT_READ_LIMIT) {
      return yield* new PublicApplicationQueryLimitExceeded({
        limit: ADMISSIONS_APPLICANT_CONTACT_READ_LIMIT,
      });
    }

    const decodedIds = yield* Schema.decodeUnknownEffect(Schema.Array(PublicApplicationIdSchema))(
      applicationIds,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () => new PublicApplicationDecodeError({ message: "invalid application identifier batch" }),
      ),
    );

    const uniqueIds = [...new Set(decodedIds)].sort((left, right) => left.localeCompare(right));

    if (uniqueIds.length === 0) return [];

    const sql = yield* Database;

    const rows = yield* sql<ApplicantContactRow>`
      WITH requested AS (
        SELECT value AS application_id
        FROM jsonb_array_elements_text(${canonicalJson(uniqueIds)}::jsonb) AS ids(value)
      )
      SELECT
        application.application_id AS "applicationId",
        applicant.applicant_id AS "applicantId",
        applicant.first_name AS "firstName",
        applicant.last_name AS "lastName",
        applicant.email,
        applicant.phone
      FROM requested
      INNER JOIN admission_applications AS application
        ON application.application_id = requested.application_id
      INNER JOIN admission_applicants AS applicant
        ON applicant.applicant_id = application.applicant_id
      ORDER BY application.application_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read applicant contact projections", cause)),
      ),
    );

    const byApplicationId = new Map<string, ApplicantContactProjection>();

    for (const row of rows) {
      const contact = yield* Schema.decodeUnknownEffect(ApplicantContactProjectionSchema)(row, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          () =>
            new PublicApplicationDecodeError({
              message: "invalid persisted applicant contact projection",
            }),
        ),
      );

      if (byApplicationId.has(contact.applicationId)) {
        return yield* new PublicApplicationDecodeError({
          message: "duplicate persisted applicant contact projection",
        });
      }

      byApplicationId.set(contact.applicationId, contact);
    }

    const contacts: ApplicantContactProjection[] = [];

    for (const applicationId of uniqueIds) {
      const contact = byApplicationId.get(applicationId);

      if (contact === undefined) {
        return yield* new PublicApplicationNotFound({ applicationId });
      }

      contacts.push(contact);
    }

    return contacts;
  });

/**
 * Derives the current-semester applicant-owned progress projection from canonical source facts.
 * Person custody is explicit through applicant_account_links; contact equality is never consulted.
 */
export const readApplicantProgress = (
  personId: string,
  now: string,
): Effect.Effect<ApplicantProgressResponse, PublicApplicationPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    const rows = yield* sql<ApplicantProgressRow>`
      SELECT
        application.application_id AS "applicationId",
        application.admission_period_id AS "admissionPeriodId",
        application.department_id AS "departmentId",
        department.name AS "departmentName",
        period.semester_id AS "semesterId",
        to_char(
          application.submitted_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "submittedAt",
        interview.interview_id AS "interviewId",
        invitation.response_state AS "responseState",
        CASE
          WHEN invitation.invitation_id IS NULL THEN NULL
          ELSE to_char(
            schedule.scheduled_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        END AS "scheduledAt",
        CASE WHEN invitation.invitation_id IS NULL THEN NULL ELSE schedule.room END AS room,
        CASE WHEN invitation.invitation_id IS NULL THEN NULL ELSE schedule.campus END AS campus,
        CASE WHEN invitation.invitation_id IS NULL THEN NULL ELSE schedule.map_link END AS "mapLink",
        EXISTS (
          SELECT 1
          FROM public.recruitment_interview_conducts AS conduct
          WHERE conduct.interview_id = interview.interview_id
        ) AS "hasConduct",
        EXISTS (
          SELECT 1
          FROM public.recruitment_interview_cancellations AS cancellation
          WHERE cancellation.interview_id = interview.interview_id
        ) AS "hasCancellation",
        EXISTS (
          SELECT 1
          FROM public.admission_returning_registrations AS registration
          WHERE registration.application_id = application.application_id
        ) AS "hasReturningRegistration",
        affiliation.status AS "affiliationStatus",
        EXISTS (
          SELECT 1
          FROM public.assistant_placements AS placement
          WHERE placement.person_id = link.person_id
            AND placement.department_id = application.department_id
            AND placement.semester_id = period.semester_id
            AND placement.active
        ) AS "hasActivePlacement"
      FROM public.applicant_account_links AS link
      INNER JOIN public.admission_applications AS application
        ON application.applicant_id = link.applicant_id
      INNER JOIN public.admission_periods AS period
        ON period.admission_period_id = application.admission_period_id
      INNER JOIN public.admission_period_semesters AS semester
        ON semester.semester_id = period.semester_id
      INNER JOIN public.admission_period_departments AS department
        ON department.department_id = application.department_id
      LEFT JOIN public.recruitment_interviews AS interview
        ON interview.application_id = application.application_id
      LEFT JOIN public.recruitment_invitations AS invitation
        ON invitation.interview_id = interview.interview_id
        AND invitation.superseded_at IS NULL
      LEFT JOIN public.recruitment_interview_schedules AS schedule
        ON schedule.interview_id = invitation.interview_id
        AND schedule.schedule_revision = invitation.schedule_revision
      LEFT JOIN public.organization_volunteer_affiliations AS affiliation
        ON affiliation.person_id = link.person_id
        AND affiliation.department_id = application.department_id
      WHERE link.person_id = ${personId}
        AND semester.start_at <= ${now}::timestamptz
        AND ${now}::timestamptz < semester.end_at
      ORDER BY application.submitted_at DESC, application.application_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read applicant progress", cause)),
      ),
    );

    const applications: Array<typeof ApplicantProgressItemSchema.Encoded> = [];

    for (const row of rows) {
      if (row.hasConduct && row.hasCancellation) {
        return yield* persistenceError("read inconsistent applicant interview lifecycle");
      }

      let progress: typeof ApplicantProgressStateSchema.Encoded;

      if (row.hasActivePlacement) {
        progress = ApplicantProgressStateSchema.cases.AssignedToSchool.make({});
      } else if (row.hasConduct || row.hasReturningRegistration) {
        if (row.affiliationStatus === "Active") {
          progress = ApplicantProgressStateSchema.cases.AffiliationActive.make({});
        } else if (row.affiliationStatus === "Pending") {
          progress = ApplicantProgressStateSchema.cases.AffiliationPending.make({});
        } else {
          progress = row.hasConduct
            ? ApplicantProgressStateSchema.cases.InterviewCompleted.make({})
            : ApplicantProgressStateSchema.cases.ReturningRegistrationCompleted.make({});
        }
      } else if (row.hasCancellation || row.responseState === "Rejected") {
        progress = ApplicantProgressStateSchema.cases.Cancelled.make({});
      } else if (row.responseState === "RequestedNewTime") {
        progress = ApplicantProgressStateSchema.cases.AwaitingNewInterviewTime.make({});
      } else if (row.responseState === "Accepted" || row.responseState === "Pending") {
        if (row.scheduledAt === null || row.room === null) {
          return yield* persistenceError("read applicant invitation without schedule");
        }

        const schedule = {
          scheduledAt: row.scheduledAt,
          room: row.room,
          campus: row.campus,
          mapLink: row.mapLink,
        };

        progress = yield* row.responseState === "Accepted"
          ? ApplicantProgressStateSchema.cases.InterviewAccepted.makeEffect({ schedule }).pipe(
              Effect.mapError(() => persistenceError("decode applicant progress projection")),
            )
          : ApplicantProgressStateSchema.cases.InvitedToInterview.makeEffect({ schedule }).pipe(
              Effect.mapError(() => persistenceError("decode applicant progress projection")),
            );
      } else if (row.responseState === null) {
        progress = ApplicantProgressStateSchema.cases.ApplicationReceived.make({});
      } else {
        return yield* persistenceError("read unknown applicant invitation response state");
      }

      applications.push({
        applicationId: row.applicationId,
        admissionPeriodId: row.admissionPeriodId,
        departmentId: row.departmentId,
        departmentName: row.departmentName,
        semesterId: row.semesterId,
        submittedAt: row.submittedAt,
        progress,
      });
    }

    return yield* Schema.decodeUnknownEffect(ApplicantProgressResponseSchema)(
      { personId, observedAt: now, applications },
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(() => persistenceError("decode applicant progress projection")));
  });

export const decodePublicApplicationCommand = decodeSubmitPublicApplicationCommand;

export const decodePublicApplicationSubmit = decodePublicApplicationSubmitInput;
