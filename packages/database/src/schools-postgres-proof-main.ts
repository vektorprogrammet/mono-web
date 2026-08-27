import assert from "node:assert/strict";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  DepartmentId,
  Organization,
  OrganizationAuthorityInstantSchema,
  OrganizationLive,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import {
  readSchoolsDirectory,
  Schools,
  SchoolsLive,
  SchoolsPersistenceError,
  type SchoolDirectoryListInput,
} from "@vektorprogrammet/domain/schools";
import { Config, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { DatabaseLive } from "./layers.js";
import { databaseSchemaRevision } from "./migrations.js";

const proofCohort = {
  id: "schools-postgres-proof-0061-v1",
  personId: PersonId.make("schools-postgres-proof-admin-0061"),
  grantId: "schools-postgres-proof-grant-0061",
  departmentA: DepartmentId.make("schools-postgres-proof-department-a-0061"),
  departmentB: DepartmentId.make("schools-postgres-proof-department-b-0061"),
  schoolEmail: "schools-postgres-proof-0061@example.invalid",
} as const;

const authorizationInstant = OrganizationAuthorityInstantSchema.make("2032-01-01T00:00:00.000Z");

const assertDisposableDatabaseUrl = (databaseUrl: Redacted.Redacted<string>): void => {
  const parsed = new URL(Redacted.value(databaseUrl));
  assert.ok(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    "DATABASE_URL must use PostgreSQL",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname),
    "Schools proof is restricted to loopback PostgreSQL",
  );
  assert.match(
    decodeURIComponent(parsed.pathname.slice(1)),
    /schools/i,
    "Schools proof requires a database whose name contains 'schools'",
  );
};

const makeProofLayer = (databaseUrl: Redacted.Redacted<string>) => {
  const databaseLayer = DatabaseLive({
    url: Redacted.make(Redacted.value(databaseUrl)),
    applicationName: "schools-postgres-proof-0061",
    maxConnections: 4,
  });
  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
  const schoolsLayer = SchoolsLive.pipe(Layer.provide(databaseLayer));
  return Layer.mergeAll(databaseLayer, organizationLayer, schoolsLayer);
};

const cleanupCohort = (sql: DatabaseShape) =>
  Effect.gen(function* () {
    yield* sql`
      DELETE FROM public.schools_directory_schools AS school
      WHERE school.email = ${proofCohort.schoolEmail}
    `;
    yield* sql`
      DELETE FROM public.organization_global_administrator_grants AS administrator
      WHERE administrator.grant_id = ${proofCohort.grantId}
    `;
    yield* sql`
      DELETE FROM person_profiles AS profile
      WHERE profile.person_id = ${proofCohort.personId}
    `;
    yield* sql`
      DELETE FROM organization_departments AS department
      WHERE department.department_id IN (
        ${proofCohort.departmentA},
        ${proofCohort.departmentB}
      )
    `;
  });

const resetAndSeed = (sql: DatabaseShape) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* cleanupCohort(sql);
      yield* sql`
        INSERT INTO person_profiles (person_id, first_name, last_name, revision)
        VALUES (${proofCohort.personId}, 'Snapshot', 'Administrator', 0)
      `;
      yield* sql`
        INSERT INTO public.organization_global_administrator_grants (
          grant_id,
          person_id,
          start_at,
          end_at,
          revision
        ) VALUES (
          ${proofCohort.grantId},
          ${proofCohort.personId},
          '2031-01-01T00:00:00.000Z',
          NULL,
          0
        )
      `;
      yield* sql`
        INSERT INTO organization_departments (
          department_id,
          name,
          short_name,
          email,
          city,
          active,
          revision
        ) VALUES
          (
            ${proofCohort.departmentA},
            'Snapshot Department A',
            'SDA',
            'snapshot-a@example.invalid',
            'Oslo',
            TRUE,
            0
          ),
          (
            ${proofCohort.departmentB},
            'Snapshot Department B',
            'SDB',
            'snapshot-b@example.invalid',
            'Bergen',
            TRUE,
            0
          )
      `;
      const inserted = yield* sql<{ readonly schoolId: string }>`
        INSERT INTO public.schools_directory_schools (
          name,
          contact_person,
          email,
          phone,
          language,
          active,
          revision
        ) VALUES (
          'Snapshot School',
          'Snapshot Contact',
          ${proofCohort.schoolEmail},
          '+47 900 00 061',
          'Norwegian',
          TRUE,
          0
        )
        RETURNING school_id::text AS "schoolId"
      `;
      const schoolId = inserted[0]?.schoolId;
      assert.ok(schoolId, "proof school insert must return an identifier");
      yield* sql`
        INSERT INTO public.schools_directory_departments (school_id, department_id, revision)
        VALUES (${schoolId}::bigint, ${proofCohort.departmentA}, 0)
      `;
      return schoolId;
    }),
  );

