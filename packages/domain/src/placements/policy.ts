import { Data } from "effect";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import type { DepartmentId, PersonId } from "../organization/schema.js";
import type { SchoolId } from "../schools/schema.js";
import type {
  Affiliation,
  OwnAffiliationCommand,
  PlacementBoard,
  SchoolServiceAbsence,
  SchoolServiceCoverageAcknowledgement,
  SchoolServiceProposal,
  SchoolServiceProposalAssignment,
  SchoolServiceProposalException,
} from "./schema.js";

export class PlacementFailure extends Data.TaggedError("PlacementFailure")<{
  readonly code:
    | "authority.denied"
    | "resource.not-found"
    | "scope.invalid"
    | "affiliation.transition-invalid"
    | "affiliation.inactive"
    | "placement.overlap"
    | "placement.inactive"
    | "school-service.proposal-empty"
    | "school-service.proposal-inactive"
    | "school-service.exception-review-invalid"
    | "school-service.occurrence-invalid"
    | "school-service.occurrence-duplicate"
    | "absence.target-invalid"
    | "absence.duplicate"
    | "absence.closed"
    | "offer.candidate-ineligible"
    | "offer.unresolved"
    | "offer.owner-invalid"
    | "offer.response-invalid"
    | "offer.withdraw-invalid"
    | "coverage.acknowledgement-invalid"
    | "coverage.pending-offer"
    | "coverage.attendance-invalid"
    | "coverage.occurrence-duplicate";
  readonly status: 403 | 404 | 409 | 422;
}> {}

