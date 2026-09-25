import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  buildSchoolServiceProposal,
  canManagePlacements,
  hasExactSchoolServiceExceptionReview,
  isEligibleSchoolServiceAttendance,
  nextAffiliationStatus,
} from "./policy.js";
import {
  OwnAffiliationCommand,
  PlacementCommand,
  PlacementValues,
  SchoolServiceAbsenceId,
  SchoolServiceCommitmentId,
  SchoolServiceCoverageAcknowledgementId,
  SchoolServiceProposalId,
  SchoolServiceSubstituteOfferId,
} from "./schema.js";
import { OrganizationPersonAuthoritySchema } from "@vektorprogrammet/domain/organization";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";

describe("volunteer affiliation authority and lifecycle", () => {
  it("requires self nomination before coordinator establishment and permits resubmission after rejection", () => {
    expect(nextAffiliationStatus("Absent", "Establish")).toBeNull();
    expect(nextAffiliationStatus("Absent", "Request")).toBe("Pending");
    expect(nextAffiliationStatus("Pending", "Request")).toBeNull();
    expect(nextAffiliationStatus("Pending", "Reject")).toBe("Inactive");
    expect(nextAffiliationStatus("Inactive", "Request")).toBe("Pending");
    expect(nextAffiliationStatus("Pending", "Establish")).toBe("Active");
    expect(nextAffiliationStatus("Active", "Withdraw")).toBeNull();
    expect(nextAffiliationStatus("Active", "Revoke")).toBe("Inactive");
    expect(nextAffiliationStatus("Pending", "Withdraw")).toBe("Inactive");
  });
  it("self nomination cannot carry a third-party person selector", () => {
    expect(() =>
      Schema.decodeUnknownSync(OwnAffiliationCommand)(
        { action: "Request", personId: PersonId.make("other") },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
  it("historical leadership and active membership in another department do not authorize placement", () => {
    const authority = Schema.decodeUnknownSync(OrganizationPersonAuthoritySchema)({
      personId: PersonId.make("coordinator"),
      evaluatedAt: "2026-09-06T00:00:00.000Z",
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: "old",
          teamId: "old-team",
          departmentId: DepartmentId.make("b"),
          active: false,
          teamLeader: true,
        },
        {
          membershipId: "current",
          teamId: "current-team",
          departmentId: DepartmentId.make("a"),
          active: true,
          teamLeader: true,
        },
      ],
    });

    expect(canManagePlacements(authority, DepartmentId.make("a"))).toBe(true);
    expect(canManagePlacements(authority, DepartmentId.make("b"))).toBe(false);
    // An ended administrator grant neither adds nor removes department leadership.
    expect(
      canManagePlacements(
        { ...authority, globalAdministrator: "Inactive" },
        DepartmentId.make("a"),
      ),
    ).toBe(true);
    expect(
      canManagePlacements(
        { ...authority, globalAdministrator: "Inactive" },
        DepartmentId.make("b"),
      ),
    ).toBe(false);
  });
});

describe("placement boundaries", () => {
  const valid = { schoolId: 1, day: "Monday", workdays: 4, block: "Both" };
  it.each([
    { workdays: 0 },
    { workdays: 9 },
    { workdays: 1.5 },
    { day: "Saturday" },
    { block: "3" },
    { schoolId: 0 },
  ])("rejects invalid teaching assignment %j", (change) => {
    expect(() => Schema.decodeUnknownSync(PlacementValues)({ ...valid, ...change })).toThrow();
  });
  it("preserves all three distinct legacy block choices", () => {
    for (const block of ["1", "2", "Both"])
      expect(Schema.decodeUnknownSync(PlacementValues)({ ...valid, block }).block).toBe(block);
  });
  it("cannot change the person or semester of an existing placement", () => {
    expect(() =>
      Schema.decodeUnknownSync(PlacementCommand)(
        {
          action: "Edit",
          placementId: `placement-${"a".repeat(64)}`,
          ...valid,
          personId: PersonId.make("other"),
          semesterId: "other",
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
  it("rejects persistence-overflow demand and calendar-invalid occurrence input", () => {
    expect(() =>
      Schema.decodeUnknownSync(PlacementCommand)({
        action: "SetDemand",
        schoolId: 1,
        day: "Monday",
        block: "1",
        requiredVolunteers: 2_147_483_648,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PlacementCommand)({
        action: "ScheduleService",
        proposalId: `school-service-proposal-${"a".repeat(64)}`,
        schoolId: 1,
        day: "Monday",
        block: "1",
        serviceDate: "2026-02-30",
        startTime: "09:00",
        endTime: "11:00",
      }),
    ).toThrow();
  });
});

describe("school service proposal boundaries", () => {
  const proposal = buildSchoolServiceProposal({
    proposalId: SchoolServiceProposalId.make(`school-service-proposal-${"a".repeat(64)}`),
    actor: PersonId.make("coordinator"),
    now: "2026-09-22T10:00:00.000Z",
    board: {
      schools: [
        { schoolId: SchoolId.make(1), name: "Lade skole" },
        { schoolId: SchoolId.make(2), name: "Byåsen skole" },
      ],
      demands: [
        {
          schoolId: SchoolId.make(1),
          day: "Monday",
          block: "1",
          requiredVolunteers: 2,
          revision: 1,
        },
      ],
      placements: [
        {
          placementId: `placement-${"1".repeat(64)}`,
          personId: PersonId.make("person-1"),
          departmentId: DepartmentId.make("trondheim"),
          semesterId: SemesterId.make("2026-autumn"),
          schoolId: SchoolId.make(1),
          schoolName: "Lade skole",
          firstName: "Ada",
          lastName: "Aktiv",
          day: "Monday",
          block: "Both",
          workdays: 8,
          active: true,
          revision: 1,
        },
        {
          placementId: `placement-${"3".repeat(64)}`,
          personId: PersonId.make("person-1"),
          departmentId: DepartmentId.make("trondheim"),
          semesterId: SemesterId.make("2026-autumn"),
          schoolId: SchoolId.make(1),
          schoolName: "Lade skole",
          firstName: "Ada",
          lastName: "Aktiv",
          day: "Monday",
          block: "1",
          workdays: 8,
          active: true,
          revision: 1,
        },
        {
          placementId: `placement-${"2".repeat(64)}`,
          personId: PersonId.make("person-2"),
          departmentId: DepartmentId.make("trondheim"),
          semesterId: SemesterId.make("2026-autumn"),
          schoolId: SchoolId.make(2),
          schoolName: "Byåsen skole",
          firstName: "Bjørn",
          lastName: "Bolk",
          day: "Tuesday",
          block: "2",
          workdays: 4,
          active: true,
          revision: 1,
        },
      ],
    },
  });

  it("expands both-block placements and reports every demand mismatch without placing anyone", () => {
    expect(
      proposal.assignments.map(({ schoolId, day, block, personId }) => [
        schoolId,
        day,
        block,
        personId,
      ]),
    ).toEqual([
      [1, "Monday", "1", "person-1"],
      [1, "Monday", "2", "person-1"],
      [2, "Tuesday", "2", "person-2"],
    ]);
    expect(
      proposal.exceptions.map(({ code, requiredVolunteers, assignedVolunteers }) => [
        code,
        requiredVolunteers,
        assignedVolunteers,
      ]),
    ).toEqual([
      ["DemandUnfilled", 2, 1],
      ["AssignmentWithoutDemand", 0, 1],
      ["AssignmentWithoutDemand", 0, 1],
    ]);
  });

  it("requires exact unique exception review", () => {
    const exceptionIds = proposal.exceptions.map(({ exceptionId }) => exceptionId);
    expect(hasExactSchoolServiceExceptionReview(proposal, exceptionIds)).toBe(true);
    expect(hasExactSchoolServiceExceptionReview(proposal, exceptionIds.slice(1))).toBe(false);
    expect(
      hasExactSchoolServiceExceptionReview(proposal, [...exceptionIds, exceptionIds[0]!]),
    ).toBe(false);
  });

  it("limits actual attendance to nonabsent scheduled or acknowledged people", () => {
    const confirmed = { ...proposal, status: "Confirmed" as const };

    const absence = {
      absenceId: SchoolServiceAbsenceId.make(`school-service-absence-${"b".repeat(64)}`),
      commitmentId: SchoolServiceCommitmentId.make(`school-service-commitment-${"e".repeat(64)}`),
      proposalId: confirmed.proposalId,
      departmentId: DepartmentId.make("trondheim"),
      semesterId: SemesterId.make("2026-autumn"),
      personId: PersonId.make("person-1"),
      schoolId: SchoolId.make(1),
      schoolName: "Lade skole",
      day: "Monday" as const,
      block: "1" as const,
      serviceDate: "2026-09-21",
      reporterPersonId: PersonId.make("person-1"),
      reportedAt: "2026-09-20T10:00:00.000Z",
    };

    const acknowledgement = {
      acknowledgementId: SchoolServiceCoverageAcknowledgementId.make(
        `school-service-coverage-acknowledgement-${"c".repeat(64)}`,
      ),
      offerId: SchoolServiceSubstituteOfferId.make(
        `school-service-substitute-offer-${"d".repeat(64)}`,
      ),
      absenceId: absence.absenceId,
      candidatePersonId: PersonId.make("person-2"),
      acknowledgedByPersonId: PersonId.make("coordinator"),
      acknowledgedAt: "2026-09-20T11:00:00.000Z",
    };

    const commitment = {
      commitmentId: absence.commitmentId,
      proposalId: confirmed.proposalId,
      departmentId: absence.departmentId,
      semesterId: absence.semesterId,
      schoolId: absence.schoolId,
      schoolName: absence.schoolName,
      day: absence.day,
      block: absence.block,
      serviceDate: absence.serviceDate,
      startTime: "09:00",
      endTime: "11:00",
      requiredVolunteers: 2,
      assignments: confirmed.assignments.filter(
        (assignment) =>
          assignment.schoolId === absence.schoolId &&
          assignment.day === absence.day &&
          assignment.block === absence.block,
      ),
      createdAt: "2026-09-20T09:00:00.000Z",
      createdBy: PersonId.make("coordinator"),
      decision: null,
      overdue: true,
    } as const;

    expect(
      isEligibleSchoolServiceAttendance(
        commitment,
        [absence],
        [acknowledgement],
        [PersonId.make("person-2")],
      ),
    ).toBe(true);
    expect(isEligibleSchoolServiceAttendance(commitment, [absence], [acknowledgement], [])).toBe(
      true,
    );
    expect(
      isEligibleSchoolServiceAttendance(
        commitment,
        [absence],
        [acknowledgement],
        [PersonId.make("person-1")],
      ),
    ).toBe(false);
    expect(
      isEligibleSchoolServiceAttendance(
        commitment,
        [absence],
        [acknowledgement],
        [PersonId.make("person-2"), PersonId.make("person-2")],
      ),
    ).toBe(false);
  });
});
