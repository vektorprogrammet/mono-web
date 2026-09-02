/** Generated from the frozen 0080.1 endpoint-specific Problem Details table. */
import { problemUnion } from "./http-semantics.js";

/** Problems for `system.health`. */
export const SystemHealthProblem = problemUnion("SystemHealthProblem", [
  ["internal.error", 500],
  ["health.unavailable", 503],
]);

/** Problems for `system.readSession`. */
export const SystemReadSessionProblem = problemUnion("SystemReadSessionProblem", [
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["internal.error", 500],
  ["identity.unavailable", 503],
]);

/** Problems for `system.deleteSession`. */
export const SystemDeleteSessionProblem = problemUnion("SystemDeleteSessionProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
]);

/** Problems for `system.listSessions`. */
export const SystemListSessionsProblem = problemUnion("SystemListSessionsProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["internal.error", 500],
  ["identity.unavailable", 503],
]);

/** Problems for `system.deleteOwnedSession`. */
export const SystemDeleteOwnedSessionProblem = problemUnion("SystemDeleteOwnedSessionProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["resource.not-found", 404],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
]);

/** Problems for `system.revokeOtherSessions`. */
export const SystemRevokeOtherSessionsProblem = problemUnion("SystemRevokeOtherSessionsProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
]);

/** Problems for `system.revokeAllSessions`. */
export const SystemRevokeAllSessionsProblem = problemUnion("SystemRevokeAllSessionsProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
]);

/** Problems for `profile.readOwnProfile`. */
export const ProfileReadOwnProfileProblem = problemUnion("ProfileReadOwnProfileProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["internal.error", 500],
  ["profile.not-found", 404],
  ["profile.unavailable", 503],
]);

/** Problems for `profile.updateOwnProfile`. */
export const ProfileUpdateOwnProfileProblem = problemUnion("ProfileUpdateOwnProfileProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["validation.no-change", 422],
  ["validation.field-not-deletable", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["profile.not-found", 404],
  ["profile.unavailable", 503],
]);

/** Problems for `organization.listDepartments`. */
export const OrganizationListDepartmentsProblem = problemUnion(
  "OrganizationListDepartmentsProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["internal.error", 500],
    ["organization.unavailable", 503],
  ],
);

/** Problems for `organization.listTeams`. */
export const OrganizationListTeamsProblem = problemUnion("OrganizationListTeamsProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["internal.error", 500],
  ["organization.unavailable", 503],
]);

/** Problems for `organization.listFieldOfStudies`. */
export const OrganizationListFieldOfStudiesProblem = problemUnion(
  "OrganizationListFieldOfStudiesProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["internal.error", 500],
    ["organization.unavailable", 503],
  ],
);

/** Problems for `organization.listTeamInterest`. */
export const OrganizationListTeamInterestProblem = problemUnion(
  "OrganizationListTeamInterestProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["organization.invalid-reference", 422],
    ["organization.unavailable", 503],
  ],
);

/** Problems for `organization.listMailingLists`. */
export const OrganizationListMailingListsProblem = problemUnion(
  "OrganizationListMailingListsProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["organization.invalid-reference", 422],
    ["organization.unavailable", 503],
  ],
);

/** Problems for `organization.createDepartment`. */
export const OrganizationCreateDepartmentProblem = problemUnion(
  "OrganizationCreateDepartmentProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["organization.invalid-reference", 422],
  ],
);

/** Problems for `organization.createTeam`. */
export const OrganizationCreateTeamProblem = problemUnion("OrganizationCreateTeamProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["organization.invalid-reference", 422],
]);

/** Problems for `organization.createFieldOfStudy`. */
export const OrganizationCreateFieldOfStudyProblem = problemUnion(
  "OrganizationCreateFieldOfStudyProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["organization.invalid-reference", 422],
  ],
);

/** Problems for `directory.listPeople`. */
export const DirectoryListPeopleProblem = problemUnion("DirectoryListPeopleProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["internal.error", 500],
  ["directory.cursor-malformed", 422],
  ["directory.unavailable", 503],
]);

/** Problems for `directory.listSchools`. */
export const DirectoryListSchoolsProblem = problemUnion("DirectoryListSchoolsProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["internal.error", 500],
  ["schools.invalid-department", 422],
  ["schools.unavailable", 503],
]);

/** Problems for `admissions.listOpenAdmissionPeriods`. */
export const AdmissionsListOpenAdmissionPeriodsProblem = problemUnion(
  "AdmissionsListOpenAdmissionPeriodsProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["internal.error", 500],
    ["admissions.unavailable", 503],
  ],
);

/** Problems for `admissions.listApplicationOptions`. */
export const AdmissionsListApplicationOptionsProblem = problemUnion(
  "AdmissionsListApplicationOptionsProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["internal.error", 500],
    ["admissions.unavailable", 503],
  ],
);

