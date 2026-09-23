import { Schema } from "effect";
import { DepartmentId, PersonId, SemesterId } from "../organization/schema.js";
import { SchoolId } from "../schools/schema.js";
import { isIsoDate } from "../receipt/schema.js";

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
export const IsoServiceDate = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isIsoDate, { message: "a valid YYYY-MM-DD date" })),
);
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
const NonNegativeCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2_147_483_647)),
);
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
export const SchoolServiceCommitmentId = Schema.String.pipe(Schema.check(Schema.isPattern(/^school-service-commitment-[a-f0-9]{64}$/)));
export const SchoolServiceTime = Schema.String.pipe(Schema.check(Schema.isPattern(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)));
export const SchoolServiceEvidenceText = Schema.String.pipe(Schema.check(Schema.makeFilter((value) => value.trim().length > 0 && value.length <= 500, { message: "nonblank text of at most 500 characters" })));
export const SchoolServiceOccurrenceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^school-service-occurrence-[a-f0-9]{64}$/)),
);
export const SchoolServiceAbsenceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^school-service-absence-[a-f0-9]{64}$/)),
);
export const SchoolServiceSubstituteOfferId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^school-service-substitute-offer-[a-f0-9]{64}$/)),
);
export const SchoolServiceCoverageAcknowledgementId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^school-service-coverage-acknowledgement-[a-f0-9]{64}$/)),
);
export const SchoolServiceClosureId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^school-service-closure-[a-f0-9]{64}$/)),
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
export const SchoolServiceDecision = Schema.Struct({
  outcome: Schema.Literals(["Completed", "Cancelled", "Unfulfilled"]),
  decidedAt: Schema.String,
  decidedBy: PersonId,
  evidenceSource: SchoolServiceEvidenceText,
  reason: Schema.NullOr(SchoolServiceEvidenceText),
  attendedPersonIds: Schema.Array(PersonId),
  occurrenceId: Schema.NullOr(SchoolServiceOccurrenceId),
});
export const SchoolServiceCommitment = Schema.Struct({
  commitmentId: SchoolServiceCommitmentId,
  proposalId: SchoolServiceProposalId,
  ...PlacementScope.fields,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
  serviceDate: IsoServiceDate,
  startTime: SchoolServiceTime,
  endTime: SchoolServiceTime,
  requiredVolunteers: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  assignments: Schema.Array(SchoolServiceProposalAssignment),
  createdAt: Schema.String,
  createdBy: PersonId,
  decision: Schema.NullOr(SchoolServiceDecision),
  overdue: Schema.Boolean,
});
export const SchoolServiceOccurrence = Schema.Struct({
  commitmentId: Schema.NullOr(SchoolServiceCommitmentId),
  occurrenceId: SchoolServiceOccurrenceId,
  proposalId: SchoolServiceProposalId,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
  occurredOn: IsoServiceDate,
  attendedPersonIds: Schema.Array(PersonId),
  recordedAt: Schema.String,
  recordedBy: PersonId,
});

