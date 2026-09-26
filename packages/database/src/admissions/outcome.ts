import { Effect, Option, Predicate, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import type { OrganizationPersonAuthority } from "@vektorprogrammet/domain/organization";
import {
  AdmissionOutcomeEntry,
  AdmissionOutcomeFailure,
  AdmissionOutcomePersistenceError,
  AdmissionOutcomeScope,
  AdmissionOutcomeScopes,
  admissionOutcomePermission,
  type AdmissionsOperations,
} from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseOperations } from "../service.js";

const findDepartments = SqlSchema.findAll({
  Request: Schema.Void,
  Result: AdmissionOutcomeScopes.fields.departments.value,
  execute: () =>
    Database.use(
      (sql) => sql`
    SELECT department_id AS "departmentId", name
    FROM public.organization_departments ORDER BY name, department_id`,
    ),
});

const findSemesters = SqlSchema.findAll({
  Request: Schema.Void,
  Result: AdmissionOutcomeScopes.fields.semesters.value,
  execute: () =>
    Database.use(
      (sql) => sql`
    SELECT semester_id AS "semesterId",
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
    FROM public.admission_period_semesters ORDER BY start_at DESC, semester_id`,
    ),
});

const readScopes = Effect.fnUntraced(function* (authority: OrganizationPersonAuthority) {
  const departments = (yield* findDepartments()).filter(
    (department) => admissionOutcomePermission(authority, department.departmentId) !== "Denied",
  );

  if (departments.length === 0)
    return yield* new AdmissionOutcomeFailure({ code: "authority.denied", status: 403 });

  return { departments, semesters: yield* findSemesters() };
});

/** Canonical application and applicant fields stay in their owning tables; the outcome is the highest revision. */
const readEntries = SqlSchema.findAll({
  Request: Schema.Union([
    Schema.Struct({ applicationId: AdmissionOutcomeEntry.fields.applicationId }),
    AdmissionOutcomeScope,
  ]),
  Result: AdmissionOutcomeEntry,
  execute: (selection) =>
    Database.use((sql) => {
      const where =
        "applicationId" in selection
          ? sql`application.application_id = ${selection.applicationId}`
          : sql`period.department_id = ${selection.departmentId} AND period.semester_id = ${selection.semesterId}`;

      return sql`
    SELECT application.application_id AS "applicationId", application.admission_period_id AS "admissionPeriodId",
      period.department_id AS "departmentId", period.semester_id AS "semesterId",
      applicant.first_name AS "firstName", applicant.last_name AS "lastName", applicant.email, applicant.phone,
      application.year_of_study AS "yearOfStudy", current.outcome, COALESCE(current.revision, 0) AS revision
    FROM public.admission_applications AS application
    INNER JOIN public.admission_periods AS period ON period.admission_period_id = application.admission_period_id
      AND period.department_id = application.department_id
    INNER JOIN public.admission_applicants AS applicant ON applicant.applicant_id = application.applicant_id
    LEFT JOIN LATERAL (
      SELECT outcome.outcome, outcome.revision FROM public.admission_application_outcomes AS outcome
      WHERE outcome.application_id = application.application_id
      ORDER BY outcome.revision DESC LIMIT 1
    ) AS current ON true
    WHERE ${where} ORDER BY applicant.last_name, applicant.first_name, application.application_id`;
    }),
});

const readEntry = (applicationId: AdmissionOutcomeEntry["applicationId"]) =>
  readEntries({ applicationId }).pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(new AdmissionOutcomeFailure({ code: "resource.not-found", status: 404 }))
        : Effect.succeed(rows[0]),
    ),
  );

const findSemester = SqlSchema.findOneOption({
  Request: AdmissionOutcomeScope.fields.semesterId,
  Result: Schema.Struct({ semesterId: AdmissionOutcomeScope.fields.semesterId }),
  execute: (semesterId) =>
    Database.use(
      (sql) => sql`
    SELECT semester_id AS "semesterId" FROM public.admission_period_semesters WHERE semester_id = ${semesterId}`,
    ),
});

const findPeriod = SqlSchema.findOneOption({
  Request: AdmissionOutcomeScope,
  Result: Schema.Struct({ admissionPeriodId: AdmissionOutcomeEntry.fields.admissionPeriodId }),
  execute: (scope) =>
    Database.use(
      (sql) => sql`
    SELECT admission_period_id AS "admissionPeriodId" FROM public.admission_periods
    WHERE department_id = ${scope.departmentId} AND semester_id = ${scope.semesterId}`,
    ),
});

const serializationConflict = (cause: unknown, depth = 0): boolean =>
  depth < 8 &&
  Predicate.isObjectOrArray(cause) &&
  (("code" in cause && (cause.code === "40001" || cause.code === "40P01")) ||
    ("cause" in cause && serializationConflict(cause.cause, depth + 1)));

/**
 * The admission outcome operations of the Admissions service over the captured Database.
 * They acquire no pool, transaction, or worker; the caller owns the transaction.
 */
export const admissionOutcomeOperations = (
  database: DatabaseOperations,
): Pick<
  AdmissionsOperations,
  | "listAdmissionOutcomeScopes"
  | "readAdmissionOutcomes"
  | "readAdmissionOutcome"
  | "recordAdmissionOutcome"
> => {
  const run = <A, E>(effect: Effect.Effect<A, E, Database>) =>
    effect.pipe(
      Effect.provideService(Database, database),
      Effect.mapError((cause) => {
        if (cause instanceof AdmissionOutcomeFailure) return cause;
        const conflict = serializationConflict(cause);

        return new AdmissionOutcomePersistenceError({
          code: conflict ? "transaction.conflict" : "internal.error",
          status: conflict ? 409 : 500,
          cause,
        });
      }),
    );

  return {
    listAdmissionOutcomeScopes: (authority) => run(readScopes(authority)),
    readAdmissionOutcomes: (scope) =>
      run(
        Effect.gen(function* () {
          if (Option.isNone(yield* findSemester(scope.semesterId)))
            return yield* new AdmissionOutcomeFailure({ code: "scope.invalid", status: 422 });
          const period = yield* findPeriod(scope);

          return Option.isSome(period)
            ? {
                admissionPeriodId: period.value.admissionPeriodId,
                entries: yield* readEntries(scope),
              }
            : { admissionPeriodId: null, entries: [] };
        }),
      ),
    readAdmissionOutcome: (applicationId) => run(readEntry(applicationId)),
    recordAdmissionOutcome: ({ applicationId, command, actor, now }, checkPrecondition) =>
      Effect.gen(function* () {
        yield* run(
          Database.use(
            (sql) =>
              sql`SELECT application_id FROM public.admission_applications WHERE application_id = ${applicationId} FOR UPDATE`,
          ),
        );
        const current = yield* run(readEntry(applicationId));
        yield* checkPrecondition(current);

        if (current.outcome === command.outcome) return current;

        return yield* run(
          Effect.gen(function* () {
            yield* Database.use(
              (sql) => sql`INSERT INTO public.admission_application_outcomes
              (application_id, revision, outcome, decided_by_person_id, decided_at)
              VALUES (${applicationId}, ${current.revision + 1}, ${command.outcome}, ${actor}, ${now})`,
            );

            return yield* readEntry(applicationId);
          }),
        );
      }),
  };
};
