import { Database } from "../database/service.js";
import {
  createOrganizationDepartment,
  createOrganizationFieldOfStudy,
  createOrganizationTeam,
  listOrganizationFieldOfStudies,
} from "./administration-postgres.js";
import { resolveOrganizationPersonAuthority } from "./authority-postgres.js";
import { deriveOrganizationDirectoryFacts } from "./directory-postgres.js";
import { Effect, Layer } from "effect";
import {
  importOrganizationSnapshot,
  listOrganizationDepartments,
  listOrganizationHistoricalMemberships,
  listOrganizationMembershipsForTeam,
  listOrganizationTeams,
  readOrganizationDepartment,
  readOrganizationMembership,
  readOrganizationTeam,
  reinstateOrganizationMembership,
  reviseOrganizationMembership,
  suspendOrganizationMembership,
} from "./postgres.js";
import { Organization } from "./service.js";

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
      resolvePersonAuthority: (personId, authorizationInstant) =>
        resolveOrganizationPersonAuthority(personId, authorizationInstant).pipe(
          Effect.provideService(Database, database),
        ),
      deriveDirectoryFacts: (personIds, authorizationInstant) =>
        deriveOrganizationDirectoryFacts(personIds, authorizationInstant).pipe(
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
