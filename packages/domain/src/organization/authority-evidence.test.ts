import { expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Predicate, Result, Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import {
  type OrganizationActor,
  type OrganizationAdministrator,
  OrganizationAdministratorSchema,
  type OrganizationMember,
} from "./administration-schema.js";
import {
  mapOrganizationAuthorityToOrganizationActor,
  type OrganizationAdministratorEvidence,
  OrganizationAuthorityBoardSeatSchema,
  OrganizationAuthorityMembershipSchema,
  OrganizationGlobalAdministratorStatusSchema,
  OrganizationPersonAuthoritySchema,
  requireOrganizationAdministrator,
} from "./authority.js";
import { spec0055OrganizationAuthorityFixtures } from "./authority-fixtures.test-support.js";
import type { OrganizationOperations } from "./service.js";

const fixtures = spec0055OrganizationAuthorityFixtures({
  evaluatedAt: "2026-09-28T12:00:00.000Z",
  departmentId: "evidence-department",
  teamId: "evidence-team",
  persons: {
    administrator: "evidence-administrator",
    leader: "evidence-leader",
    inactiveLeader: "evidence-inactive-leader",
    member: "evidence-member",
    absent: "evidence-absent",
  },
  memberships: {
    leader: "evidence-leader-membership",
    inactiveLeader: "evidence-inactive-leader-membership",
    member: "evidence-member-membership",
  },
});

/**
 * A fixture person and instant with every global-administrator status and generated memberships
 * and board seats, leaders and board leaders included. They vary independently of the grant, so a
 * check that read them instead of the grant would disagree on some case. Instants are not
 * generated: the RFC 3339 filter exhausts the schema arbitrary.
 */
const authority = Arbitrary.map(
  Arbitrary.all({
    base: Arbitrary.schema(
      Schema.Literals(["administrator", "leader", "inactiveLeader", "member", "absent"]),
    ),
    globalAdministrator: Arbitrary.schema(OrganizationGlobalAdministratorStatusSchema),
    memberships: Arbitrary.schema(Schema.Array(OrganizationAuthorityMembershipSchema)),
    nationalBoardSeats: Arbitrary.schema(Schema.Array(OrganizationAuthorityBoardSeatSchema)),
  }),
  ({ base, globalAdministrator, memberships, nationalBoardSeats }) =>
    OrganizationPersonAuthoritySchema.make({
      ...fixtures[base],
      globalAdministrator,
      memberships,
      nationalBoardSeats,
    }),
);

const propertyOptions = { arbitrary: { seed: 28092026, runs: 200 } } as const;

it.effect(
  "requireOrganizationAdministrator returns evidence for an active global administrator and a denial for the others",
  () =>
    Effect.gen(function* () {
      const administrator = yield* Effect.fromResult(
        requireOrganizationAdministrator(fixtures.administrator),
      );

      expect(administrator.actor).toEqual(
        OrganizationAdministratorSchema.make({ personId: fixtures.administrator.personId }),
      );

      for (const denied of [
        fixtures.leader,
        fixtures.inactiveLeader,
        fixtures.member,
        fixtures.absent,
      ]) {
        const failure = yield* Effect.flip(
          Effect.fromResult(requireOrganizationAdministrator(denied)),
        );

        expect(failure._tag).toBe("OrganizationRoleDenied");
        expect(failure.actorPersonId).toBe(denied.personId);
        expect(failure.requiredRole).toBe("OrganizationAdministrator");
      }
    }),
);

it.prop(
  "requireOrganizationAdministrator grants evidence exactly for an active grant, for the same person, in agreement with the actor mapping",
  { authority },
  ({ authority }) => {
    const result = requireOrganizationAdministrator(authority);
    const actor = mapOrganizationAuthorityToOrganizationActor(authority);

    expect(Result.isSuccess(result)).toBe(authority.globalAdministrator === "Active");
    expect(Result.isSuccess(result)).toBe(Predicate.isTagged(actor, "OrganizationAdministrator"));

    if (Result.isSuccess(result)) {
      expect(result.success.actor).toEqual(actor);
    } else {
      expect(result.failure.actorPersonId).toBe(authority.personId);
    }
  },
  propertyOptions,
);

it("requireOrganizationAdministrator evidence is the only way to satisfy an administration command", () => {
  type Administrator = Parameters<OrganizationOperations["createDepartment"]>[1];

  expectTypeOf<
    Parameters<OrganizationOperations["createTeam"]>[1]
  >().toEqualTypeOf<Administrator>();
  expectTypeOf<
    Parameters<OrganizationOperations["createFieldOfStudy"]>[1]
  >().toEqualTypeOf<Administrator>();
  expectTypeOf<OrganizationAdministratorEvidence>().toExtend<Administrator>();

  // Negative controls: an actor, a member, or a literal of the evidence's visible shape is not evidence.
  expectTypeOf<OrganizationActor>().not.toExtend<Administrator>();
  expectTypeOf<OrganizationAdministrator>().not.toExtend<Administrator>();
  expectTypeOf<OrganizationMember>().not.toExtend<Administrator>();
  expectTypeOf<{ readonly actor: OrganizationAdministrator }>().not.toExtend<Administrator>();
});
