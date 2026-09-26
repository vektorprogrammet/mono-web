import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import type {
  OrganizationAuthorityMembership,
  OrganizationPersonAuthority,
} from "../organization/authority.js";
import { mapOrganizationAuthorityToOrganizationActor } from "../organization/authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import { ORGANIZATION_CAPABILITY_IDS } from "./delegation.js";
import {
  certificateIssuerBasis,
  derivedBoardSeats,
  holdsDepartmentReach,
  IssuerBasis,
  reaches,
  ReachTarget,
  SeatBoard,
} from "./reach.js";

const independent = {
  departmentId: DepartmentId.make("department-independent"),
  independent: true,
};

const governed = { departmentId: DepartmentId.make("department-governed"), independent: false };

const person = PersonId.make("person-issuer");

const appointment = (
  departmentId: DepartmentId,
  input: {
    readonly id: string;
    readonly board?: boolean;
    readonly leader?: boolean;
    readonly national?: boolean;
    readonly active?: boolean;
  },
): OrganizationAuthorityMembership => ({
  membershipId: MembershipId.make(`membership-${input.id}`),
  teamId: TeamId.make(`team-${input.id}`),
  departmentId,
  active: input.active ?? true,
  unitLeader: input.leader ?? false,
  unitKind: input.board === true ? "DepartmentBoard" : "Team",
  teamScope: input.national === true ? "National" : "HomeDepartment",
  departmentIndependent: departmentId === independent.departmentId,
});

const authority = (
  input: {
    readonly memberships?: ReadonlyArray<OrganizationAuthorityMembership>;
    readonly nationalBoard?: "Active" | "Ended";
    readonly globalAdministrator?: OrganizationPersonAuthority["globalAdministrator"];
  } = {},
): OrganizationPersonAuthority => ({
  personId: person,
  evaluatedAt: "2026-10-01T00:00:00.000Z",
  globalAdministrator: input.globalAdministrator ?? "Absent",
  memberships: input.memberships ?? [],
  nationalBoardSeats:
    input.nationalBoard === undefined
      ? []
      : [
          {
            membershipId: MembershipId.make("membership-hovedstyret"),
            boardId: "hovedstyret",
            active: input.nationalBoard === "Active",
            unitLeader: false,
          },
        ],
  delegations: [],
});

const issues = (reader: OrganizationPersonAuthority) => ({
  independent: Option.isSome(certificateIssuerBasis(reader, independent)),
  governed: Option.isSome(certificateIssuerBasis(reader, governed)),
});