export class SchoolServiceNotificationOutboxError extends Data.TaggedError(
  "SchoolServiceNotificationOutboxError",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export class SchoolServiceNotificationDeliveryError extends Data.TaggedError(
  "SchoolServiceNotificationDeliveryError",
)<{
  readonly effectId: string;
}> {}

export class SchoolServiceDispatchNotificationOutboxError extends Data.TaggedError(
  "SchoolServiceDispatchNotificationOutboxError",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

export class SchoolServiceDispatchNotificationDeliveryError extends Data.TaggedError(
  "SchoolServiceDispatchNotificationDeliveryError",
)<{
  readonly effectId: string;
}> {}

/** A coordinator is an active scoped department leader or an active global administrator. */
export const canManagePlacements = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): boolean => {
  const decision = mapOrganizationAuthorityToAdmissionPeriodActor(authority, departmentId);
  return decision._tag === "Allow" && decision.value._tag !== "Member";
};

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

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const assignmentKey = (assignment: {
  readonly schoolId: SchoolId;
  readonly day: string;
  readonly block: string;
}) => `${assignment.schoolId}:${assignment.day}:${assignment.block}`;

const assignmentOrder = (
  left: SchoolServiceProposalAssignment,
  right: SchoolServiceProposalAssignment,
) =>
  compareText(assignmentKey(left), assignmentKey(right)) ||
  compareText(left.personId, right.personId) ||
  compareText(left.placementId, right.placementId);

export const buildSchoolServiceProposal = (input: {
  readonly proposalId: SchoolServiceProposal["proposalId"];
  readonly board: Pick<PlacementBoard, "demands" | "placements" | "schools">;
  readonly actor: PersonId;
  readonly now: string;
}): SchoolServiceProposal => {
  const expandedAssignments = input.board.placements
    .filter((placement) => placement.active)
    .flatMap((placement): ReadonlyArray<SchoolServiceProposalAssignment> => {
      const blocks = placement.block === "Both" ? (["1", "2"] as const) : [placement.block];
      return blocks.map((block) => ({
        placementId: placement.placementId,
        personId: placement.personId,
        firstName: placement.firstName,
        lastName: placement.lastName,
        schoolId: placement.schoolId,
        schoolName: placement.schoolName,
        day: placement.day,
        block,
      }));
    })
    .sort(assignmentOrder);
  const assignments = [
    ...new Map(
      expandedAssignments.map((assignment) => [
        `${assignmentKey(assignment)}:${assignment.personId}`,
        assignment,
      ]),
    ).values(),
  ];
  const demands = [...input.board.demands].sort((left, right) =>
    compareText(assignmentKey(left), assignmentKey(right)),
  );
  const demandBySlot = new Map(demands.map((demand) => [assignmentKey(demand), demand]));
  const assignmentsBySlot = Map.groupBy(assignments, assignmentKey);
  const slotKeys = [...new Set([...demandBySlot.keys(), ...assignmentsBySlot.keys()])].sort(
    compareText,
  );
  const schoolNames = new Map(
    input.board.schools.map((school) => [school.schoolId, school.name] as const),
  );
  const exceptions: Array<SchoolServiceProposalException> = [];
  for (const key of slotKeys) {
    const demand = demandBySlot.get(key);
    const assigned = assignmentsBySlot.get(key) ?? [];
    const requiredVolunteers = demand?.requiredVolunteers ?? 0;
    if (assigned.length === requiredVolunteers) continue;
    const first = demand ?? assigned[0]!;
    const code =
      demand === undefined
        ? "AssignmentWithoutDemand"
        : assigned.length < requiredVolunteers
          ? "DemandUnfilled"
          : "DemandExceeded";
    exceptions.push({
      exceptionId: `${key}:${code}`,
      code,
      schoolId: first.schoolId,
      schoolName:
        schoolNames.get(first.schoolId) ?? assigned[0]?.schoolName ?? String(first.schoolId),
      day: first.day,
      block: first.block,
      requiredVolunteers,
      assignedVolunteers: assigned.length,
    });
  }
  return {
    proposalId: input.proposalId,
    status: "Draft",
    revision: 1,
    createdAt: input.now,
    createdBy: input.actor,
    confirmedAt: null,
    confirmedBy: null,
    demands,
    assignments,
    exceptions,
    reviewedExceptionIds: [],
  };
};

const exactUniqueValues = (
  expected: ReadonlyArray<string>,
  submitted: ReadonlyArray<string>,
): boolean => {
  const sortedExpected = [...new Set(expected)].sort(compareText);
  const sortedSubmitted = [...new Set(submitted)].sort(compareText);
  return (
    sortedSubmitted.length === submitted.length &&
    sortedExpected.length === sortedSubmitted.length &&
    sortedExpected.every((value, index) => value === sortedSubmitted[index])
  );
};

export const hasExactSchoolServiceExceptionReview = (
  proposal: SchoolServiceProposal,
  reviewedExceptionIds: ReadonlyArray<string>,
): boolean =>
  exactUniqueValues(
    proposal.exceptions.map((exception) => exception.exceptionId),
    reviewedExceptionIds,
  );

export const hasExactSchoolServiceAttendance = (
  proposal: SchoolServiceProposal,
  slot: {
    readonly schoolId: SchoolId;
    readonly day: SchoolServiceProposalAssignment["day"];
    readonly block: SchoolServiceProposalAssignment["block"];
    readonly attendedPersonIds: ReadonlyArray<PersonId>;
  },
): boolean => {
  if (proposal.status !== "Confirmed") return false;
  const expected = proposal.assignments
    .filter(
      (assignment) =>
        assignment.schoolId === slot.schoolId &&
        assignment.day === slot.day &&
        assignment.block === slot.block,
    )
    .map((assignment) => assignment.personId);
  return expected.length > 0 && exactUniqueValues(expected, slot.attendedPersonIds);
};

/**
 * Attendance is derived from separate immutable facts. An absence removes only
 * its scheduled person, while an acknowledgement adds only the fixed candidate.
 */
export const hasExactSubstitutedSchoolServiceAttendance = (
  proposal: SchoolServiceProposal,
  absences: ReadonlyArray<SchoolServiceAbsence>,
  acknowledgements: ReadonlyArray<SchoolServiceCoverageAcknowledgement>,
  slot: {
    readonly schoolId: SchoolId;
    readonly day: SchoolServiceProposalAssignment["day"];
    readonly block: SchoolServiceProposalAssignment["block"];
    readonly serviceDate: string;
    readonly attendedPersonIds: ReadonlyArray<PersonId>;
  },
): boolean => {
  if (proposal.status !== "Confirmed") return false;
  const roster = proposal.assignments
    .filter(
      (assignment) =>
        assignment.schoolId === slot.schoolId &&
        assignment.day === slot.day &&
        assignment.block === slot.block,
    )
    .map((assignment) => assignment.personId);
  if (roster.length === 0) return false;
  const slotAbsences = absences.filter(
    (absence) =>
      absence.proposalId === proposal.proposalId &&
      absence.schoolId === slot.schoolId &&
      absence.day === slot.day &&
      absence.block === slot.block &&
      absence.serviceDate === slot.serviceDate,
  );
  const absentPeople = new Set(slotAbsences.map((absence) => absence.personId));
  const absenceIds = new Set(slotAbsences.map((absence) => absence.absenceId));
  const substitutions = acknowledgements
    .filter((acknowledgement) => absenceIds.has(acknowledgement.absenceId))
    .map((acknowledgement) => acknowledgement.candidatePersonId);
  return exactUniqueValues(
    [...roster.filter((personId) => !absentPeople.has(personId)), ...substitutions],
    slot.attendedPersonIds,
  );
};
