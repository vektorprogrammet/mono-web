import { Data, Effect, Schema } from "effect";
import { Database } from "../database/service.js";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import type { DepartmentId, PersonId } from "../organization/schema.js";
import {
  Affiliation,
  PlacementBoard,
  PlacementScopes,
  type PlacementScope,
  type PlacementCommand,
  type OwnAffiliationCommand,
} from "./schema.js";
export class PlacementFailure extends Data.TaggedError("PlacementFailure")<{
  readonly code:
    | "authority.denied"
    | "resource.not-found"
    | "scope.invalid"
    | "affiliation.transition-invalid"
    | "affiliation.inactive"
    | "placement.overlap"
    | "placement.inactive";
  readonly status: 403 | 404 | 409 | 422;
}> {}
const fail = (code: PlacementFailure["code"], status: PlacementFailure["status"] = 422) =>
  Effect.fail(new PlacementFailure({ code, status }));
export const canManagePlacements = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
) => {
  const decision = mapOrganizationAuthorityToAdmissionPeriodActor(authority, departmentId);
  return decision._tag === "Allow" && decision.value._tag !== "Member";
};
export const readPlacementScopes = (authority: OrganizationPersonAuthority) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const departments = yield* sql<{
        departmentId: DepartmentId;
        name: string;
      }>`SELECT department_id AS "departmentId",name FROM public.organization_departments ORDER BY name,department_id`;
      const semesters =
        yield* sql`SELECT semester_id AS "semesterId",to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt" FROM public.admission_period_semesters ORDER BY start_at DESC,semester_id`;
      return yield* Schema.decodeUnknownEffect(PlacementScopes)({
        departments: departments.map((d) => ({
          ...d,
          canManage: canManagePlacements(authority, d.departmentId),
        })),
        semesters,
      });
    }),
  );
