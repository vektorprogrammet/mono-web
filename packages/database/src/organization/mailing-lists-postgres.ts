import { Effect, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { AdmissionSemester } from "@vektorprogrammet/domain/admission-period";
import { reachedDepartments, ReachedDepartments } from "@vektorprogrammet/domain/authz";
import {
  DepartmentId,
  PersonId,
  OrganizationInvalidReference,
  OrganizationPersistenceError,
  OrganizationRoleDenied,
  membershipCoversSemester,
  projectOrganizationMailingLists,
  type MailingListContact,
  type OrganizationOperations,
} from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { Database } from "../service.js";
import { resolveOrganizationPersonAuthorityForRead } from "./authority-postgres.js";
import {
  listOrganizationDepartments,
  listOrganizationMembershipsForTeam,
  listOrganizationTeams,
} from "./postgres.js";

export const readOrganizationMailingLists = Effect.fn("readOrganizationMailingLists")(function* (
  input: Parameters<OrganizationOperations["projectMailingLists"]>[0],
) {
  const sql = yield* Database;
  const profile = yield* Profile;

  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

        const authority = yield* resolveOrganizationPersonAuthorityForRead(
          input.actorPersonId,
          input.authorizationInstant,
        );

        const reached = reachedDepartments(authority, "people.read");
        const global = ReachedDepartments.$is("All")(reached);

        const reachedDepartmentIds = new Set<DepartmentId>(
          ReachedDepartments.$is("Departments")(reached) ? reached.departmentIds : [],
        );

        if (
          !global &&
          (reachedDepartmentIds.size === 0 ||
            (input.departmentId !== undefined && !reachedDepartmentIds.has(input.departmentId)))
        ) {
          return yield* new OrganizationRoleDenied({
            actorPersonId: input.actorPersonId,
            requiredRole: "DepartmentAdministrator",
          });
        }

        const departments = yield* listOrganizationDepartments;

        if (
          input.departmentId !== undefined &&
          !departments.some((department) => department.departmentId === input.departmentId)
        ) {
          return yield* new OrganizationInvalidReference({ referenceKind: "Department" });
        }

        const authorizedDepartmentIds = departments
          .filter(
            (department) =>
              (global || reachedDepartmentIds.has(department.departmentId)) &&
              (input.departmentId === undefined || department.departmentId === input.departmentId),
          )
          .map((department) => department.departmentId);

        const semesters = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: AdmissionSemester,
          execute: () => sql`
          SELECT semester_id AS "semesterId",
            to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
            to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
          FROM public.admission_period_semesters
          WHERE ${
            input.semesterId === undefined
              ? sql`start_at <= ${input.authorizationInstant}::timestamptz
                AND ${input.authorizationInstant}::timestamptz < end_at`
              : sql`semester_id = ${input.semesterId}`
          }
        `,
        })(undefined);

        const semester = semesters[0];

        if (semesters.length !== 1 || semester === undefined) {
          return yield* new OrganizationInvalidReference({
            referenceKind: input.semesterId === undefined ? "CurrentSemester" : "Semester",
          });
        }

        const membersByDepartment = new Map<DepartmentId, Array<PersonId>>();
        const assistantsByDepartment = new Map<DepartmentId, Array<PersonId>>();
        const wantedPersonIds = new Set<PersonId>();

        if (input.type !== "assistants") {
          for (const departmentId of authorizedDepartmentIds) {
            const persons = new Set<PersonId>();
            const teams = yield* listOrganizationTeams(departmentId);

            for (const team of teams) {
              const memberships = yield* listOrganizationMembershipsForTeam(team.teamId);

              for (const membership of memberships) {
                if (!membership.isSuspended && membershipCoversSemester(membership, semester)) {
                  persons.add(membership.personId);
                  wantedPersonIds.add(membership.personId);
                }
              }
            }

            membersByDepartment.set(departmentId, [...persons]);
          }
        }

        if (input.type !== "team" && authorizedDepartmentIds.length > 0) {
          const assistants = yield* SqlSchema.findAll({
            Request: Schema.Void,
            Result: Schema.Struct({ departmentId: DepartmentId, personId: PersonId }),
            execute: () => sql`
            SELECT department_id AS "departmentId", person_id AS "personId"
            FROM public.assistant_affiliation_history
            WHERE semester_id = ${semester.semesterId}
              AND ${sql.in("department_id", authorizedDepartmentIds)}
            UNION
            SELECT department_id AS "departmentId", person_id AS "personId"
            FROM public.assistant_placements
            WHERE active AND semester_id = ${semester.semesterId}
              AND ${sql.in("department_id", authorizedDepartmentIds)}
          `,
          })(undefined);

          for (const assistant of assistants) {
            const persons = assistantsByDepartment.get(assistant.departmentId);

            if (persons === undefined)
              assistantsByDepartment.set(assistant.departmentId, [assistant.personId]);
            else persons.push(assistant.personId);
            wantedPersonIds.add(assistant.personId);
          }
        }

        const contacts = new Map<PersonId, MailingListContact>();

        for (const personId of wantedPersonIds) {
          const rows = yield* profile
            .readContacts([personId])
            .pipe(Effect.catchTag("ProfileContactNotFound", () => Effect.succeed([])));

          const contact = rows[0];

          if (contact !== undefined)
            contacts.set(personId, { name: personId, email: contact.email });
        }

        return projectOrganizationMailingLists({
          type: input.type,
          authorizedDepartmentIds,
          membersByDepartment,
          assistantsByDepartment,
          contacts,
        });
      }),
    )
    .pipe(
      Effect.catchTag(["SqlError", "SchemaError"], (cause) =>
        Effect.fail(
          new OrganizationPersistenceError({
            operation: "read Organization mailing recipients",
            message: String(cause),
            cause,
          }),
        ),
      ),
    );
});
