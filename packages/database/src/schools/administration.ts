import { DateTime, Effect, Predicate, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  School,
  SchoolId,
  SchoolCapacityPlan,
  SchoolCommand,
  SchoolCommandResult,
  ManagedSchool,
  SchoolDirectoryDepartmentSchema,
  SchoolAdministrationHistory,
  SchoolCommandFailure,
  SchoolsPersistenceError,
  schoolManagementDepartments,
  canManageSchoolDepartments,
} from "@vektorprogrammet/domain/schools";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { accountAccessEnabled } from "../identity-access.js";
import { Database, type DatabaseOperations } from "../service.js";
import {
  lockPersonAuthorization,
  resolveOrganizationPersonAuthorityWithSql,
} from "../organization/authority-postgres.js";

const fail = (code: SchoolCommandFailure["code"]) => new SchoolCommandFailure({ code });

const persistence = (cause: unknown) =>
  new SchoolsPersistenceError({
    operation: "school administration",
    message: String(cause),
    cause,
  });

const decodeCommand = Schema.decodeUnknownEffect(SchoolCommand, { onExcessProperty: "error" });

const authorityFor = Effect.fn("Schools.authority")(function* (
  sql: DatabaseOperations,
  personId: PersonId,
  lock: boolean,
) {
  if (lock) yield* lockPersonAuthorization(sql, personId);

  if (!(yield* accountAccessEnabled(sql, personId, lock ? "ForShare" : "None")))
    return yield* fail("Denied");
  const now = DateTime.formatIso(yield* DateTime.now);

  const authority = yield* resolveOrganizationPersonAuthorityWithSql(
    sql,
    personId,
    now,
    lock ? "ForShare" : "None",
  );

  if (
    authority.globalAdministrator !== "Active" &&
    schoolManagementDepartments(authority).length === 0
  )
    return yield* fail("Denied");

  return authority;
});

const schoolRows = (sql: DatabaseOperations, schoolId: SchoolId | null, lock: boolean) =>
  SqlSchema.findAll({
    Request: Schema.NullOr(SchoolId),
    Result: School.json,
    execute: (
      id,
    ) => sql`SELECT school_id::float8 AS "schoolId", name, contact_person AS "contactPerson", email, phone, language, active, revision
    FROM public.schools_directory_schools WHERE ${id === null ? sql`TRUE` : sql`school_id=${id}`} ORDER BY school_id ${lock ? sql`FOR UPDATE` : sql``}`,
  })(schoolId);

const departmentsFor = (sql: DatabaseOperations, schoolId: SchoolId) =>
  SqlSchema.findAll({
    Request: SchoolId,
    Result: Schema.Struct({ departmentId: DepartmentId }),
    execute: (id) =>
      sql`SELECT department_id AS "departmentId" FROM public.schools_directory_departments WHERE school_id=${id} ORDER BY department_id COLLATE "C"`,
  })(schoolId).pipe(Effect.map((rows) => rows.map((row) => row.departmentId)));

const capacityRows = (sql: DatabaseOperations, schoolId: SchoolId) =>
  SqlSchema.findAll({
    Request: SchoolId,
    Result: SchoolCapacityPlan.json,
    execute: (
      id,
    ) => sql`SELECT capacity_id::float8 AS "capacityId", school_id::float8 AS "schoolId", department_id AS "departmentId", semester_id AS "semesterId", monday,tuesday,wednesday,thursday,friday,revision
    FROM public.schools_capacity_plans WHERE school_id=${id} ORDER BY department_id,semester_id`,
  })(schoolId);

