import { Data, Effect, Schema } from "effect";
import { Database } from "../database/service.js";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import type { DepartmentId } from "../organization/schema.js";
import {
  SubstituteEntry,
  SubstituteScopes,
  type SubstituteMutation,
  type SubstituteScope,
} from "./schema.js";

export class SubstituteFailure extends Data.TaggedError("SubstituteFailure")<{
  readonly code:
    | "authority.denied"
    | "resource.not-found"
    | "substitute.already-active"
    | "substitute.inactive"
    | "scope.invalid";
  readonly status: 400 | 403 | 404 | 422;
}> {}

/** Uses the canonical mapper, including inactive administrator and multi-membership semantics. */
export const substitutePermission = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
) => {
  const decision = mapOrganizationAuthorityToAdmissionPeriodActor(authority, departmentId);
  return decision._tag === "Deny"
    ? "Denied"
    : decision.value._tag === "Member"
      ? "ReadOnly"
      : "Manage";
};

export const readSubstituteScopes = (authority: OrganizationPersonAuthority) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const departments = yield* sql<{ departmentId: DepartmentId; name: string }>`
    SELECT department_id AS "departmentId", name FROM public.organization_departments ORDER BY name, department_id`;
      const visible = departments.filter(
        (department) => substitutePermission(authority, department.departmentId) !== "Denied",
      );
      if (visible.length === 0)
        return yield* Effect.fail(new SubstituteFailure({ code: "authority.denied", status: 403 }));
      const semesters = yield* sql`
    SELECT semester_id AS "semesterId",
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
    FROM public.admission_period_semesters ORDER BY start_at DESC, semester_id`;
      return yield* Schema.decodeUnknownEffect(SubstituteScopes)({
        departments: visible,
        semesters,
      });
    }),
  );

/** A single canonical join; no profile, scope or year copies in substitute storage. */
export const readSubstituteEntries = (selection: { applicationId: string } | SubstituteScope) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const where =
        "applicationId" in selection
          ? sql`application.application_id = ${selection.applicationId}`
          : sql`period.department_id = ${selection.departmentId} AND period.semester_id = ${selection.semesterId}`;
      const rows = yield* sql`
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
      return yield* Schema.decodeUnknownEffect(Schema.Array(SubstituteEntry))(rows);
    }),
  );
export const readSubstituteEntry = (applicationId: string) =>
  readSubstituteEntries({ applicationId }).pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(new SubstituteFailure({ code: "resource.not-found", status: 404 }))
        : Effect.succeed(rows[0]),
    ),
  );

export const readSubstitutePeriod = (scope: SubstituteScope) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const semesters =
        yield* sql`SELECT semester_id FROM public.admission_period_semesters WHERE semester_id = ${scope.semesterId}`;
      if (semesters.length === 0)
        return yield* Effect.fail(new SubstituteFailure({ code: "scope.invalid", status: 422 }));
      const periods = yield* sql<{
        admissionPeriodId: string;
      }>`SELECT admission_period_id AS "admissionPeriodId"
    FROM public.admission_periods WHERE department_id = ${scope.departmentId} AND semester_id = ${scope.semesterId}`;
      return periods[0]?.admissionPeriodId ?? null;
    }),
  );

/** Called only inside the caller-owned atomic HTTP command transaction. */
export const lockSubstituteApplication = (applicationId: string) =>
  Database.use((sql) =>
    sql`
  SELECT application_id FROM public.admission_applications WHERE application_id = ${applicationId} FOR UPDATE`.pipe(
      Effect.asVoid,
    ),
  );
export type SubstituteCommand =
  | { readonly action: "deactivate" }
  | { readonly action: "activate" | "edit"; readonly input: SubstituteMutation };
export const mutateSubstitute = (entry: SubstituteEntry, command: SubstituteCommand) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const { action } = command;
      if (action === "activate" && entry.active)
        return yield* Effect.fail(
          new SubstituteFailure({ code: "substitute.already-active", status: 400 }),
        );
      if (action !== "activate" && !entry.active)
        return yield* Effect.fail(
          new SubstituteFailure({ code: "substitute.inactive", status: 400 }),
        );
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
    }),
  );
