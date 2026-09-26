import { Result, Array, Predicate, Data } from "effect";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  type OrganizationPersonAuthority,
} from "../organization/index.js";
import type { DepartmentId, PersonId } from "../organization/index.js";
import type { SchoolId } from "../schools/index.js";
import type {
  Affiliation,
  OwnAffiliationCommand,
  PlacementBoard,
  SchoolServiceAbsence,
  SchoolServiceCommitment,
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
    | "commitment.target-invalid"
    | "commitment.duplicate"
    | "commitment.closed"
    | "commitment.attendance-invalid"
    | "commitment.outcome-invalid"
    | "commitment.pending-offer"
    | "commitment.interval-invalid"
    | "absence.target-invalid"
    | "absence.duplicate"
    | "offer.candidate-ineligible"
    | "offer.unresolved"
    | "offer.owner-invalid"
    | "offer.response-invalid"
    | "offer.withdraw-invalid"
    | "coverage.acknowledgement-invalid";
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

  return Predicate.isTagged(decision, "Allow") && !Predicate.isTagged(decision.value, "Member");
};

/** Returns the next status, or null for a rejected transition. Does not authorize or persist a change. */
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

/** Actual attendees may be fewer than eligible people, but never include an absent scheduled person or an unacknowledged substitute. */
export const isEligibleSchoolServiceAttendance = (
  commitment: SchoolServiceCommitment,
  absences: ReadonlyArray<SchoolServiceAbsence>,
  acknowledgements: ReadonlyArray<SchoolServiceCoverageAcknowledgement>,
  attendees: ReadonlyArray<PersonId>,
): boolean => {
  if (new Set(attendees).size !== attendees.length) return false;
  const absentIds = new Set(absences.map((absence) => absence.personId));

  const eligible = new Set([
    ...Array.filterMap(commitment.assignments, (assignment) =>
      !absentIds.has(assignment.personId) ? Result.succeed(assignment.personId) : Result.failVoid,
    ),
    ...acknowledgements.map((acknowledgement) => acknowledgement.candidatePersonId),
  ]);

  return attendees.every((personId) => eligible.has(personId));
};