describe("certificate issuers", () => {
  it("lets a Styret member issue for the independent department only", () => {
    const member = authority({
      memberships: [appointment(independent.departmentId, { id: "styret", board: true })],
    });

    expect(issues(member)).toEqual({ independent: true, governed: false });
    expect(certificateIssuerBasis(member, independent)).toEqual(
      Option.some(IssuerBasis.BoardSeat({ membershipId: MembershipId.make("membership-styret") })),
    );
  });

  it("gives the Styret of a department that is not independent nothing to issue", () => {
    const member = authority({
      memberships: [appointment(governed.departmentId, { id: "styret", board: true })],
    });

    expect(issues(member)).toEqual({ independent: false, governed: false });
  });

  it("lets a derived Styret seat issue for its independent home department only", () => {
    const leader = authority({
      memberships: [appointment(independent.departmentId, { id: "it", leader: true })],
    });

    expect(issues(leader)).toEqual({ independent: true, governed: false });
    expect(certificateIssuerBasis(leader, independent)).toEqual(
      Option.some(
        IssuerBasis.DerivedSeat({
          membershipId: MembershipId.make("membership-it"),
          teamId: TeamId.make("team-it"),
        }),
      ),
    );
  });

  it("denies a team leader without a qualifying seat and a team member", () => {
    const localLeader = authority({
      memberships: [appointment(governed.departmentId, { id: "skole", leader: true })],
    });

    const member = authority({
      memberships: [appointment(independent.departmentId, { id: "it" })],
    });

    expect(issues(localLeader)).toEqual({ independent: false, governed: false });
    expect(issues(member)).toEqual({ independent: false, governed: false });
  });

  it("lets Hovedstyret and a derived Hovedstyret seat issue for departments that are not independent", () => {
    const seat = authority({ nationalBoard: "Active" });

    const nationalLeader = authority({
      memberships: [
        appointment(independent.departmentId, { id: "okonomi", leader: true, national: true }),
      ],
    });

    expect(issues(seat)).toEqual({ independent: false, governed: true });
    expect(issues(nationalLeader)).toEqual({ independent: false, governed: true });
  });

  it("lets a global administrator issue everywhere and names a seat before the grant", () => {
    const administrator = authority({ globalAdministrator: "Active" });

    expect(issues(administrator)).toEqual({ independent: true, governed: true });
    expect(certificateIssuerBasis(administrator, governed)).toEqual(
      Option.some(IssuerBasis.GlobalAdministrator()),
    );
    expect(
      certificateIssuerBasis(
        authority({ globalAdministrator: "Active", nationalBoard: "Active" }),
        governed,
      ),
    ).toEqual(
      Option.some(
        IssuerBasis.BoardSeat({ membershipId: MembershipId.make("membership-hovedstyret") }),
      ),
    );
  });

  it("ends with the seat: ended leadership, ended board seats, and ended grants issue nothing", () => {
    const ended = authority({
      memberships: [
        appointment(independent.departmentId, { id: "styret", board: true, active: false }),
        appointment(independent.departmentId, { id: "it", leader: true, active: false }),
        appointment(independent.departmentId, {
          id: "okonomi",
          leader: true,
          national: true,
          active: false,
        }),
      ],
      nationalBoard: "Ended",
      globalAdministrator: "Inactive",
    });

    expect(issues(ended)).toEqual({ independent: false, governed: false });
  });
});

describe("derived board seats", () => {
  const facts = [
    { ...appointment(independent.departmentId, { id: "it", leader: true }), personId: person },
    {
      ...appointment(governed.departmentId, { id: "okonomi", leader: true, national: true }),
      personId: PersonId.make("person-finance"),
    },
    {
      ...appointment(independent.departmentId, { id: "ended", leader: true, active: false }),
      personId: PersonId.make("person-former"),
    },
    {
      ...appointment(independent.departmentId, { id: "member" }),
      personId: PersonId.make("person-member"),
    },
    {
      ...appointment(independent.departmentId, { id: "styret", board: true, leader: true }),
      personId: PersonId.make("person-chair"),
    },
  ];

  it("seats every current team leader on the board of the team's area, and no one else", () => {
    expect(derivedBoardSeats(facts)).toEqual([
      {
        board: SeatBoard.DepartmentBoard({ departmentId: independent.departmentId }),
        personId: person,
        sourceMembershipId: MembershipId.make("membership-it"),
        sourceTeamId: TeamId.make("team-it"),
      },
      {
        board: SeatBoard.NationalBoard(),
        personId: PersonId.make("person-finance"),
        sourceMembershipId: MembershipId.make("membership-okonomi"),
        sourceTeamId: TeamId.make("team-okonomi"),
      },
    ]);
  });

  it("grants no administration and no global administration", () => {
    const leader = authority({
      memberships: [appointment(independent.departmentId, { id: "it", leader: true })],
    });

    const department = ReachTarget.Department({ departmentId: independent.departmentId });

    expect(Option.isSome(certificateIssuerBasis(leader, independent))).toBe(true);
    expect(
      ORGANIZATION_CAPABILITY_IDS.filter((capability) => reaches(leader, capability, department)),
    ).toEqual([]);
    expect(holdsDepartmentReach(leader)).toBe(false);
    expect(mapOrganizationAuthorityToOrganizationActor(leader)._tag).toBe("OrganizationMember");
  });
});
