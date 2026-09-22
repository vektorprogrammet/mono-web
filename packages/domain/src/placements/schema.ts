import { Schema } from "effect";
import { DepartmentId, PersonId, SemesterId } from "../organization/schema.js";
import { SchoolId } from "../schools/schema.js";

export const PlacementScope = Schema.Struct({ departmentId: DepartmentId, semesterId: SemesterId });
export const AffiliationScope = Schema.Struct({ departmentId: DepartmentId });
export const AffiliationStatus = Schema.Literals(["Absent", "Pending", "Active", "Inactive"]);
export const Affiliation = Schema.Struct({
  personId: PersonId,
  departmentId: DepartmentId,
  status: AffiliationStatus,
  revision: Schema.Int,
});
export const TeachingDay = Schema.Literals([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
]);
export const TeachingBlock = Schema.Literals(["1", "2"]);
export const PlacementValues = Schema.Struct({
  schoolId: SchoolId,
  day: TeachingDay,
  workdays: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
  block: Schema.Literals(["1", "2", "Both"]),
});
export const PlacementId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^placement-[a-f0-9]{64}$/)),
);
export const Placement = Schema.Struct({
  ...PlacementScope.fields,
  ...PlacementValues.fields,
  placementId: PlacementId,
  personId: PersonId,
  active: Schema.Boolean,
  revision: Schema.Int,
  firstName: Schema.String,
  lastName: Schema.String,
  schoolName: Schema.String,
});
const NonNegativeCount = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
export const SchoolServiceDemand = Schema.Struct({
  schoolId: SchoolId,
  day: TeachingDay,
  block: TeachingBlock,
  requiredVolunteers: NonNegativeCount,
  revision: Schema.Int,
});
export const SchoolServiceProposalId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^school-service-proposal-[a-f0-9]{64}$/)),
);
export const SchoolServiceOccurrenceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^school-service-occurrence-[a-f0-9]{64}$/)),
);
export const SchoolServiceProposalAssignment = Schema.Struct({
  placementId: PlacementId,
  personId: PersonId,
  firstName: Schema.String,
  lastName: Schema.String,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
});
export const SchoolServiceExceptionCode = Schema.Literals([
  "DemandUnfilled",
  "DemandExceeded",
  "AssignmentWithoutDemand",
]);
export const SchoolServiceProposalException = Schema.Struct({
  exceptionId: Schema.String,
  code: SchoolServiceExceptionCode,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
  requiredVolunteers: NonNegativeCount,
  assignedVolunteers: NonNegativeCount,
});
export const SchoolServiceProposal = Schema.Struct({
  proposalId: SchoolServiceProposalId,
  status: Schema.Literals(["Draft", "Confirmed"]),
  revision: Schema.Int,
  createdAt: Schema.String,
  createdBy: PersonId,
  confirmedAt: Schema.NullOr(Schema.String),
  confirmedBy: Schema.NullOr(PersonId),
  demands: Schema.Array(SchoolServiceDemand),
  assignments: Schema.Array(SchoolServiceProposalAssignment),
  exceptions: Schema.Array(SchoolServiceProposalException),
  reviewedExceptionIds: Schema.Array(Schema.String),
});
export const SchoolServiceNotificationRequest = Schema.Struct({
  _tag: Schema.Literal("NotifySchoolServiceRosterConfirmed"),
  effectId: Schema.String,
  proposalId: SchoolServiceProposalId,
  personId: PersonId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  assignments: Schema.Array(SchoolServiceProposalAssignment),
  confirmedAt: Schema.String,
});
export type SchoolServiceNotificationRequest = typeof SchoolServiceNotificationRequest.Type;
export const SchoolServiceNotification = Schema.Struct({
  effectId: Schema.String,
  proposalId: SchoolServiceProposalId,
  personId: PersonId,
  status: Schema.Literals(["Pending", "Processing", "Delivered", "Failed", "Quarantined"]),
  attempts: NonNegativeCount,
  deliveredAt: Schema.NullOr(Schema.String),
  lastFailureTag: Schema.NullOr(Schema.String),
});
export const SchoolServiceOccurrence = Schema.Struct({
  occurrenceId: SchoolServiceOccurrenceId,
  proposalId: SchoolServiceProposalId,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
  occurredOn: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
  attendedPersonIds: Schema.Array(PersonId),
  recordedAt: Schema.String,
  recordedBy: PersonId,
});
export const PlacementBoard = Schema.Struct({
  ...PlacementScope.fields,
  affiliations: Schema.Array(
    Schema.Struct({ ...Affiliation.fields, firstName: Schema.String, lastName: Schema.String }),
  ),
  placements: Schema.Array(Placement),
  schools: Schema.Array(Schema.Struct({ schoolId: SchoolId, name: Schema.String })),
  demands: Schema.Array(SchoolServiceDemand),
  proposal: Schema.NullOr(SchoolServiceProposal),
  notifications: Schema.Array(SchoolServiceNotification),
  occurrences: Schema.Array(SchoolServiceOccurrence),
});
export const PlacementScopes = Schema.Struct({
  departments: Schema.Array(
    Schema.Struct({ departmentId: DepartmentId, name: Schema.String, canManage: Schema.Boolean }),
  ),
  semesters: Schema.Array(
    Schema.Struct({ semesterId: SemesterId, startAt: Schema.String, endAt: Schema.String }),
  ),
});
export const OwnAffiliationCommand = Schema.Struct({
  action: Schema.Literals(["Request", "Withdraw"]),
});
export const PlacementCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("Affiliation"),
    personId: PersonId,
    transition: Schema.Literals(["Establish", "Reject", "Revoke"]),
  }),
  Schema.Struct({
    action: Schema.Literal("Create"),
    personId: PersonId,
    ...PlacementValues.fields,
  }),
  Schema.Struct({
    action: Schema.Literal("Edit"),
    placementId: PlacementId,
    ...PlacementValues.fields,
  }),
  Schema.Struct({ action: Schema.Literal("Remove"), placementId: PlacementId }),
  Schema.Struct({
    action: Schema.Literal("SetDemand"),
    schoolId: SchoolId,
    day: TeachingDay,
    block: TeachingBlock,
    requiredVolunteers: NonNegativeCount,
  }),
  Schema.Struct({ action: Schema.Literal("GenerateProposal") }),
  Schema.Struct({
    action: Schema.Literal("ConfirmProposal"),
    proposalId: SchoolServiceProposalId,
    reviewedExceptionIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("RecordOccurrence"),
    proposalId: SchoolServiceProposalId,
    schoolId: SchoolId,
    day: TeachingDay,
    block: TeachingBlock,
    occurredOn: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
    attendedPersonIds: Schema.Array(PersonId),
  }),
]);
export type PlacementScope = typeof PlacementScope.Type;
export type Affiliation = typeof Affiliation.Type;
export type Placement = typeof Placement.Type;
export type PlacementBoard = typeof PlacementBoard.Type;
export type SchoolServiceDemand = typeof SchoolServiceDemand.Type;
export type SchoolServiceProposal = typeof SchoolServiceProposal.Type;
export type SchoolServiceProposalAssignment = typeof SchoolServiceProposalAssignment.Type;
export type SchoolServiceProposalException = typeof SchoolServiceProposalException.Type;
export type PlacementCommand = typeof PlacementCommand.Type;
export type OwnAffiliationCommand = typeof OwnAffiliationCommand.Type;