export const SchoolServiceAbsence = Schema.Struct({
  absenceId: SchoolServiceAbsenceId,
  commitmentId: Schema.NullOr(SchoolServiceCommitmentId),
  proposalId: SchoolServiceProposalId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  personId: PersonId,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
  serviceDate: IsoServiceDate,
  reporterPersonId: PersonId,
  reportedAt: Schema.String,
});
export const SchoolServiceEligibilitySnapshot = Schema.Struct({
  applicationId: Schema.String,
  candidatePersonId: PersonId,
  activeAffiliation: Schema.Literal(true),
  activePool: Schema.Literal(true),
  weekdayAvailable: Schema.Literal(true),
  placementConflict: Schema.Literal(false),
  acknowledgedCoverageConflict: Schema.Literal(false),
  checkedAt: Schema.String,
});
export const SchoolServiceSubstituteOfferStatus = Schema.Literals([
  "Offered",
  "Accepted",
  "Declined",
  "Withdrawn",
  "Acknowledged",
]);
export const SchoolServiceSubstituteOffer = Schema.Struct({
  offerId: SchoolServiceSubstituteOfferId,
  absenceId: SchoolServiceAbsenceId,
  proposalId: SchoolServiceProposalId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  candidatePersonId: PersonId,
  candidateFirstName: Schema.String,
  candidateLastName: Schema.String,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
  serviceDate: IsoServiceDate,
  dispatcherPersonId: PersonId,
  dispatchedAt: Schema.String,
  status: SchoolServiceSubstituteOfferStatus,
  revision: Schema.Int,
  eligibilitySnapshot: SchoolServiceEligibilitySnapshot,
});
export const SchoolServiceOfferResponse = Schema.Struct({
  offerId: SchoolServiceSubstituteOfferId,
  absenceId: SchoolServiceAbsenceId,
  response: Schema.Literals(["Accept", "Decline"]),
  responderPersonId: PersonId,
  respondedAt: Schema.String,
});
export const SchoolServiceCoverageAcknowledgement = Schema.Struct({
  acknowledgementId: SchoolServiceCoverageAcknowledgementId,
  offerId: SchoolServiceSubstituteOfferId,
  absenceId: SchoolServiceAbsenceId,
  candidatePersonId: PersonId,
  acknowledgedByPersonId: PersonId,
  acknowledgedAt: Schema.String,
});
export const SchoolServiceClosure = Schema.Struct({
  closureId: SchoolServiceClosureId,
  absenceId: SchoolServiceAbsenceId,
  occurrenceId: Schema.NullOr(SchoolServiceOccurrenceId),
  scheduledPersonId: PersonId,
  outcome: Schema.Literals(["Covered", "Uncovered"]),
  acknowledgementId: Schema.NullOr(SchoolServiceCoverageAcknowledgementId),
  substitutePersonId: Schema.NullOr(PersonId),
  closedByPersonId: PersonId,
  closedAt: Schema.String,
});
export const SchoolServiceDispatchNotificationRequest = Schema.Struct({
  _tag: Schema.Literal("NotifySchoolServiceSubstituteOffer"),
  effectId: Schema.String,
  offerId: SchoolServiceSubstituteOfferId,
  absenceId: SchoolServiceAbsenceId,
  personId: PersonId,
  proposalId: SchoolServiceProposalId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
  serviceDate: IsoServiceDate,
  dispatchedAt: Schema.String,
});
export type SchoolServiceDispatchNotificationRequest =
  typeof SchoolServiceDispatchNotificationRequest.Type;