const authorizeWithSql = Effect.fn("Schools.authorizeCommand")(function* (
  sql: DatabaseOperations,
  command: SchoolCommand,
  personId: PersonId,
) {
  const authority = yield* authorityFor(sql, personId, true);

  if (Predicate.isTagged(command, "CreateSchool")) {
    if (!canManageSchoolDepartments(authority, command.departmentIds)) return yield* fail("Denied");

    return { authority, school: null, departments: command.departmentIds };
  }

  if (Predicate.isTagged(command, "ReplaceSchoolDepartments")) {
    const observed = yield* departmentsFor(sql, command.schoolId);
    const affected = [...new Set([...observed, ...command.departmentIds])];
    yield* sql`SELECT department_id FROM organization_departments WHERE ${sql.in("department_id", affected)} ORDER BY department_id FOR SHARE`;
  }

  if (
    Predicate.isTagged(command, "CreateCapacity") ||
    Predicate.isTagged(command, "ReviseCapacity")
  )
    yield* sql`SELECT department_id FROM organization_departments WHERE department_id=${command.departmentId} FOR SHARE`;
  const school = (yield* schoolRows(sql, command.schoolId, true))[0];

  if (!school) return yield* fail("NotFound");
  const departments = yield* departmentsFor(sql, school.schoolId);

  if (
    Predicate.isTagged(command, "CreateCapacity") ||
    Predicate.isTagged(command, "ReviseCapacity")
  ) {
    if (!canManageSchoolDepartments(authority, [command.departmentId]))
      return yield* fail("Denied");

    if (!departments.includes(command.departmentId)) return yield* fail("InvalidReference");
  } else {
    // An empty existing association set requires global authority even when adding a new scope.
    if (!canManageSchoolDepartments(authority, departments)) return yield* fail("Denied");

    if (
      Predicate.isTagged(command, "ReplaceSchoolDepartments") &&
      !canManageSchoolDepartments(authority, command.departmentIds)
    )
      return yield* fail("Denied");
  }

  return { authority, school, departments };
});

const mapFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: persistence,
      SchemaError: persistence,
      OrganizationPersistenceError: persistence,
      OrganizationDecodeError: persistence,
    }),
  );

export const authorizeSchoolCommand = (command: SchoolCommand, personId: PersonId) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const decoded = yield* decodeCommand(command).pipe(Effect.mapError(() => fail("Invalid")));
    yield* authorizeWithSql(sql, decoded, personId);
  }).pipe(mapFailure);

export const readSchoolManagement = (personId: PersonId) =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        const authority = yield* authorityFor(sql, personId, false);
        const all = authority.globalAdministrator === "Active";
        const scope = schoolManagementDepartments(authority);

        const departments = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: SchoolDirectoryDepartmentSchema,
          execute: () =>
            sql`SELECT department_id AS "departmentId", name FROM organization_departments WHERE ${all ? sql`TRUE` : sql.in("department_id", scope)} ORDER BY name,department_id`,
        })(undefined);

        const semesters = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Schema.Struct({
            semesterId: SchoolCapacityPlan.fields.semesterId,
            name: Schema.String,
          }),
          execute: () =>
            sql`SELECT semester_id AS "semesterId", semester_id AS name FROM admission_period_semesters ORDER BY start_at DESC,semester_id`,
        })(undefined);

        const schools = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: ManagedSchool,
          execute:
            () => sql`SELECT jsonb_build_object('schoolId',s.school_id,'name',s.name,'contactPerson',s.contact_person,'email',s.email,'phone',s.phone,'language',s.language,'active',s.active,'revision',s.revision) AS school,
        visible.ids AS "departmentIds", visible.ids AS "capacityDepartmentIds",
        (${all} OR (EXISTS(SELECT 1 FROM schools_directory_departments d WHERE d.school_id=s.school_id) AND NOT EXISTS(SELECT 1 FROM schools_directory_departments d WHERE d.school_id=s.school_id AND NOT (${sql.in("d.department_id", scope)})))) AS "canEditShared",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('capacityId',p.capacity_id,'schoolId',p.school_id,'departmentId',p.department_id,'semesterId',p.semester_id,'monday',p.monday,'tuesday',p.tuesday,'wednesday',p.wednesday,'thursday',p.thursday,'friday',p.friday,'revision',p.revision) ORDER BY p.department_id,p.semester_id)
          FROM schools_capacity_plans p WHERE p.school_id=s.school_id AND ${all ? sql`TRUE` : sql.in("p.department_id", scope)}),'[]'::jsonb) AS capacities
        FROM schools_directory_schools s CROSS JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(d.department_id ORDER BY d.department_id COLLATE "C"),'[]'::jsonb) AS ids FROM schools_directory_departments d WHERE d.school_id=s.school_id AND ${all ? sql`TRUE` : sql.in("d.department_id", scope)}
        ) visible WHERE ${all} OR jsonb_array_length(visible.ids)>0 ORDER BY s.name COLLATE "C",s.school_id`,
        })(undefined);

        const history = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: SchoolAdministrationHistory,
          execute:
            () => sql`SELECT a.command_id AS "commandId", a.school_id::float8 AS "schoolId", a.capacity_id::float8 AS "capacityId", a.department_id AS "departmentId", a.actor_person_id AS "actorPersonId", a.action,a.reason,a.revision,
        to_char(a.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
        FROM schools_administration_audit a WHERE ${
          all
            ? sql`TRUE`
            : sql`a.scope_department_ids <@ ${scope}::text[] AND cardinality(a.scope_department_ids)>0 AND
          (a.department_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM schools_directory_departments d WHERE d.school_id=a.school_id AND NOT (${sql.in("d.department_id", scope)})))`
        }
        ORDER BY a.recorded_at DESC,a.command_id`,
        })(undefined);

        return { departments, semesters, schools, history };
      }),
    );
  }).pipe(mapFailure);

