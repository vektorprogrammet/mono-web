import { Database } from "../service.js";
import { readAppointmentManagement, executeOrganizationLifecycle } from "./lifecycle-postgres.js";
import { executeDelegation, readDelegationManagement } from "../authz/delegation-postgres.js";
import {
  createOrganizationDepartment,
  createOrganizationFieldOfStudy,
  createOrganizationTeam,
  listOrganizationFieldOfStudies,
} from "./administration-postgres.js";
import {
  resolveOrganizationPersonAuthority,
  resolveOrganizationPersonAuthorityForRead,
} from "./authority-postgres.js";
import { deriveOrganizationDirectoryFacts } from "./directory-postgres.js";
import { readOrganizationMailingLists } from "./mailing-lists-postgres.js";
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
} from "./postgres.js";
import { Organization } from "@vektorprogrammet/domain/organization";

export const OrganizationLive = Layer.effect(
  Organization,
  Effect.gen(function* () {
    const database = yield* Database;

    return Organization.of({
      readAppointmentManagement: (personId) =>
        readAppointmentManagement(personId).pipe(Effect.provideService(Database, database)),
      executeLifecycle: (command, personId) =>
        executeOrganizationLifecycle(command, personId).pipe(
          Effect.provideService(Database, database),
        ),
      readDelegationManagement: (personId) =>
        readDelegationManagement(personId).pipe(Effect.provideService(Database, database)),
      executeDelegation: (command, personId) =>
        executeDelegation(command, personId).pipe(Effect.provideService(Database, database)),
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
      projectMailingLists: (input) =>
        readOrganizationMailingLists(input).pipe(Effect.provideService(Database, database)),
      resolvePersonAuthority: (personId, authorizationInstant) =>
        resolveOrganizationPersonAuthority(personId, authorizationInstant).pipe(
          Effect.provideService(Database, database),
        ),
      resolvePersonAuthorityForRead: (personId, authorizationInstant) =>
        resolveOrganizationPersonAuthorityForRead(personId, authorizationInstant).pipe(
          Effect.provideService(Database, database),
        ),
      deriveDirectoryFacts: (personIds, authorizationInstant) =>
        deriveOrganizationDirectoryFacts(personIds, authorizationInstant).pipe(
          Effect.provideService(Database, database),
        ),

      importLegacyOrganization: (snapshot) =>
        importOrganizationSnapshot(snapshot).pipe(Effect.provideService(Database, database)),
    });
  }),
);
