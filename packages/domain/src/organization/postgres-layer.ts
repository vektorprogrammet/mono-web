import { Database } from "../database/service.js";
import {
  createOrganizationDepartment,
  createOrganizationFieldOfStudy,
  createOrganizationTeam,
  listOrganizationFieldOfStudies,
} from "./administration-postgres.js";
import { resolveOrganizationPersonAuthority } from "./authority-postgres.js";
import { Effect, Layer } from "effect";
import {
  importOrganizationSnapshot,
  listOrganizationDepartments,
  listOrganizationHistoricalMemberships,
  listOrganizationMembershipsForTeam,
  listOrganizationTeams,
  listOrganizationTeamInterestRegistrations,
  readOrganizationDepartment,
  readOrganizationMembership,
  readOrganizationTeam,
  reinstateOrganizationMembership,
  reviseOrganizationMembership,
  suspendOrganizationMembership,
} from "./postgres.js";
import { Organization } from "./service.js";
import type {
  OrganizationDecodeError,
  OrganizationPersistenceError,
} from "./errors.js";
import type { ProfileFailure } from "../profile/errors.js";
import {
  membershipCoversSemester,
  projectOrganizationMailingLists,
  type MailingList,
} from "./mailing-lists.js";
import { PROFILE_READ_LIMIT } from "../profile/postgres.js";
import { Profile } from "../profile/service.js";
import { type DepartmentId, PersonId } from "./schema.js";

export const OrganizationLive = Layer.effect(
  Organization,
  Effect.gen(function* () {
    const database = yield* Database;
    return Organization.of({
      readDepartment: (departmentId) =>
        readOrganizationDepartment(departmentId).pipe(Effect.provideService(Database, database)),
      listDepartments: listOrganizationDepartments().pipe(
        Effect.provideService(Database, database),
      ),
      readTeam: (teamId) =>
        readOrganizationTeam(teamId).pipe(Effect.provideService(Database, database)),
      listTeams: (departmentId) =>
        listOrganizationTeams(departmentId).pipe(Effect.provideService(Database, database)),
      listFieldOfStudies: listOrganizationFieldOfStudies().pipe(
        Effect.provideService(Database, database),
      ),
      createDepartment: (command, actor) =>
        createOrganizationDepartment(command, actor).pipe(
          Effect.provideService(Database, database),
        ),
      createTeam: (command, actor) =>
        createOrganizationTeam(command, actor).pipe(Effect.provideService(Database, database)),
      createFieldOfStudy: (command, actor) =>
        createOrganizationFieldOfStudy(command, actor).pipe(
          Effect.provideService(Database, database),
        ),
      readMembership: (membershipId) =>
        readOrganizationMembership(membershipId).pipe(Effect.provideService(Database, database)),
      listMembershipsForTeam: (teamId) =>
        listOrganizationMembershipsForTeam(teamId).pipe(Effect.provideService(Database, database)),
      listHistoricalMemberships: listOrganizationHistoricalMemberships().pipe(
        Effect.provideService(Database, database),
      ),
      listTeamInterestRegistrations: (filter) =>
        listOrganizationTeamInterestRegistrations(filter).pipe(
          Effect.provideService(Database, database),
        ),
      projectMailingLists: (input): Effect.Effect<
        ReadonlyArray<MailingList>,
        OrganizationDecodeError | OrganizationPersistenceError | ProfileFailure,
        Profile
      > =>
        Effect.gen(function* () {
          const profile = yield* Profile;
          const semesterWindow = input.semesterWindow;
          const membersByDepartment = new Map<DepartmentId, ReadonlyArray<PersonId>>();
          for (const departmentId of input.authorizedDepartmentIds) {
            if (input.departmentId !== undefined && input.departmentId !== departmentId) continue;
            const teams = yield* listOrganizationTeams(departmentId).pipe(
              Effect.provideService(Database, database),
            );
            const persons: Array<string> = [];
            for (const team of teams) {
              const memberships = yield* listOrganizationMembershipsForTeam(team.teamId).pipe(
                Effect.provideService(Database, database),
              );
              for (const membership of memberships) {
                if (!membership.isSuspended && membership.teamId !== null) {
                  const covers =
                    semesterWindow === undefined ||
                    membershipCoversSemester(membership, semesterWindow);
                  if (covers) persons.push(String(membership.personId));
                }
              }
            }
            membersByDepartment.set(
              departmentId,
              [...new Set(persons)].map((value) => PersonId.make(value)),
            );
          }
          const wantedPersonIds = new Set<string>();
          for (const persons of membersByDepartment.values()) {
            for (const person of persons) wantedPersonIds.add(person);
          }
          for (const persons of input.assistantsByDepartment?.values() ?? []) {
            for (const person of persons) wantedPersonIds.add(String(person));
          }
          const contactByPerson = new Map();
          const uniquePersonIds = [...wantedPersonIds].map((value) => PersonId.make(value));
          for (
            let offset = 0;
            offset < uniquePersonIds.length;
            offset += PROFILE_READ_LIMIT
          ) {
            const batch = uniquePersonIds.slice(offset, offset + PROFILE_READ_LIMIT);
            // Missing contacts shrink the list silently (spec 0060 law 4):
            // readContacts fails on any missing row, so probe one by one.
            const contacts = yield* Effect.forEach(
              batch,
              (personId) =>
                profile.readContacts([personId]).pipe(
                  Effect.map((rows) => rows[0]),
                  Effect.catch(() => Effect.succeed(undefined)),
                ),
              { concurrency: 1 },
            );
            for (const contact of contacts) {
              if (contact === undefined) continue;
              contactByPerson.set(String(contact.personId), {
                name: String(contact.personId),
                email: contact.email,
              });
            }
          }
          return projectOrganizationMailingLists({
            type: input.type,
            authorizedDepartmentIds: input.authorizedDepartmentIds,
            departmentId: input.departmentId,
            semesterId: input.semesterId,
            membersByDepartment,
            assistantsByDepartment: new Map(input.assistantsByDepartment ?? []),
            contacts: contactByPerson,
          });
        }),
      resolvePersonAuthority: (personId, authorizationInstant) =>
        resolveOrganizationPersonAuthority(personId, authorizationInstant).pipe(
          Effect.provideService(Database, database),
        ),
      reviseMembership: (command) =>
        reviseOrganizationMembership(command).pipe(Effect.provideService(Database, database)),
      suspendMembership: (command) =>
        suspendOrganizationMembership(command).pipe(Effect.provideService(Database, database)),
      reinstateMembership: (command) =>
        reinstateOrganizationMembership(command).pipe(Effect.provideService(Database, database)),
      importLegacyOrganization: (snapshot) =>
        importOrganizationSnapshot(snapshot).pipe(Effect.provideService(Database, database)),
    });
  }),
);
