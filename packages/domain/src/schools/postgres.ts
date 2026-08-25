import { Effect, Schema } from "effect";
import { Database } from "../database/service.js";
import {
  SchoolsCursorInvalid,
  SchoolsDecodeError,
  SchoolsPersistenceError,
  type SchoolsFailure,
} from "./errors.js";
import {
  SchoolDirectoryCursor,
  SchoolDirectoryDepartmentsSchema,
  SchoolDirectoryListInputSchema,
  SchoolDirectoryPageSchema,
  SchoolId,
  type SchoolDirectoryEntry,
  type SchoolDirectoryListInput,
  type SchoolDirectoryPage,
} from "./schema.js";

const CursorPayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  schoolId: SchoolId,
});
type CursorPayload = typeof CursorPayloadSchema.Type;

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

const encodeCursor = (payload: Omit<CursorPayload, "version">): SchoolDirectoryCursor =>
  SchoolDirectoryCursor.make(
    Buffer.from(JSON.stringify({ version: 1, ...payload }), "utf8").toString("base64url"),
  );

const decodeCursor = (
  cursor: SchoolDirectoryCursor,
): Effect.Effect<CursorPayload, SchoolsCursorInvalid> =>
  Effect.gen(function* () {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== cursor) {
      return yield* new SchoolsCursorInvalid({ message: "malformed Schools directory cursor" });
    }
    const source = bytes.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      return yield* new SchoolsCursorInvalid({ message: "malformed Schools directory cursor" });
    }
    const payload = yield* Schema.decodeUnknownEffect(CursorPayloadSchema)(parsed, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () => new SchoolsCursorInvalid({ message: "malformed Schools directory cursor" }),
      ),
    );
    if (JSON.stringify(payload) !== source) {
      return yield* new SchoolsCursorInvalid({ message: "non-canonical Schools directory cursor" });
    }
    return payload;
  });

const decodeRows = (
  selected: unknown,
): Effect.Effect<ReadonlyArray<SchoolDirectoryEntry>, SchoolsDecodeError> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(DirectoryRowSchema))(selected, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode Schools directory rows", cause)));
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
  });

/**
 * Reads one deterministic keyset page. The visibility EXISTS and aggregation
 * use the same scope, so a school is emitted once and carries only the
 * department intersection the caller may observe.
 */
export const listSchoolDirectoryPostgres = (
  input: SchoolDirectoryListInput,
): Effect.Effect<SchoolDirectoryPage, SchoolsFailure, Database> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SchoolDirectoryListInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode Schools directory input", cause)));
    if (
      decoded.scope._tag === "DepartmentIds" &&
      decoded.departmentId !== undefined &&
      !decoded.scope.departmentIds.includes(decoded.departmentId)
    ) {
      return yield* decodeError(
        "decode Schools directory input",
        "department narrowing exceeds the authorized scope",
      );
    }
    const cursor = decoded.cursor === undefined ? undefined : yield* decodeCursor(decoded.cursor);
    const sql = yield* Database;
    const isAll = decoded.scope._tag === "All";
    const departmentIds =
      decoded.scope._tag === "DepartmentIds" ? decoded.scope.departmentIds : undefined;
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
    const cursorName = cursor?.name ?? null;
    const cursorSchoolId = cursor?.schoolId ?? null;
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
            FROM schools_directory_departments AS directory_association
            INNER JOIN organization_departments AS department
              ON department.department_id = directory_association.department_id
            WHERE directory_association.school_id = school.school_id
              AND ${directoryPredicate}
          ),
          '[]'::jsonb
        ) AS "departments",
        school.active AS "isActive"
      FROM schools_directory_schools AS school
      WHERE (
          ${includeUnassigned}
          OR EXISTS (
            SELECT 1
            FROM schools_directory_departments AS visible_association
            WHERE visible_association.school_id = school.school_id
              AND ${visibilityPredicate}
          )
        )
        AND (
          ${cursor === undefined}
          OR (school.name COLLATE "C", school.school_id) >
            (${cursorName} COLLATE "C", ${cursorSchoolId}::bigint)
        )
      ORDER BY school.name COLLATE "C" ASC, school.school_id ASC
      LIMIT ${decoded.limit + 1}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read Schools directory page", cause)),
      ),
    );
    const decodedEntries = yield* decodeRows(selected);
    const hasNextPage = decodedEntries.length > decoded.limit;
    const emitted = hasNextPage ? decodedEntries.slice(0, decoded.limit) : decodedEntries;
    const last = emitted.at(-1);
    const page = {
      activeSchools: emitted.filter((school) => school.isActive),
      inactiveSchools: emitted.filter((school) => !school.isActive),
      nextCursor:
        hasNextPage && last !== undefined
          ? encodeCursor({ name: last.name, schoolId: last.schoolId })
          : null,
    };
    return yield* Schema.decodeUnknownEffect(SchoolDirectoryPageSchema)(page, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode Schools directory page", cause)));
  });
