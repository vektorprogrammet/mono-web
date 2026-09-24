import { Effect, Option, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { Database } from "../service.js";
import type { OrganizationPersonAuthority } from "@vektorprogrammet/domain/organization";
import {
  SubstituteEntry,
  SubstituteEntryFields,
  SubstituteFailure,
  SubstituteScope,
  SubstituteScopes,
  substitutePermission,
  type SubstituteCommand,
} from "@vektorprogrammet/domain/substitutes";

const findDepartments = SqlSchema.findAll({
  Request: Schema.Void,
  Result: SubstituteScopes.fields.departments.value,
  execute: () => Database.use((sql) => sql`
    SELECT department_id AS "departmentId", name
    FROM public.organization_departments ORDER BY name, department_id`),
});

const findSemesters = SqlSchema.findAll({
  Request: Schema.Void,
  Result: SubstituteScopes.fields.semesters.value,
  execute: () => Database.use((sql) => sql`
    SELECT semester_id AS "semesterId",
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
    FROM public.admission_period_semesters ORDER BY start_at DESC, semester_id`),
});

export const readSubstituteScopes = Effect.fnUntraced(function* (authority: OrganizationPersonAuthority) {
  const departments = (yield* findDepartments()).filter(
    (department) => substitutePermission(authority, department.departmentId) !== "Denied",
  );
  if (departments.length === 0)
    return yield* Effect.fail(new SubstituteFailure({ code: "authority.denied", status: 403 }));
  return { departments, semesters: yield* findSemesters() };
});

/** Canonical application, person details, scope, and year remain in their owning tables. */
export const readSubstituteEntries = SqlSchema.findAll({
  Request: Schema.Union([
    Schema.Struct({ applicationId: SubstituteEntryFields.applicationId }),
    SubstituteScope,
  ]),
  Result: SubstituteEntry,
  execute: (selection) => Database.use((sql) => {
    const where = "applicationId" in selection
      ? sql`application.application_id = ${selection.applicationId}`
      : sql`period.department_id = ${selection.departmentId} AND period.semester_id = ${selection.semesterId}`;
    return sql`
    SELECT application.application_id AS "applicationId", application.admission_period_id AS "admissionPeriodId",
      period.department_id AS "departmentId", period.semester_id AS "semesterId",
      applicant.first_name AS "firstName", applicant.last_name AS "lastName", applicant.email, applicant.phone,
      application.year_of_study AS "yearOfStudy", COALESCE(preferences.active, false) AS active,
      COALESCE(preferences.revision, 0) AS revision,
      CASE WHEN preferences.application_id IS NULL THEN NULL ELSE jsonb_build_object(
        'monday', preferences.monday, 'tuesday', preferences.tuesday, 'wednesday', preferences.wednesday,
        'thursday', preferences.thursday, 'friday', preferences.friday, 'language', preferences.language
      ) END AS preferences
    FROM public.admission_applications AS application
    INNER JOIN public.admission_periods AS period ON period.admission_period_id = application.admission_period_id
      AND period.department_id = application.department_id
    INNER JOIN public.admission_applicants AS applicant ON applicant.applicant_id = application.applicant_id
    LEFT JOIN public.admission_substitute_preferences AS preferences ON preferences.application_id = application.application_id
    WHERE ${where} ORDER BY applicant.last_name, applicant.first_name, application.application_id`;
  }),
});

export const readSubstituteEntry = (applicationId: SubstituteEntry["applicationId"]) =>
  readSubstituteEntries({ applicationId }).pipe(
    Effect.flatMap((rows) => rows[0] === undefined
      ? Effect.fail(new SubstituteFailure({ code: "resource.not-found", status: 404 }))
      : Effect.succeed(rows[0])),
  );

const findSemester = SqlSchema.findOneOption({
  Request: SubstituteScope.fields.semesterId,
  Result: Schema.Struct({ semesterId: SubstituteScope.fields.semesterId }),
  execute: (semesterId) => Database.use((sql) => sql`
    SELECT semester_id AS "semesterId" FROM public.admission_period_semesters WHERE semester_id = ${semesterId}`),
});

const findPeriod = SqlSchema.findOneOption({
  Request: SubstituteScope,
  Result: Schema.Struct({ admissionPeriodId: SubstituteEntryFields.admissionPeriodId }),
  execute: (scope) => Database.use((sql) => sql`
    SELECT admission_period_id AS "admissionPeriodId" FROM public.admission_periods
    WHERE department_id = ${scope.departmentId} AND semester_id = ${scope.semesterId}`),
});

export const readSubstitutePeriod = Effect.fnUntraced(function* (scope: SubstituteScope) {
  if (Option.isNone(yield* findSemester(scope.semesterId)))
    return yield* Effect.fail(new SubstituteFailure({ code: "scope.invalid", status: 422 }));
  const period = yield* findPeriod(scope);
  return Option.isSome(period) ? period.value.admissionPeriodId : null;
});

/** Internal command lock; the service holds it until the caller's transaction ends. */
export const lockSubstituteApplication = SqlSchema.void({
  Request: SubstituteEntryFields.applicationId,
  execute: (applicationId) => Database.use((sql) => sql`
    SELECT application_id FROM public.admission_applications WHERE application_id = ${applicationId} FOR UPDATE`),
});

export const mutateSubstitute = (entry: SubstituteEntry, command: SubstituteCommand) =>
  Database.use((sql) => Effect.gen(function* () {
    if (command.action === "activate" && entry.active)
      return yield* Effect.fail(new SubstituteFailure({ code: "substitute.already-active", status: 400 }));
    if (command.action !== "activate" && !entry.active)
      return yield* Effect.fail(new SubstituteFailure({ code: "substitute.inactive", status: 400 }));
    if (command.action === "deactivate") {
      yield* sql`UPDATE public.admission_substitute_preferences SET active = false, revision = revision + 1 WHERE application_id = ${entry.applicationId}`;
    } else {
      const { input } = command;
      yield* sql`INSERT INTO public.admission_substitute_preferences
        (application_id, active, monday, tuesday, wednesday, thursday, friday, language, revision)
        VALUES (${entry.applicationId}, true, ${input.monday}, ${input.tuesday}, ${input.wednesday}, ${input.thursday}, ${input.friday}, ${input.language}, 1)
        ON CONFLICT (application_id) DO UPDATE SET active = true, monday = EXCLUDED.monday, tuesday = EXCLUDED.tuesday,
          wednesday = EXCLUDED.wednesday, thursday = EXCLUDED.thursday, friday = EXCLUDED.friday,
          language = EXCLUDED.language, revision = public.admission_substitute_preferences.revision + 1`;
      yield* sql`UPDATE public.admission_applications SET year_of_study = ${input.yearOfStudy}, revision = revision + 1
        WHERE application_id = ${entry.applicationId}`;
    }
    return yield* readSubstituteEntry(entry.applicationId);
  }));