/** Problems for `admissions.submitApplication`. */
export const AdmissionsSubmitApplicationProblem = problemUnion(
  "AdmissionsSubmitApplicationProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["application.no-eligible-period", 409],
    ["application.ambiguous-period", 409],
    ["application.duplicate", 409],
    ["application.invalid-field-of-study", 422],
    ["rate-limit.exceeded", 429],
  ],
);

/** Problems for `admissions.readApplicationConfirmation`. */
export const AdmissionsReadApplicationConfirmationProblem = problemUnion(
  "AdmissionsReadApplicationConfirmationProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["internal.error", 500],
    ["application.not-found", 404],
    ["admissions.unavailable", 503],
  ],
);

/** Problems for `admissions.listAdmissionPeriods`. */
export const AdmissionsListAdmissionPeriodsProblem = problemUnion(
  "AdmissionsListAdmissionPeriodsProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["admissions.unavailable", 503],
  ],
);

/** Problems for `admissions.createAdmissionPeriod`. */
export const AdmissionsCreateAdmissionPeriodProblem = problemUnion(
  "AdmissionsCreateAdmissionPeriodProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["admission-period.already-exists", 409],
    ["admission-period.invalid-window", 422],
  ],
);

/** Problems for `admissions.reviseAdmissionPeriod`. */
export const AdmissionsReviseAdmissionPeriodProblem = problemUnion(
  "AdmissionsReviseAdmissionPeriodProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["validation.no-change", 422],
    ["validation.field-not-deletable", 422],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["precondition.required", 428],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["admission-period.not-found", 404],
    ["admission-period.invalid-window", 422],
  ],
);

/** Problems for `recruitment.readInvitationResponse`. */
export const RecruitmentReadInvitationResponseProblem = problemUnion(
  "RecruitmentReadInvitationResponseProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["resource.not-found", 404],
    ["internal.error", 500],
    ["recruitment.unavailable", 503],
  ],
);

/** Problems for `recruitment.confirmInvitation`. */
export const RecruitmentConfirmInvitationProblem = problemUnion(
  "RecruitmentConfirmInvitationProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["resource.not-found", 404],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["precondition.required", 428],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["invitation.already-responded", 409],
  ],
);

/** Problems for `recruitment.rejectInvitation`. */
export const RecruitmentRejectInvitationProblem = problemUnion(
  "RecruitmentRejectInvitationProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["resource.not-found", 404],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["precondition.required", 428],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["invitation.already-responded", 409],
  ],
);

/** Problems for `recruitment.requestNewInvitationTime`. */
export const RecruitmentRequestNewInvitationTimeProblem = problemUnion(
  "RecruitmentRequestNewInvitationTimeProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["resource.not-found", 404],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["precondition.required", 428],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["invitation.already-responded", 409],
  ],
);

/** Problems for `recruitment.readAssignmentBoard`. */
export const RecruitmentReadAssignmentBoardProblem = problemUnion(
  "RecruitmentReadAssignmentBoardProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["recruitment.admission-period-not-found", 404],
    ["recruitment.unavailable", 503],
  ],
);

/** Problems for `recruitment.readSchedulingBoard`. */
export const RecruitmentReadSchedulingBoardProblem = problemUnion(
  "RecruitmentReadSchedulingBoardProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["recruitment.unavailable", 503],
  ],
);

/** Problems for `recruitment.createApplicationInterview`. */
export const RecruitmentCreateApplicationInterviewProblem = problemUnion(
  "RecruitmentCreateApplicationInterviewProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["recruitment.application-not-found", 404],
    ["recruitment.interview-schema-not-found", 404],
    ["recruitment.application-already-assigned", 409],
    ["recruitment.interview-schema-inactive", 422],
  ],
);

/** Problems for `recruitment.scheduleInterview`. */
export const RecruitmentScheduleInterviewProblem = problemUnion(
  "RecruitmentScheduleInterviewProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["precondition.required", 428],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["recruitment.interview-not-found", 404],
    ["recruitment.already-scheduled", 409],
    ["recruitment.schedule-in-past", 422],
  ],
);

/** Problems for `recruitment.readInterviewConduct`. */
export const RecruitmentReadInterviewConductProblem = problemUnion(
  "RecruitmentReadInterviewConductProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["recruitment.interview-not-found", 404],
    ["recruitment.interview-not-scheduled", 409],
    ["recruitment.invitation-not-accepted", 409],
    ["recruitment.unavailable", 503],
  ],
);

/** Problems for `recruitment.finalizeInterview`. */
export const RecruitmentFinalizeInterviewProblem = problemUnion(
  "RecruitmentFinalizeInterviewProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["idempotency-key.invalid", 400],
    ["idempotency.in-flight", 409],
    ["idempotency.digest-conflict", 409],
    ["idempotency.response-expired", 409],
    ["request.too-large", 413],
    ["media-type.unsupported", 415],
    ["validation.failed", 422],
    ["precondition.invalid", 400],
    ["precondition.failed", 412],
    ["precondition.required", 428],
    ["internal.error", 500],
    ["dependency.unavailable", 503],
    ["idempotency.unavailable", 503],
    ["recruitment.interview-not-found", 404],
    ["recruitment.already-finalized", 409],
    ["recruitment.already-cancelled", 409],
    ["recruitment.interview-not-scheduled", 409],
    ["recruitment.invitation-not-accepted", 409],
    ["recruitment.conduct-invalid", 422],
  ],
);

