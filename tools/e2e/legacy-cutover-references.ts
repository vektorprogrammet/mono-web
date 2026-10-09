/**
 * EX-0028: required public native APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
import { schemaBookkeepingTables } from "@vektorprogrammet/database/schema-bookkeeping";
import type { SqlClient, SqlError } from "effect/sql";
import { withTypedTransactionFailures } from "@vektorprogrammet/database";
import type { LegacySourceSnapshot } from "./legacy-source-snapshot";
import { Effect, Schema, flow } from "effect";

const digest = flow(canonicalJsonBytes, sha256Hex);

const positiveId = (value: number | string): string => {
  const id = String(value);

  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error("Source reference ID is not safe");

  return id;
};

const flag = (value: number | string | boolean): boolean => {
  if (value === true || value === 1 || value === "1") return true;

  if (value === false || value === 0 || value === "0") return false;
  throw new Error("Source reference flag is invalid");
};

const unique = (keys: ReadonlyArray<string>): void => {
  if (keys.length !== new Set(keys).size) throw new Error("Source reference keys are ambiguous");
};

const sortBy = <T>(rows: ReadonlyArray<T>, key: (row: T) => string): T[] =>
  [...rows].sort((left, right) => {
    const a = key(left),
      b = key(right);

    return a < b ? -1 : a > b ? 1 : 0;
  });

export const departmentId = (id: number | string): string => `legacy-department:${positiveId(id)}`;

export const semesterId = (id: number | string): string => `legacy-semester:${positiveId(id)}`;

export const schoolId = (id: number | string): number => Number(positiveId(id));

export const buildLegacyReferences = (source: LegacySourceSnapshot) => {
  const departments = sortBy(
    source.departments.map((row) => ({
      department_id: departmentId(row.id),
      name: row.name,
      short_name: row.shortName,
      email: row.email,
      address: row.address,
      city: row.city,
      latitude: row.latitude,
      longitude: row.longitude,
      slack_channel: row.slackChannel,
      logo_path: row.logoPath,
      active: flag(row.active),
      revision: 0,
    })),
    (row) => row.department_id,
  );

  const semesters = sortBy(
    source.semesters.map((row) => {
      if (!/^[0-9]{4}$/.test(row.year) || !["Vår", "Høst"].includes(row.semesterTime))
        throw new Error("Source semester is not recognized");

      const year = Number(row.year);

      const spring = row.semesterTime === "Vår";

      return {
        semester_id: semesterId(row.id),
        start_at: new Date(Date.UTC(year, spring ? 0 : 7, 1)).toISOString(),
        end_at: new Date(Date.UTC(year, spring ? 6 : 11, 31, 23, 59, 59)).toISOString(),
      };
    }),
    (row) => row.semester_id,
  );

  const schools = sortBy(
    source.schools.map((row) => ({
      school_id: String(schoolId(row.id)),
      name: row.name,
      contact_person: row.contactPerson,
      email: row.email,
      phone: row.phone,
      language: flag(row.international) ? "International" : "Norwegian",
      active: flag(row.active),
      revision: 0,
    })),
    (row) => row.school_id,
  );

  const relationships = source.relationships
    .map((row) => ({
      school_id: String(schoolId(row.schoolId)),
      department_id: departmentId(row.departmentId),
      revision: 0,
    }))
    .sort((a, b) => {
      const byDepartment =
        a.department_id < b.department_id ? -1 : a.department_id > b.department_id ? 1 : 0;

      return byDepartment || (a.school_id < b.school_id ? -1 : a.school_id > b.school_id ? 1 : 0);
    });

  unique(departments.map((row) => row.department_id));
  unique(semesters.map((row) => row.semester_id));
  unique(schools.map((row) => row.school_id));
  unique(relationships.map((row) => `${row.department_id}:${row.school_id}`));

  if (departments.length === 0 || semesters.length === 0 || schools.length === 0)
    throw new Error("Source references are empty");

  const departmentIds = new Set(departments.map((row) => row.department_id));

  const schoolIds = new Set(schools.map((row) => row.school_id));

  if (
    relationships.some(
      (row) => !departmentIds.has(row.department_id) || !schoolIds.has(row.school_id),
    )
  )
    throw new Error("Source relationship has an unknown reference");

  const mappings = {
    departments: source.departments.map((row) => ({
      sourceDepartmentId: departmentId(row.id),
      departmentId: departmentId(row.id),
    })),
    semesters: source.semesters.map((row) => ({
      sourceSemesterId: semesterId(row.id),
      semesterId: semesterId(row.id),
    })),
    schools: source.schools.map((row) => ({
      sourceSchoolId: `legacy-school:${positiveId(row.id)}`,
      schoolId: schoolId(row.id),
    })),
    relationships: source.relationships.map((row) => ({
      sourceDepartmentId: departmentId(row.departmentId),
      sourceSchoolId: `legacy-school:${positiveId(row.schoolId)}`,
      departmentId: departmentId(row.departmentId),
      schoolId: schoolId(row.schoolId),
    })),
  };

  return {
    rows: {
      departments,
      admissionDepartments: departments.map(({ department_id }) => ({ department_id })),
      semesters,
      schools,
      relationships,
    },
    mappings,
    referenceDigest: digest({
      departments: source.departments,
      semesters: source.semesters,
      schools: source.schools,
      relationships: source.relationships,
    }),
  };
};

interface DepartmentReference {
  readonly department_id: string;
  readonly name: string;
  readonly short_name: string;
  readonly email: string;
  readonly address: string | null;
  readonly city: string;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly slack_channel: string | null;
  readonly logo_path: string | null;
  readonly active: boolean;
  readonly revision: number;
}

interface SemesterReference {
  readonly semester_id: string;
  readonly start_at: string;
  readonly end_at: string;
}

interface SchoolReference {
  readonly school_id: string;
  readonly name: string;
  readonly contact_person: string;
  readonly email: string;
  readonly phone: string;
  readonly language: string;
  readonly active: boolean;
  readonly revision: number;
}

interface RelationshipReference {
  readonly school_id: string;
  readonly department_id: string;
  readonly revision: number;
}

interface ReferenceRows {
  readonly departments: ReadonlyArray<DepartmentReference>;
  readonly admissionDepartments: ReadonlyArray<{ readonly department_id: string }>;
  readonly semesters: ReadonlyArray<SemesterReference>;
  readonly schools: ReadonlyArray<SchoolReference>;
  readonly relationships: ReadonlyArray<RelationshipReference>;
}

export interface LegacyReferences {
  readonly rows: ReferenceRows;
  readonly mappings: {
    readonly departments: ReadonlyArray<{
      readonly sourceDepartmentId: string;
      readonly departmentId: string;
    }>;
    readonly semesters: ReadonlyArray<{
      readonly sourceSemesterId: string;
      readonly semesterId: string;
    }>;
    readonly schools: ReadonlyArray<{ readonly sourceSchoolId: string; readonly schoolId: number }>;
    readonly relationships: ReadonlyArray<{
      readonly sourceDepartmentId: string;
      readonly sourceSchoolId: string;
      readonly departmentId: string;
      readonly schoolId: number;
    }>;
  };
  readonly referenceDigest: string;
}

const DepartmentReferenceRow = Schema.Struct({
  department_id: Schema.String,
  name: Schema.String,
  short_name: Schema.String,
  email: Schema.String,
  address: Schema.NullOr(Schema.String),
  city: Schema.String,
  latitude: Schema.NullOr(Schema.String),
  longitude: Schema.NullOr(Schema.String),
  slack_channel: Schema.NullOr(Schema.String),
  logo_path: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  revision: Schema.Int,
});

const SemesterReferenceRow = Schema.Struct({
  semester_id: Schema.String,
  start_at: Schema.String,
  end_at: Schema.String,
});

const SchoolReferenceRow = Schema.Struct({
  school_id: Schema.String,
  name: Schema.String,
  contact_person: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  language: Schema.String,
  active: Schema.Boolean,
  revision: Schema.Int,
});

const RelationshipReferenceRow = Schema.Struct({
  school_id: Schema.String,
  department_id: Schema.String,
  revision: Schema.Int,
});

const decodeDepartments = Schema.decodeUnknownEffect(Schema.Array(DepartmentReferenceRow));

const decodeAdmissionDepartments = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ department_id: Schema.String })),
);

const decodeSemesters = Schema.decodeUnknownEffect(Schema.Array(SemesterReferenceRow));

const decodeSchools = Schema.decodeUnknownEffect(Schema.Array(SchoolReferenceRow));

const decodeRelationships = Schema.decodeUnknownEffect(Schema.Array(RelationshipReferenceRow));

const decodeMarker = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ exists: Schema.Boolean })),
);

const decodePrior = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      source_revision: Schema.String,
      reference_digest: Schema.String,
      source_id_mappings: Schema.Json,
    }),
  ),
);

const decodeTables = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ schemaname: Schema.String, tablename: Schema.String })),
);

const decodeOccupied = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ occupied: Schema.Boolean })),
);

export class LegacyReferenceSeedFailure extends Schema.TaggedError<LegacyReferenceSeedFailure>()(
  "LegacyReferenceSeedFailure",
  {
    reason: Schema.Literals([
      "UnmigratedTarget",
      "SourceIdentityConflict",
      "UnexpectedSchema",
      "OccupiedTarget",
      "InvalidSchoolId",
      "TargetMismatch",
      "PersistenceFailure",
    ]),
  },
) {
  override get message() {
    return "Native reference seeding rejected; details redacted";
  }
}

const targetRows = Effect.fnUntraced(function* (
  tx: SqlClient.SqlClient,
): Effect.fn.Return<ReferenceRows, SqlError.SqlError | Schema.SchemaError> {
  const departments = yield* tx
    .unsafe(
      `SELECT department_id,name,short_name,email,address,city,latitude::text,longitude::text,slack_channel,logo_path,active,revision FROM public.organization_departments ORDER BY department_id`,
    )
    .pipe(Effect.flatMap(decodeDepartments));

  const admissionDepartments = yield* tx
    .unsafe("SELECT department_id FROM public.admission_period_departments ORDER BY department_id")
    .pipe(Effect.flatMap(decodeAdmissionDepartments));

  const semesters = yield* tx
    .unsafe(
      `SELECT semester_id, to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at, to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS end_at FROM public.admission_period_semesters ORDER BY semester_id`,
    )
    .pipe(Effect.flatMap(decodeSemesters));

  const schools = yield* tx
    .unsafe(
      `SELECT school_id::text AS school_id,name,contact_person,email,phone,language,active,revision FROM public.schools_directory_schools ORDER BY school_id::text`,
    )
    .pipe(Effect.flatMap(decodeSchools));

  const relationships = yield* tx
    .unsafe(
      `SELECT school_id::text AS school_id,department_id,revision FROM public.schools_directory_departments ORDER BY department_id,school_id::text`,
    )
    .pipe(Effect.flatMap(decodeRelationships));

  return { departments, admissionDepartments, semesters, schools, relationships };
});

const seedRows = Effect.fnUntraced(function* (tx: SqlClient.SqlClient, rows: ReferenceRows) {
  for (const row of rows.departments)
    yield* tx.unsafe(
      `INSERT INTO public.organization_departments (department_id,name,short_name,email,address,city,latitude,longitude,slack_channel,logo_path,active,revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.department_id,
        row.name,
        row.short_name,
        row.email,
        row.address,
        row.city,
        row.latitude,
        row.longitude,
        row.slack_channel,
        row.logo_path,
        row.active,
        row.revision,
      ],
    );

  for (const row of rows.admissionDepartments)
    yield* tx.unsafe(
      "INSERT INTO public.admission_period_departments (department_id) VALUES ($1)",
      [row.department_id],
    );

  for (const row of rows.semesters)
    yield* tx.unsafe(
      "INSERT INTO public.admission_period_semesters (semester_id,start_at,end_at) VALUES ($1,$2,$3)",
      [row.semester_id, row.start_at, row.end_at],
    );

  for (const row of rows.schools)
    yield* tx.unsafe(
      `INSERT INTO public.schools_directory_schools (school_id,name,contact_person,email,phone,language,active,revision) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.school_id,
        row.name,
        row.contact_person,
        row.email,
        row.phone,
        row.language,
        row.active,
        row.revision,
      ],
    );

  for (const row of rows.relationships)
    yield* tx.unsafe(
      "INSERT INTO public.schools_directory_departments (school_id,department_id,revision) VALUES ($1,$2,$3)",
      [row.school_id, row.department_id, row.revision],
    );
  // RESTART, unlike setval, rolls back with the reference rows and provenance.

  const nextSchoolId = Math.max(...rows.schools.map((school) => Number(school.school_id))) + 1;

  if (!Number.isSafeInteger(nextSchoolId))
    return yield* new LegacyReferenceSeedFailure({ reason: "InvalidSchoolId" });

  yield* tx.unsafe(
    `ALTER TABLE public.schools_directory_schools ALTER COLUMN school_id RESTART WITH ${nextSchoolId}`,
  );
});

/** Commits source references and their ledger atomically; replay checks every target value and source identity.
 * A parent transaction uses this same native client and a savepoint, never a separately reserved connection.
 * No application fact is created on an occupied or divergent target; success means committed at the outermost boundary.
 */