export const lockPlacementDepartment = (departmentId: DepartmentId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT department_id FROM public.organization_departments WHERE department_id=${departmentId} FOR UPDATE`;
      if (!rows.length) return yield* fail("scope.invalid");
    }),
  );
export const readOwnAffiliation = (personId: PersonId, departmentId: DepartmentId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const departments =
        yield* sql`SELECT department_id FROM public.organization_departments WHERE department_id=${departmentId}`;
      if (!departments.length) return yield* fail("scope.invalid");
      const rows =
        yield* sql`SELECT status,revision FROM public.organization_volunteer_affiliations WHERE person_id=${personId} AND department_id=${departmentId}`;
      return yield* Schema.decodeUnknownEffect(Affiliation)({
        personId,
        departmentId,
        ...(rows[0] ?? { status: "Absent", revision: 0 }),
      });
    }),
  );
export const nextAffiliationStatus = (
  status: Affiliation["status"],
  action: OwnAffiliationCommand["action"] | "Establish" | "Reject" | "Revoke",
): Affiliation["status"] | null => {
  if (action === "Request" && (status === "Absent" || status === "Inactive")) return "Pending";
  if (action === "Establish" && status === "Pending") return "Active";
  if ((action === "Withdraw" || action === "Reject") && status === "Pending") return "Inactive";
  if (action === "Revoke" && status === "Active") return "Inactive";
  return null;
};
export const mutateAffiliation = (
  current: Affiliation,
  action: OwnAffiliationCommand["action"] | "Establish" | "Reject" | "Revoke",
  actor: PersonId,
  now: string,
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const status = nextAffiliationStatus(current.status, action);
      if (status === null) return yield* fail("affiliation.transition-invalid");
      const revision = current.revision + 1;
      yield* sql`INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES(${current.personId},${current.departmentId},${status},${revision}) ON CONFLICT(person_id,department_id) DO UPDATE SET status=EXCLUDED.status,revision=EXCLUDED.revision`;
      yield* sql`INSERT INTO public.organization_volunteer_affiliation_audit(person_id,department_id,revision,action,actor_person_id,occurred_at) VALUES(${current.personId},${current.departmentId},${revision},${action},${actor},${now})`;
      return yield* readOwnAffiliation(current.personId, current.departmentId);
    }),
  );
export const readPlacementBoard = (scope: PlacementScope) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const semesters =
        yield* sql`SELECT semester_id FROM public.admission_period_semesters WHERE semester_id=${scope.semesterId}`;
      if (!semesters.length) return yield* fail("scope.invalid");
      const affiliations =
        yield* sql`SELECT a.person_id AS "personId",a.department_id AS "departmentId",a.status,a.revision,p.first_name AS "firstName",p.last_name AS "lastName" FROM public.organization_volunteer_affiliations a JOIN public.person_profiles p USING(person_id) WHERE a.department_id=${scope.departmentId} ORDER BY p.last_name,p.first_name,a.person_id`;
      const placements =
        yield* sql`SELECT x.placement_id AS "placementId",x.person_id AS "personId",x.department_id AS "departmentId",x.semester_id AS "semesterId",x.school_id::double precision AS "schoolId",x.day,x.workdays,x.block,x.active,x.revision,p.first_name AS "firstName",p.last_name AS "lastName",s.name AS "schoolName" FROM public.assistant_placements x JOIN public.person_profiles p USING(person_id) JOIN public.schools_directory_schools s USING(school_id) WHERE x.department_id=${scope.departmentId} AND x.semester_id=${scope.semesterId} ORDER BY x.placement_id`;
      const schools =
        yield* sql`SELECT s.school_id::double precision AS "schoolId",s.name FROM public.schools_directory_schools s JOIN public.schools_directory_departments d USING(school_id) WHERE d.department_id=${scope.departmentId} AND s.active ORDER BY s.name,s.school_id`;
      return yield* Schema.decodeUnknownEffect(PlacementBoard)({
        ...scope,
        affiliations,
        placements,
        schools,
      });
    }),
  );
/** Caller holds department lock and HTTP receipt transaction. Exact legacy block uniqueness is shared across department associations. */
export const mutatePlacementBoard = (
  scope: PlacementScope,
  command: PlacementCommand,
  actor: PersonId,
  now: string,
  newId: string,
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      if (command.action === "Affiliation") {
        const current = yield* readOwnAffiliation(command.personId, scope.departmentId);
        if (current.status === "Absent") return yield* fail("resource.not-found", 404);
        yield* mutateAffiliation(current, command.transition, actor, now);
        return yield* readPlacementBoard(scope);
      }
      const board = yield* readPlacementBoard(scope);
      const existing =
        command.action === "Create"
          ? undefined
          : board.placements.find((p) => p.placementId === command.placementId);
      if (command.action !== "Create" && !existing) return yield* fail("resource.not-found", 404);
      if (existing && !existing.active) return yield* fail("placement.inactive");
      const personId = command.action === "Create" ? command.personId : existing!.personId;
      const placementId = command.action === "Create" ? newId : existing!.placementId;
      const revision = (existing?.revision ?? 0) + 1;
      if (command.action !== "Remove") {
        const affiliation = yield* readOwnAffiliation(personId, scope.departmentId);
        if (affiliation.status !== "Active") return yield* fail("affiliation.inactive");
        if (!board.schools.some((s) => s.schoolId === command.schoolId))
          return yield* fail("scope.invalid");
        const overlaps =
          yield* sql`SELECT placement_id FROM public.assistant_placements WHERE active AND person_id=${personId} AND school_id=${command.schoolId} AND semester_id=${scope.semesterId} AND placement_id<>${placementId} AND block=${command.block}`;
        if (overlaps.length) return yield* fail("placement.overlap", 409);
        yield* sql`INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES(${placementId},${personId},${scope.departmentId},${scope.semesterId},${command.schoolId},${command.day},${command.workdays},${command.block},true,${revision}) ON CONFLICT(placement_id) DO UPDATE SET school_id=EXCLUDED.school_id,day=EXCLUDED.day,workdays=EXCLUDED.workdays,block=EXCLUDED.block,revision=EXCLUDED.revision`;
      } else {
        yield* sql`UPDATE public.assistant_placements SET active=false,revision=${revision} WHERE placement_id=${placementId}`;
      }
      yield* sql`INSERT INTO public.assistant_placement_audit(placement_id,revision,actor_person_id,occurred_at,action,snapshot) SELECT placement_id,revision,${actor},${now},${command.action},to_jsonb(p) FROM public.assistant_placements p WHERE placement_id=${placementId}`;
      return yield* readPlacementBoard(scope);
    }),
  );