/** Problems for `recruitment.cancelInterview`. */
export const RecruitmentCancelInterviewProblem = problemUnion("RecruitmentCancelInterviewProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["recruitment.interview-not-found", 404],
  ["recruitment.already-finalized", 409],
  ["recruitment.already-cancelled", 409],
]);

/** Problems for `receipts.submitReceipt`. */
export const ReceiptsSubmitReceiptProblem = problemUnion("ReceiptsSubmitReceiptProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["receipt.already-exists", 409],
  ["receipt.file-not-staged", 422],
]);

/** Problems for `receipts.reviseReceipt`. */
export const ReceiptsReviseReceiptProblem = problemUnion("ReceiptsReviseReceiptProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["validation.no-change", 422],
  ["validation.field-not-deletable", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["receipt.not-found", 404],
  ["receipt.invalid-transition", 409],
  ["receipt.file-not-staged", 422],
]);

/** Problems for `receipts.withdrawReceipt`. */
export const ReceiptsWithdrawReceiptProblem = problemUnion("ReceiptsWithdrawReceiptProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["receipt.not-found", 404],
  ["receipt.invalid-transition", 409],
]);

/** Problems for `receipts.listReceipts`. */
export const ReceiptsListReceiptsProblem = problemUnion("ReceiptsListReceiptsProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["internal.error", 500],
  ["receipts.unavailable", 503],
]);

/** Problems for `receipts.listReceiptsForApproval`. */
export const ReceiptsListReceiptsForApprovalProblem = problemUnion(
  "ReceiptsListReceiptsForApprovalProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["receipts.unavailable", 503],
  ],
);

/** Problems for `receipts.refundReceipt`. */
export const ReceiptsRefundReceiptProblem = problemUnion("ReceiptsRefundReceiptProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["receipt.not-found", 404],
  ["receipt.invalid-transition", 409],
]);

/** Problems for `receipts.rejectReceipt`. */
export const ReceiptsRejectReceiptProblem = problemUnion("ReceiptsRejectReceiptProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["receipt.not-found", 404],
  ["receipt.invalid-transition", 409],
]);

/** Problems for `content.readContentWorkspace`. */
export const ContentReadContentWorkspaceProblem = problemUnion(
  "ContentReadContentWorkspaceProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["content.integrity-error", 500],
    ["content.unavailable", 503],
  ],
);

/** Problems for `content.createArticle`. */
export const ContentCreateArticleProblem = problemUnion("ContentCreateArticleProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["content.slug-conflict", 422],
  ["content.department-not-found", 422],
  ["content.integrity-error", 500],
]);

/** Problems for `content.readArticle`. */
export const ContentReadArticleProblem = problemUnion("ContentReadArticleProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["internal.error", 500],
  ["content.article-not-found", 404],
  ["content.integrity-error", 500],
  ["content.unavailable", 503],
]);

/** Problems for `content.reviseArticle`. */
export const ContentReviseArticleProblem = problemUnion("ContentReviseArticleProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["validation.no-change", 422],
  ["validation.field-not-deletable", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["content.article-not-found", 404],
  ["content.slug-conflict", 422],
  ["content.department-not-found", 422],
  ["content.integrity-error", 500],
]);

/** Problems for `content.publishArticle`. */
export const ContentPublishArticleProblem = problemUnion("ContentPublishArticleProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["content.article-not-found", 404],
  ["content.lifecycle-conflict", 409],
  ["content.integrity-error", 500],
]);

/** Problems for `content.unpublishArticle`. */
export const ContentUnpublishArticleProblem = problemUnion("ContentUnpublishArticleProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["precondition.required", 428],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
  ["content.article-not-found", 404],
  ["content.lifecycle-conflict", 409],
  ["content.integrity-error", 500],
]);

/** Problems for `content.listNews`. */
export const ContentListNewsProblem = problemUnion("ContentListNewsProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["internal.error", 500],
  ["content.integrity-error", 500],
  ["content.unavailable", 503],
]);

/** Problems for `content.readNewsArticle`. */
export const ContentReadNewsArticleProblem = problemUnion("ContentReadNewsArticleProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["precondition.invalid", 400],
  ["precondition.failed", 412],
  ["internal.error", 500],
  ["content.article-not-found", 404],
  ["content.integrity-error", 500],
  ["content.unavailable", 503],
]);

/** Problems for `internal.readReceiptEvidence`. */
export const InternalReadReceiptEvidenceProblem = problemUnion(
  "InternalReadReceiptEvidenceProblem",
  [
    ["request.malformed", 400],
    ["header.malformed", 400],
    ["credential.missing", 401],
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["origin.denied", 403],
    ["internal.error", 500],
    ["receipt.not-found", 404],
    ["receipts.unavailable", 503],
  ],
);