export const SchoolServiceDispatchNotification = Schema.Struct({
  effectId: Schema.String,
  offerId: SchoolServiceSubstituteOfferId,
  absenceId: SchoolServiceAbsenceId,
  personId: PersonId,
  status: Schema.Literals(["Pending", "Processing", "Delivered", "Failed", "Quarantined"]),
  attempts: NonNegativeCount,
  deliveredAt: Schema.NullOr(Schema.String),
  lastFailureTag: Schema.NullOr(Schema.String),
});
export const ConfirmedRosterSlot = Schema.Struct({
  proposalId: SchoolServiceProposalId,
  schoolId: SchoolId,
  schoolName: Schema.String,
  day: TeachingDay,
  block: TeachingBlock,
});
export const CoverageRosterAssignment = Schema.Struct({
  proposalId: SchoolServiceProposalId,
  ...SchoolServiceProposalAssignment.fields,
});
export const CoverageCandidate = Schema.Struct({
  absenceId: SchoolServiceAbsenceId,
  applicationId: Schema.String,
  personId: PersonId,
  firstName: Schema.String,
  lastName: Schema.String,
});
export const OwnCoverageView = Schema.Struct({
  ...PlacementScope.fields,
  personId: PersonId,
  rosterSlots: Schema.Array(ConfirmedRosterSlot),
  commitments: Schema.Array(SchoolServiceCommitment),
  absences: Schema.Array(SchoolServiceAbsence),
  offers: Schema.Array(SchoolServiceSubstituteOffer),
  responses: Schema.Array(SchoolServiceOfferResponse),
  dispatchNotifications: Schema.Array(SchoolServiceDispatchNotification),
});
export const CoverageBoard = Schema.Struct({
  ...PlacementScope.fields,
  rosterAssignments: Schema.Array(CoverageRosterAssignment),
  commitments: Schema.Array(SchoolServiceCommitment),
  absences: Schema.Array(SchoolServiceAbsence),
  candidates: Schema.Array(CoverageCandidate),
  offers: Schema.Array(SchoolServiceSubstituteOffer),
  responses: Schema.Array(SchoolServiceOfferResponse),
  acknowledgements: Schema.Array(SchoolServiceCoverageAcknowledgement),
  closures: Schema.Array(SchoolServiceClosure),
  dispatchNotifications: Schema.Array(SchoolServiceDispatchNotification),
  occurrences: Schema.Array(SchoolServiceOccurrence),
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
  commitments: Schema.Array(SchoolServiceCommitment),
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
export const OwnCoverageCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("ReportAbsence"),
    commitmentId: SchoolServiceCommitmentId,
  }),
  Schema.Struct({
    action: Schema.Literal("RespondToOffer"),
    offerId: SchoolServiceSubstituteOfferId,
    response: Schema.Literals(["Accept", "Decline"]),
  }),
]);
export const CoverageCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("ReportAbsenceForVolunteer"),
    personId: PersonId,
    commitmentId: SchoolServiceCommitmentId,
  }),
  Schema.Struct({
    action: Schema.Literal("DispatchSubstituteOffer"),
    absenceId: SchoolServiceAbsenceId,
    candidatePersonId: PersonId,
  }),
  Schema.Struct({
    action: Schema.Literal("WithdrawSubstituteOffer"),
    offerId: SchoolServiceSubstituteOfferId,
  }),
  Schema.Struct({
    action: Schema.Literal("AcknowledgeCoverage"),
    offerId: SchoolServiceSubstituteOfferId,
  }),
  Schema.Struct({ action: Schema.Literal("CompleteService"), commitmentId: SchoolServiceCommitmentId, attendedPersonIds: Schema.Array(PersonId), evidenceSource: SchoolServiceEvidenceText }),
  Schema.Struct({ action: Schema.Literal("CancelService"), commitmentId: SchoolServiceCommitmentId, reason: SchoolServiceEvidenceText, evidenceSource: SchoolServiceEvidenceText }),
  Schema.Struct({ action: Schema.Literal("MarkUnfulfilledService"), commitmentId: SchoolServiceCommitmentId, attendedPersonIds: Schema.Array(PersonId), reason: SchoolServiceEvidenceText, evidenceSource: SchoolServiceEvidenceText }),
]);
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
  Schema.Struct({ action: Schema.Literal("ScheduleService"), proposalId: SchoolServiceProposalId, schoolId: SchoolId, day: TeachingDay, block: TeachingBlock, serviceDate: IsoServiceDate, startTime: SchoolServiceTime, endTime: SchoolServiceTime }),
]);

export type PlacementScope = typeof PlacementScope.Type;
export type Affiliation = typeof Affiliation.Type;
export type Placement = typeof Placement.Type;
export type PlacementBoard = typeof PlacementBoard.Type;
export type SchoolServiceCommitment = typeof SchoolServiceCommitment.Type;
export type SchoolServiceDecision = typeof SchoolServiceDecision.Type;
export type SchoolServiceDemand = typeof SchoolServiceDemand.Type;
export type SchoolServiceProposal = typeof SchoolServiceProposal.Type;
export type SchoolServiceProposalAssignment = typeof SchoolServiceProposalAssignment.Type;
export type SchoolServiceProposalException = typeof SchoolServiceProposalException.Type;
export type SchoolServiceAbsence = typeof SchoolServiceAbsence.Type;
export type SchoolServiceEligibilitySnapshot = typeof SchoolServiceEligibilitySnapshot.Type;
export type SchoolServiceSubstituteOffer = typeof SchoolServiceSubstituteOffer.Type;
export type SchoolServiceOfferResponse = typeof SchoolServiceOfferResponse.Type;
export type SchoolServiceCoverageAcknowledgement = typeof SchoolServiceCoverageAcknowledgement.Type;
export type SchoolServiceClosure = typeof SchoolServiceClosure.Type;
export type SchoolServiceDispatchNotification = typeof SchoolServiceDispatchNotification.Type;
export type ConfirmedRosterSlot = typeof ConfirmedRosterSlot.Type;
export type CoverageRosterAssignment = typeof CoverageRosterAssignment.Type;
export type CoverageCandidate = typeof CoverageCandidate.Type;
export type OwnCoverageView = typeof OwnCoverageView.Type;
export type CoverageBoard = typeof CoverageBoard.Type;
export type PlacementCommand = typeof PlacementCommand.Type;
export type OwnAffiliationCommand = typeof OwnAffiliationCommand.Type;
export type OwnCoverageCommand = typeof OwnCoverageCommand.Type;
export type CoverageCommand = typeof CoverageCommand.Type;
