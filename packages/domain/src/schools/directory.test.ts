import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import {
  OrganizationAuthorityInstantSchema,
  type OrganizationAuthorityInstant,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import { DepartmentNotFound } from "../organization/errors.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import { Organization } from "../organization/service.js";
import { readSchoolsDirectory } from "./directory.js";
import { Schools } from "./service.js";

const personId = PersonId.make("schools-journey-person");
const authorizationInstant = OrganizationAuthorityInstantSchema.make("2032-03-01T12:00:00.000Z");
const otherInstant = OrganizationAuthorityInstantSchema.make("2032-03-01T12:00:00.001Z");
const departmentA = DepartmentId.make("schools-journey-a");
const departmentB = DepartmentId.make("schools-journey-b");

const authority = (
  overrides: Partial<OrganizationPersonAuthority> = {},
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt: authorizationInstant,
  globalAdministrator: "Absent",
  memberships: [
    {
      membershipId: MembershipId.make("schools-membership-b"),
      teamId: TeamId.make("schools-team-b"),
      departmentId: departmentB,
      active: true,
      teamLeader: false,
    },
    {
      membershipId: MembershipId.make("schools-membership-a"),
      teamId: TeamId.make("schools-team-a"),
      departmentId: departmentA,
      active: true,
      teamLeader: true,
    },
  ],
  ...overrides,
});

const emptyDirectory = {
  activeSchools: [],
  inactiveSchools: [],
} as const;

const makeDatabase = (observed: { transactions: number; statements: Array<string> }) => {
  const sql = ((strings: TemplateStringsArray) => {
    observed.statements.push(strings.join("?"));
    return Effect.succeed([]);
  }) as unknown as DatabaseShape;
  Object.assign(sql, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      observed.transactions += 1;
      return effect;
    },
  });
  return sql;
};

it.effect(
  "uses one injected instant, one snapshot transaction, and the full membership union",
  () =>
    Effect.gen(function* () {
      const observed = {
        transactions: 0,
        statements: [] as Array<string>,
        authorityCalls: [] as Array<readonly [PersonId, string]>,
        listInputs: [] as Array<unknown>,
      };
      const database = makeDatabase(observed);
      const organization = Organization.of({
        resolvePersonAuthorityForRead: (
          resolvedPersonId: PersonId,
          instant: OrganizationAuthorityInstant,
        ) => {
          observed.authorityCalls.push([resolvedPersonId, instant]);
          return Effect.succeed(authority());
        },
      } as never);
      const schools = Schools.of({
        listDirectory: (input) => {
          observed.listInputs.push(input);
          return Effect.succeed(emptyDirectory);
        },
      });

      const directory = yield* readSchoolsDirectory(personId, authorizationInstant, {}).pipe(
        Effect.provideService(Database, database),
        Effect.provideService(Organization, organization),
        Effect.provideService(Schools, schools),
      );

      expect(directory).toEqual(emptyDirectory);
      expect(observed.transactions).toBe(1);
      expect(observed.statements).toHaveLength(1);
      expect(observed.statements[0]).toContain("REPEATABLE READ");
      expect(observed.statements[0]).toContain("READ ONLY");
      expect(observed.authorityCalls).toEqual([[personId, authorizationInstant]]);
      expect(observed.listInputs).toEqual([
        {
          scope: { _tag: "DepartmentIds", departmentIds: [departmentA, departmentB] },
        },
      ]);
    }),
);

it.effect("maps inactive and absent Organization projections to distinct typed denials", () =>
  Effect.gen(function* () {
    const observed = { transactions: 0, statements: [] as Array<string> };
    const database = makeDatabase(observed);
    const schools = Schools.of({ listDirectory: () => Effect.succeed(emptyDirectory) });
    for (const [projection, expectedTag] of [
      [authority({ memberships: [], globalAdministrator: "Inactive" }), "AuthorityInactive"],
      [authority({ memberships: [], globalAdministrator: "Absent" }), "NotInScope"],
    ] as const) {
      const organization = Organization.of({
        resolvePersonAuthorityForRead: () => Effect.succeed(projection),
      } as never);
      const failure = yield* Effect.flip(
        readSchoolsDirectory(personId, authorizationInstant, {}).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
          Effect.provideService(Schools, schools),
        ),
      );
      expect(failure._tag).toBe(expectedTag);
    }
  }),
);

it.effect("checks that a narrowing department exists before rejecting an out-of-scope one", () =>
  Effect.gen(function* () {
    const observed = { transactions: 0, statements: [] as Array<string>, listCalls: 0 };
    const database = makeDatabase(observed);
    const schools = Schools.of({
      listDirectory: () => {
        observed.listCalls += 1;
        return Effect.succeed(emptyDirectory);
      },
    });
    const scopedAuthority = authority({
      memberships: authority().memberships.filter(
        (membership) => membership.departmentId === departmentA,
      ),
    });
    const knownOrganization = Organization.of({
      resolvePersonAuthorityForRead: () => Effect.succeed(scopedAuthority),
      readDepartment: () => Effect.succeed({} as never),
    } as never);
    const outsideFailure = yield* Effect.flip(
      readSchoolsDirectory(personId, authorizationInstant, {
        departmentId: departmentB,
      }).pipe(
        Effect.provideService(Database, database),
        Effect.provideService(Organization, knownOrganization),
        Effect.provideService(Schools, schools),
      ),
    );
    expect(outsideFailure._tag).toBe("SchoolsDepartmentOutOfScope");

    const unknownOrganization = Organization.of({
      resolvePersonAuthorityForRead: () => Effect.succeed(scopedAuthority),
      readDepartment: () => Effect.fail(new DepartmentNotFound({ departmentId: departmentB })),
    } as never);
    const unknownFailure = yield* Effect.flip(
      readSchoolsDirectory(personId, authorizationInstant, {
        departmentId: departmentB,
      }).pipe(
        Effect.provideService(Database, database),
        Effect.provideService(Organization, unknownOrganization),
        Effect.provideService(Schools, schools),
      ),
    );
    expect(unknownFailure._tag).toBe("SchoolsDepartmentNotFound");
    expect(observed.listCalls).toBe(0);
  }),
);

it.effect("rejects an Organization projection evaluated at another instant", () =>
  Effect.gen(function* () {
    const observed = { transactions: 0, statements: [] as Array<string>, listCalls: 0 };
    const database = makeDatabase(observed);
    const organization = Organization.of({
      resolvePersonAuthorityForRead: () =>
        Effect.succeed(authority({ evaluatedAt: otherInstant, globalAdministrator: "Active" })),
    } as never);
    const schools = Schools.of({
      listDirectory: () => {
        observed.listCalls += 1;
        return Effect.succeed(emptyDirectory);
      },
    });
    const failure = yield* Effect.flip(
      readSchoolsDirectory(personId, authorizationInstant, {}).pipe(
        Effect.provideService(Database, database),
        Effect.provideService(Organization, organization),
        Effect.provideService(Schools, schools),
      ),
    );
    expect(failure._tag).toBe("SchoolsDecodeError");
    expect(observed.listCalls).toBe(0);
  }),
);