export const executeSchoolCommand = (input: SchoolCommand, personId: PersonId) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const command = yield* decodeCommand(input).pipe(Effect.mapError(() => fail("Invalid")));

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const authorized = yield* authorizeWithSql(sql, command, personId);
        yield* lockAdvisory(sql, AdvisoryLockKey.schoolsCommand(personId, command.commandId));

        const digest = sha256Hex(
          canonicalJsonBytes({ schema: "SchoolCommand/v1", personId, command }),
        );

        const receipts = yield* sql<{
          digest: string;
          result: unknown;
        }>`SELECT command_digest AS digest,result_json AS result FROM schools_command_receipts WHERE actor_person_id=${personId} AND command_id=${command.commandId}`;

        if (receipts[0]) {
          if (receipts[0].digest !== digest) return yield* fail("Conflict");

          return yield* Schema.decodeUnknownEffect(SchoolCommandResult)(receipts[0].result);
        }

        let schoolId: SchoolId;
        let capacityId: typeof SchoolCapacityPlan.Type.capacityId | null = null;
        let revision: number;
        let departmentId: DepartmentId | null = null;
        let scopeDepartments = [...authorized.departments];

        let before: Schema.Json =
          authorized.school === null
            ? null
            : { school: authorized.school, departmentIds: authorized.departments };

        let after: Schema.Json;

        if (
          Predicate.isTagged(command, "CreateSchool") ||
          Predicate.isTagged(command, "ReplaceSchoolDepartments")
        ) {
          const references = yield* sql<{
            id: string;
          }>`SELECT department_id AS id FROM organization_departments WHERE ${sql.in("department_id", command.departmentIds)} FOR SHARE`;

          if (references.length !== command.departmentIds.length)
            return yield* fail("InvalidReference");
        }

        if (Predicate.isTagged(command, "CreateSchool")) {
          const rows = yield* sql<{
            schoolId: number;
          }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active)
        VALUES(${command.name},${command.contactPerson},${command.email},${command.phone},${command.language},${command.active}) RETURNING school_id::float8 AS "schoolId"`;

          schoolId = yield* Schema.decodeUnknownEffect(SchoolId)(rows[0]?.schoolId);
          revision = 0;

          for (const id of command.departmentIds)
            yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${id})`;
          after = {
            school: (yield* schoolRows(sql, schoolId, false))[0]!,
            departmentIds: command.departmentIds,
          };
        } else {
          schoolId = command.schoolId;
          const school = authorized.school!;

          if (
            Predicate.isTagged(command, "ReviseSchool") ||
            Predicate.isTagged(command, "ReplaceSchoolDepartments")
          ) {
            if (school.revision !== command.expectedRevision) return yield* fail("Stale");
            revision = school.revision + 1;

            if (Predicate.isTagged(command, "ReviseSchool")) {
              yield* sql`UPDATE schools_directory_schools SET name=${command.name},contact_person=${command.contactPerson},email=${command.email},phone=${command.phone},language=${command.language},active=${command.active},revision=${revision} WHERE school_id=${schoolId}`;
            } else {
              scopeDepartments = [
                ...new Set([...authorized.departments, ...command.departmentIds]),
              ];

              for (const removed of authorized.departments.filter(
                (id) => !command.departmentIds.includes(id),
              )) {
                const proposalReferences =
                  yield* sql`SELECT proposal_id FROM school_service_proposals WHERE department_id=${removed}
              AND (demand_snapshot @> ${sql.json([{ schoolId }])}::jsonb OR assignment_snapshot @> ${sql.json([{ schoolId }])}::jsonb) LIMIT 1`;

                if (proposalReferences.length > 0) return yield* fail("AssociationInUse");
                yield* sql`DELETE FROM schools_directory_departments WHERE school_id=${schoolId} AND department_id=${removed}`.pipe(
                  Effect.mapError((cause) =>
                    Predicate.isTagged(cause.reason, "ConstraintError") &&
                    Predicate.hasProperty(cause.reason.cause, "code") &&
                    cause.reason.cause.code === "23503"
                      ? fail("AssociationInUse")
                      : cause,
                  ),
                );
              }

              for (const added of command.departmentIds.filter(
                (id) => !authorized.departments.includes(id),
              ))
                yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${added})`;
              yield* sql`UPDATE schools_directory_schools SET revision=${revision} WHERE school_id=${schoolId}`;
            }

            after = {
              school: (yield* schoolRows(sql, schoolId, false))[0]!,
              departmentIds: yield* departmentsFor(sql, schoolId),
            };
          } else {
            if (school.revision !== command.expectedSchoolRevision) return yield* fail("Stale");

            if (!school.active) return yield* fail("InactiveSchool");

            const semesters =
              yield* sql`SELECT semester_id FROM admission_period_semesters WHERE semester_id=${command.semesterId} FOR SHARE`;

            if (semesters.length === 0) return yield* fail("InvalidReference");

            const existing = (yield* capacityRows(sql, schoolId)).find(
              (plan) =>
                plan.departmentId === command.departmentId &&
                plan.semesterId === command.semesterId,
            );

            departmentId = command.departmentId;
            scopeDepartments = [departmentId];
            before = existing ?? null;

            if (Predicate.isTagged(command, "CreateCapacity")) {
              if (existing) return yield* fail("CapacityExists");

              const rows = yield* sql<{
                capacityId: number;
              }>`INSERT INTO schools_capacity_plans(school_id,department_id,semester_id,monday,tuesday,wednesday,thursday,friday)
            VALUES(${schoolId},${departmentId},${command.semesterId},${command.monday},${command.tuesday},${command.wednesday},${command.thursday},${command.friday}) RETURNING capacity_id::float8 AS "capacityId"`;

              capacityId = yield* Schema.decodeUnknownEffect(SchoolCapacityPlan.fields.capacityId)(
                rows[0]?.capacityId,
              );
              revision = 0;
            } else {
              if (!existing) return yield* fail("NotFound");

              if (existing.revision !== command.expectedRevision) return yield* fail("Stale");
              capacityId = existing.capacityId;
              revision = existing.revision + 1;
              yield* sql`UPDATE schools_capacity_plans SET monday=${command.monday},tuesday=${command.tuesday},wednesday=${command.wednesday},thursday=${command.thursday},friday=${command.friday},revision=${revision} WHERE capacity_id=${capacityId}`;
            }

            after = (yield* capacityRows(sql, schoolId)).find(
              (plan) => plan.capacityId === capacityId,
            )!;
          }
        }

        const result = { schoolId, capacityId, revision };
        yield* sql`INSERT INTO schools_command_receipts(actor_person_id,command_id,command_digest,result_json) VALUES(${personId},${command.commandId},${digest},${sql.json(result)})`;
        yield* sql`INSERT INTO schools_administration_audit(actor_person_id,command_id,school_id,capacity_id,department_id,scope_department_ids,action,reason,revision,before_json,after_json)
      VALUES(${personId},${command.commandId},${schoolId},${capacityId},${departmentId},${scopeDepartments}::text[],${command._tag},${command.reason},${revision},${sql.json(before)},${sql.json(after)})`;

        return result;
      }),
    );
  }).pipe(mapFailure);