export const program = Effect.scoped(
  Effect.gen(function* () {
    const databaseUrl = yield* Config.redacted("DATABASE_URL");
    assertDisposableDatabaseUrl(databaseUrl);

    const evidence = yield* Effect.gen(function* () {
      const database = yield* Database;
      const organization = yield* Organization;
      const schools = yield* Schools;
      assert.equal(database.schemaRevision, databaseSchemaRevision);
      const schoolId = yield* resetAndSeed(database);

      const requestPaused = yield* Deferred.make<void>();
      const resumeRequest = yield* Deferred.make<void>();
      let intercepted = false;
      let readerConnectionId = -1;
      const pausingSchools = Schools.of({
        listDirectory: (input: SchoolDirectoryListInput) => {
          if (intercepted) return schools.listDirectory(input);
          intercepted = true;
          return Effect.gen(function* () {
            const [connection] = yield* database<{ readonly pid: number }>`
              SELECT pg_backend_pid() AS pid
            `;
            readerConnectionId = connection?.pid ?? -1;
            yield* Deferred.succeed(requestPaused, undefined);
            yield* Deferred.await(resumeRequest);
            return yield* schools.listDirectory(input);
          }).pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(
                new SchoolsPersistenceError({
                  operation: "capture Schools proof reader connection",
                  message: String(cause),
                }),
              ),
            ),
          );
        },
      });

      const firstReadFiber = yield* Effect.forkScoped(
        readSchoolsDirectory(proofCohort.personId, authorizationInstant, {}).pipe(
          Effect.provideService(Organization, organization),
          Effect.provideService(Schools, pausingSchools),
        ),
      );
      yield* Deferred.await(requestPaused);

      const mutationConnection = yield* database.withTransaction(
        Effect.gen(function* () {
          const [connection] = yield* database<{ readonly pid: number }>`
            SELECT pg_backend_pid() AS pid
          `;
          yield* database`
            DELETE FROM public.schools_directory_departments AS association
            WHERE association.school_id = ${schoolId}::bigint
              AND association.department_id = ${proofCohort.departmentA}
          `;
          yield* database`
            INSERT INTO public.schools_directory_departments (school_id, department_id, revision)
            VALUES (${schoolId}::bigint, ${proofCohort.departmentB}, 0)
          `;
          return connection;
        }),
      );
      yield* Deferred.succeed(resumeRequest, undefined);

      const pausedResponse = yield* Fiber.join(firstReadFiber);
      const laterResponse = yield* readSchoolsDirectory(
        proofCohort.personId,
        authorizationInstant,
        {},
      );
      const pausedDepartments =
        pausedResponse.activeSchools[0]?.departments.map((department) => department.departmentId) ??
        [];
      const laterDepartments =
        laterResponse.activeSchools[0]?.departments.map((department) => department.departmentId) ??
        [];

      assert.deepEqual(pausedDepartments, [proofCohort.departmentA]);
      assert.deepEqual(laterDepartments, [proofCohort.departmentB]);
      assert.notEqual(readerConnectionId, -1);
      assert.notEqual(mutationConnection?.pid, readerConnectionId);

      yield* database.withTransaction(cleanupCohort(database));

      return {
        specId: "0061" as const,
        database: "PostgreSQL" as const,
        schemaRevision: database.schemaRevision,
        cohort: proofCohort.id,
        passed: true as const,
        transaction: {
          isolation: "REPEATABLE READ" as const,
          accessMode: "READ ONLY" as const,
          pausedAfterAuthorityProjection: true as const,
        },
        concurrentMutation: {
          readerConnectionId,
          writerConnectionId: mutationConnection?.pid ?? -1,
          independentConnections: mutationConnection?.pid !== readerConnectionId,
          committedDepartmentId: proofCohort.departmentB,
        },
        pausedResponse: {
          schoolCount: pausedResponse.activeSchools.length,
          departments: pausedDepartments,
        },
        laterResponse: {
          schoolCount: laterResponse.activeSchools.length,
          departments: laterDepartments,
        },
      };
    }).pipe(Effect.provide(makeProofLayer(databaseUrl)));

    const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
    yield* Effect.sync(() =>
      process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
    );
  }).pipe(Effect.timeout("30 seconds")),
);
