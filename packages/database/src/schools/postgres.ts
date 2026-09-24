import { flow, Predicate, Effect, Schema } from "effect";
import { Database } from "../service.js";
import {
  SchoolsDecodeError,
  SchoolsPersistenceError,
  type SchoolsFailure,
} from "@vektorprogrammet/domain/schools";
import {
  SchoolDirectoryDepartmentsSchema,
  SchoolDirectoryListInputSchema,
  SchoolDirectorySchema,
  SchoolId,
  type SchoolDirectory,
  type SchoolDirectoryEntry,
  type SchoolDirectoryListInput,
} from "@vektorprogrammet/domain/schools";

const DirectoryRowSchema = Schema.Struct({
  schoolId: Schema.String,
  name: Schema.String,
  contactPerson: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  language: Schema.Literals(["Norwegian", "International"]),
  departments: SchoolDirectoryDepartmentsSchema,
  isActive: Schema.Boolean,
});

type DirectoryRow = typeof DirectoryRowSchema.Type;

const decodeError = (operation: string, cause: unknown): SchoolsDecodeError =>
  new SchoolsDecodeError({ operation, message: String(cause) });

const persistenceError = (operation: string, cause: unknown): SchoolsPersistenceError =>
  new SchoolsPersistenceError({ operation, message: String(cause) });

const decodeRows = flow(
  flow(
    Schema.decodeUnknownEffect(Schema.Array(DirectoryRowSchema), { onExcessProperty: "error" }),
    Effect.mapError((cause) => decodeError("decode Schools directory rows", cause)),
  ),
  Effect.flatMap((rows) =>
    Effect.gen(function* () {
      const entries: Array<SchoolDirectoryEntry> = [];

      for (const row of rows) {
        const schoolId = yield* Schema.decodeUnknownEffect(SchoolId)(Number(row.schoolId)).pipe(
          Effect.mapError((cause) => decodeError("decode Schools directory schoolId", cause)),
        );

        entries.push({
          schoolId,
          name: row.name,
          contactPerson: row.contactPerson,
          email: row.email,
          phone: row.phone,
          language: row.language,
          departments: row.departments,
          isActive: row.isActive,
        });
      }

      return entries;
    }),
  ),
);

/**
 * Reads the full visible directory in deterministic order. The visibility
 * EXISTS and aggregation use the same scope, so a school is emitted once and
 * carries only the department intersection the caller may observe.
 */
export const listSchoolDirectoryPostgres = (
  input: SchoolDirectoryListInput,
): Effect.Effect<SchoolDirectory, SchoolsFailure, Database> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SchoolDirectoryListInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode Schools directory input", cause)));

    if (
      Predicate.isTagged(decoded.scope, "DepartmentIds") &&
      decoded.departmentId !== undefined &&
      !decoded.scope.departmentIds.includes(decoded.departmentId)
    ) {
      return yield* decodeError(
        "decode Schools directory input",
        "department narrowing exceeds the authorized scope",
      );
    }

    const sql = yield* Database;
    const isAll = Predicate.isTagged(decoded.scope, "All");

    const departmentIds = Predicate.isTagged(decoded.scope, "DepartmentIds")
      ? decoded.scope.departmentIds
      : undefined;

    const includeUnassigned = isAll && decoded.departmentId === undefined;

    const visibilityPredicate =
      decoded.departmentId !== undefined
        ? sql`visible_association.department_id = ${decoded.departmentId}`
        : departmentIds === undefined
          ? sql`TRUE`
          : sql.in("visible_association.department_id", departmentIds);

    const directoryPredicate =
      decoded.departmentId !== undefined
        ? sql`directory_association.department_id = ${decoded.departmentId}`
        : departmentIds === undefined
          ? sql`TRUE`
          : sql.in("directory_association.department_id", departmentIds);

    const selected = yield* sql<DirectoryRow>`
      SELECT
        school.school_id::text AS "schoolId",
        school.name AS "name",
        school.contact_person AS "contactPerson",
        school.email AS "email",
        school.phone AS "phone",
        school.language AS "language",
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'departmentId', department.department_id,
                'name', department.name
              )
              ORDER BY department.department_id COLLATE "C" ASC
            )
            FROM public.schools_directory_departments AS directory_association
            INNER JOIN organization_departments AS department
              ON department.department_id = directory_association.department_id
            WHERE directory_association.school_id = school.school_id
              AND ${directoryPredicate}
          ),
          '[]'::jsonb
        ) AS "departments",
        school.active AS "isActive"
      FROM public.schools_directory_schools AS school
      WHERE (
          ${includeUnassigned}
          OR EXISTS (
            SELECT 1
            FROM public.schools_directory_departments AS visible_association
            WHERE visible_association.school_id = school.school_id
              AND ${visibilityPredicate}
          )
        )
      ORDER BY school.name COLLATE "C" ASC, school.school_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read Schools directory", cause)),
      ),
    );

    const entries = yield* decodeRows(selected);

    const directory = {
      activeSchools: entries.filter((school) => school.isActive),
      inactiveSchools: entries.filter((school) => !school.isActive),
    };

    return yield* Schema.decodeUnknownEffect(SchoolDirectorySchema)(directory, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode Schools directory", cause)));
  });
