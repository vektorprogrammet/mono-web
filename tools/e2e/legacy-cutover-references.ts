import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import type { Pool, PoolClient } from "pg";
import type { LegacySourceSnapshot } from "./legacy-source-snapshot";
import { flow } from "effect";

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

const targetRows = async (tx: PoolClient): Promise<ReferenceRows> => {
  const departments = (
    await tx.query<ReferenceRows["departments"][number]>(
      `SELECT department_id, name, short_name, email, address, city, latitude, longitude,
            slack_channel, logo_path, active, revision
       FROM public.organization_departments ORDER BY department_id`,
    )
  ).rows;

  const admissionDepartments = (
    await tx.query<ReferenceRows["admissionDepartments"][number]>(
      "SELECT department_id FROM public.admission_period_departments ORDER BY department_id",
    )
  ).rows;

  const semesters = (
    await tx.query<{ semester_id: string; start_at: Date; end_at: Date }>(
      "SELECT semester_id, start_at, end_at FROM public.admission_period_semesters ORDER BY semester_id",
    )
  ).rows.map(({ semester_id, start_at, end_at }) => ({
    semester_id,
    start_at: start_at.toISOString(),
    end_at: end_at.toISOString(),
  }));

  const schools = (
    await tx.query<ReferenceRows["schools"][number]>(
      `SELECT school_id::text AS school_id, name, contact_person, email, phone, language, active, revision
       FROM public.schools_directory_schools ORDER BY school_id::text`,
    )
  ).rows;

  const relationships = (
    await tx.query<ReferenceRows["relationships"][number]>(
      `SELECT school_id::text AS school_id, department_id, revision
       FROM public.schools_directory_departments ORDER BY department_id, school_id::text`,
    )
  ).rows;

  return { departments, admissionDepartments, semesters, schools, relationships };
};

const seedRows = async (tx: PoolClient, rows: ReferenceRows): Promise<void> => {
  for (const row of rows.departments)
    await tx.query(
      `INSERT INTO public.organization_departments
       (department_id,name,short_name,email,address,city,latitude,longitude,
        slack_channel,logo_path,active,revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      Object.values(row),
    );

  for (const row of rows.admissionDepartments)
    await tx.query("INSERT INTO public.admission_period_departments (department_id) VALUES ($1)", [
      row.department_id,
    ]);

  for (const row of rows.semesters)
    await tx.query(
      "INSERT INTO public.admission_period_semesters (semester_id,start_at,end_at) VALUES ($1,$2,$3)",
      [row.semester_id, row.start_at, row.end_at],
    );

  for (const row of rows.schools)
    await tx.query(
      `INSERT INTO public.schools_directory_schools
       (school_id,name,contact_person,email,phone,language,active,revision)
       OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      Object.values(row),
    );

  for (const row of rows.relationships)
    await tx.query(
      `INSERT INTO public.schools_directory_departments (school_id,department_id,revision)
     VALUES ($1,$2,$3)`,
      [row.school_id, row.department_id, row.revision],
    );
  // Identity restart is transactional, unlike setval, so failed provenance writes leave no residue.
  const nextSchoolId = Math.max(...rows.schools.map((school) => Number(school.school_id))) + 1;

  if (!Number.isSafeInteger(nextSchoolId))
    throw new Error("Source school IDs exhaust target ID range");
  await tx.query(
    `ALTER TABLE public.schools_directory_schools ALTER COLUMN school_id RESTART WITH ${nextSchoolId}`,
  );
};

/** Never modifies existing references; replay verifies every target value and the source-ID ledger. */
export const seedLegacyReferences = async (
  pool: Pool,
  identity: {
    readonly sourceRepository: string;
    readonly sourceRevision: string;
    readonly snapshotId: string;
  },
  references: LegacyReferences,
  client?: PoolClient,
): Promise<"Seeded" | "ExactReplay"> => {
  const tx = client ?? (await pool.connect());

  try {
    if (!client) await tx.query("BEGIN");
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('legacy-cutover-reference-seed',0))",
    );

    const marker = (
      await tx.query<{ exists: boolean }>(
        `SELECT to_regclass('public.vektorprogrammet_schema_migrations') IS NOT NULL
              AND to_regclass('public.historical_service_reference_provenance') IS NOT NULL AS exists`,
      )
    ).rows[0]?.exists;

    if (!marker) throw new Error("Native target schema is not migrated for cutover");

    const migrations = await tx.query(
      "SELECT 1 FROM public.vektorprogrammet_schema_migrations LIMIT 1",
    );

    if (!migrations.rowCount) throw new Error("Native target has no migration marker");

    const prior = (
      await tx.query<{
        source_revision: string;
        reference_digest: string;
        source_id_mappings: unknown;
      }>(
        `SELECT source_revision, reference_digest, source_id_mappings
          FROM public.historical_service_reference_provenance
         WHERE source_repository=$1 AND snapshot_id=$2`,
        [identity.sourceRepository, identity.snapshotId],
      )
    ).rows[0];

    let outcome: "Seeded" | "ExactReplay";

    if (prior) {
      if (
        prior.source_revision !== identity.sourceRevision ||
        prior.reference_digest !== references.referenceDigest ||
        canonicalJson(prior.source_id_mappings) !== canonicalJson(references.mappings)
      )
        throw new Error("Reference source identity differs from prior import");
      outcome = "ExactReplay";
    } else {
      const extraSchemas = await tx.query(`
        SELECT 1 FROM pg_catalog.pg_namespace
         WHERE nspname NOT IN ('public', 'auth', 'information_schema')
           AND left(nspname, 3) <> 'pg_'
         LIMIT 1
      `);

      if (extraSchemas.rowCount)
        throw new Error("Native target contains an unexpected application schema");

      const tables = await tx.query<{ schemaname: string; tablename: string }>(`
        SELECT schemaname, tablename FROM pg_catalog.pg_tables
         WHERE schemaname IN ('public', 'auth')
           AND NOT (schemaname = 'public' AND tablename = 'vektorprogrammet_schema_migrations')
         ORDER BY schemaname, tablename
      `);

      for (const { schemaname, tablename } of tables.rows) {
        const schema = '"' + schemaname.replaceAll('"', '""') + '"';
        const table = '"' + tablename.replaceAll('"', '""') + '"';

        const occupied = await tx.query<{ occupied: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM " + schema + "." + table + ") AS occupied",
        );

        if (occupied.rows[0]?.occupied)
          throw new Error("Native target contains preexisting application state");
      }

      await seedRows(tx, references.rows);
      await tx.query(
        `INSERT INTO public.historical_service_reference_provenance
          (source_repository,snapshot_id,source_revision,reference_digest,source_id_mappings)
          VALUES ($1,$2,$3,$4,$5::jsonb)`,
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

    if (canonicalJson(await targetRows(tx)) !== canonicalJson(references.rows))
      throw new Error("Native reference values differ from source snapshot");

    if (!client) await tx.query("COMMIT");

    return outcome;
  } catch {
    if (!client) await tx.query("ROLLBACK");
    throw new Error("Native reference seeding rejected; details redacted");
  } finally {
    if (!client) tx.release();
  }
};