export const seedLegacyReferences = Effect.fn("seedLegacyReferences")(function* (
  sql: SqlClient.SqlClient,
  identity: {
    readonly sourceRepository: string;
    readonly sourceRevision: string;
    readonly snapshotId: string;
  },
  references: LegacyReferences,
): Effect.fn.Return<"Seeded" | "ExactReplay", LegacyReferenceSeedFailure> {
  return yield* withTypedTransactionFailures(sql.withTransaction)(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended('legacy-cutover-reference-seed',0))",
      );

      const marker = yield* sql
        .unsafe(
          "SELECT to_regclass('public.vektorprogrammet_schema_migrations') IS NOT NULL AND to_regclass('public.historical_service_reference_provenance') IS NOT NULL AS exists",
        )
        .pipe(Effect.flatMap(decodeMarker));

      if (!marker[0]?.exists)
        return yield* new LegacyReferenceSeedFailure({ reason: "UnmigratedTarget" });

      const migrations = yield* sql.unsafe(
        "SELECT 1 FROM public.vektorprogrammet_schema_migrations LIMIT 1",
      );

      if (migrations.length === 0)
        return yield* new LegacyReferenceSeedFailure({ reason: "UnmigratedTarget" });

      const priorRows = yield* sql
        .unsafe(
          "SELECT source_revision, reference_digest, source_id_mappings FROM public.historical_service_reference_provenance WHERE source_repository=$1 AND snapshot_id=$2",
          [identity.sourceRepository, identity.snapshotId],
        )
        .pipe(Effect.flatMap(decodePrior));

      const prior = priorRows[0];
      let outcome: "Seeded" | "ExactReplay";

      if (prior) {
        if (
          prior.source_revision !== identity.sourceRevision ||
          prior.reference_digest !== references.referenceDigest ||
          canonicalJson(prior.source_id_mappings) !== canonicalJson(references.mappings)
        )
          return yield* new LegacyReferenceSeedFailure({ reason: "SourceIdentityConflict" });
        outcome = "ExactReplay";
      } else {
        const extraSchemas = yield* sql.unsafe(
          "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public', 'auth', 'information_schema') AND left(nspname,3) <> 'pg_' LIMIT 1",
        );

        if (extraSchemas.length !== 0)
          return yield* new LegacyReferenceSeedFailure({ reason: "UnexpectedSchema" });

        const tables =
          yield* sql`SELECT schemaname,tablename FROM pg_catalog.pg_tables WHERE schemaname IN ('public','auth') AND ${sql.and(schemaBookkeepingTables.map(({ schema, table }) => sql`NOT (schemaname=${schema} AND tablename=${table})`))} ORDER BY schemaname,tablename`.pipe(
            Effect.flatMap(decodeTables),
          );

        for (const { schemaname, tablename } of tables) {
          const occupied =
            yield* sql`SELECT EXISTS(SELECT 1 FROM ${sql(schemaname)}.${sql(tablename)}) AS occupied`.pipe(
              Effect.flatMap(decodeOccupied),
            );

          if (occupied[0]?.occupied)
            return yield* new LegacyReferenceSeedFailure({ reason: "OccupiedTarget" });
        }

        yield* seedRows(sql, references.rows);

        yield* sql.unsafe(
          "INSERT INTO public.historical_service_reference_provenance (source_repository,snapshot_id,source_revision,reference_digest,source_id_mappings) VALUES ($1,$2,$3,$4,$5::jsonb)",
          [
            identity.sourceRepository,
            identity.snapshotId,
            identity.sourceRevision,
            references.referenceDigest,
            canonicalJson(references.mappings),
          ],
        );
        outcome = "Seeded";
      }

      if (canonicalJson(yield* targetRows(sql)) !== canonicalJson(references.rows))
        return yield* new LegacyReferenceSeedFailure({ reason: "TargetMismatch" });

      return outcome;
    }),
  ).pipe(
    Effect.catchTag(["SqlError", "SchemaError"], () =>
      Effect.fail(new LegacyReferenceSeedFailure({ reason: "PersistenceFailure" })),
    ),
  );
});
