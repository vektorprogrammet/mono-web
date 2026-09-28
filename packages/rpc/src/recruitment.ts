/**
 * Recruitment: applicant assignment, interview scheduling and conduct, invitation responses, and
 * maintenance of questionnaires and interview staffing.
 *
 * @since 0.3.0
 */
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import {
  CancelInterviewObservationSchema,
  FinalizeInterviewObservationSchema,
  InterviewRecommendationSchema,
  InterviewReport,
  InterviewReportQuery,
  InterviewSchemaId,
  InterviewStaffingManagement,
  QuestionnaireManagement,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterviewId,
  RecruitmentInterviewQuestionKindSchema,
  RecruitmentInterviewQuestionSnapshot,
  RecruitmentInterviewerOptionSchema,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
  RecruitmentSchedulingBoardSchema,
  RecruitmentSchedulingInterviewSchema,
  type RecruitmentAssignmentBoard,
  type RecruitmentAssignmentBoardQuery,
  type RecruitmentInterviewConductObservation,
  type RecruitmentSchedulingInterview,
} from "@vektorprogrammet/domain/recruitment";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { invitationNativeAccess, personNativeAccess, withAccessSpec } from "./access.js";
import { InvitationCapabilityCredential, PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";
import {
  CancelInterviewResponse,
  CorrectInterviewAssessmentRequest,
  CorrectInterviewAssessmentResponse,
  CreateApplicationInterviewRequest,
  FinalizeInterviewRequest,
  FinalizeInterviewResponse,
  RecruitmentInterviewResource,
  ScheduleInterviewRequest,
  ScheduleInterviewResponse,
} from "./v2-schemas.js";

export {
  CancelInterviewObservationSchema,
  FinalizeInterviewObservationSchema,
  InterviewRecommendationSchema,
  InterviewReport,
  InterviewReportQuery,
  InterviewSchemaId,
  InterviewStaffingManagement,
  QuestionnaireManagement,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterviewId,
  RecruitmentInterviewQuestionKindSchema,
  RecruitmentInterviewQuestionSnapshot,
  RecruitmentInterviewerOptionSchema,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
  RecruitmentSchedulingInterviewSchema,
};

export type {
  RecruitmentAssignmentBoard,
  RecruitmentAssignmentBoardQuery,
  RecruitmentInterviewConductObservation,
  RecruitmentSchedulingInterview,
};

/** Interview invitation state visible to the invitee. */
export const InvitationResponseObservation = RecruitmentInvitationResponseObservationSchema.annotate(
  { identifier: "InvitationResponseObservation" },
);

/**
 * The invitation beside its strong entity tag, which a response takes as `ifMatch`. A response to
 * a pending invitation must name the current tag.
 */
export const InvitationResponseResource = Schema.Struct({
  observation: InvitationResponseObservation,
  etag: StrongETag,
}).annotate({ identifier: "InvitationResponseResource" });

export type InvitationResponseResource = typeof InvitationResponseResource.Type;

/** The entity tag of the invitation after a response. */
export const InvitationResponseReceipt = Schema.Struct({ etag: StrongETag }).annotate({
  identifier: "InvitationResponseReceipt",
});

/**
 * The response capability of an invitation. It travels in the payload, and the handler decodes it:
 * a malformed or empty capability names no invitation, and answers resource.not-found like an
 * unknown one.
 */
export const InvitationCapabilityPayload = Schema.String.annotate({
  identifier: "InvitationCapabilityPayload",
});

/** Candidates and interviewers in the departments where the caller manages interviews. */
export const AssignmentBoard = RecruitmentAssignmentBoardSchema.annotate({
  identifier: "AssignmentBoard",
});

/** One interview with the strong entity tag that `recruitment.scheduleInterview` takes. */
export const SchedulingInterview = RecruitmentSchedulingInterviewSchema.mapMembers((members) => [
  members[0].mapFields((fields) => ({ ...fields, etag: StrongETag })),
  members[1].mapFields((fields) => ({ ...fields, etag: StrongETag })),
  members[2].mapFields((fields) => ({ ...fields, etag: StrongETag })),
  members[3].mapFields((fields) => ({ ...fields, etag: StrongETag })),
]).annotate({ identifier: "SchedulingInterview" });

/** Interviews visible to the current member. */
export const SchedulingBoard = Schema.Struct({
  departmentId: RecruitmentSchedulingBoardSchema.fields.departmentId,
  interviews: Schema.Array(SchedulingInterview),
}).annotate({ identifier: "SchedulingBoard" });

export type SchedulingBoard = typeof SchedulingBoard.Type;

/** Interview questions, answers, and conduct state. */
export const ConductObservation = RecruitmentInterviewConductObservationSchema.annotate({
  identifier: "ConductObservation",
});

/**
 * The conduct of one interview beside the strong entity tag that finalization, correction, and
 * cancellation take as `ifMatch`.
 */
export const InterviewConductResource = Schema.Struct({
  detail: ConductObservation,
  etag: StrongETag,
}).annotate({ identifier: "InterviewConductResource" });

export type InterviewConductResource = typeof InterviewConductResource.Type;

/** The assigned interview beside the entity tag that `recruitment.scheduleInterview` takes. */
export const ApplicationInterviewResource = Schema.Struct({
  interview: RecruitmentInterviewResource,
  etag: StrongETag,
}).annotate({ identifier: "ApplicationInterviewResource" });

export type ApplicationInterviewResource = typeof ApplicationInterviewResource.Type;

/** A committed schedule beside the interview's new entity tag. */
export const ScheduleInterviewResult = Schema.Struct({
  result: ScheduleInterviewResponse,
  etag: StrongETag,
}).annotate({ identifier: "ScheduleInterviewResult" });

export type ScheduleInterviewResult = typeof ScheduleInterviewResult.Type;

/** A committed finalization beside the interview's new entity tag. */
export const FinalizeInterviewResult = Schema.Struct({
  result: FinalizeInterviewResponse,
  etag: StrongETag,
}).annotate({ identifier: "FinalizeInterviewResult" });

export type FinalizeInterviewResult = typeof FinalizeInterviewResult.Type;

/** A committed correction beside the interview's new entity tag. */
export const CorrectInterviewAssessmentResult = Schema.Struct({
  result: CorrectInterviewAssessmentResponse,
  etag: StrongETag,
}).annotate({ identifier: "CorrectInterviewAssessmentResult" });

export type CorrectInterviewAssessmentResult = typeof CorrectInterviewAssessmentResult.Type;

/** A committed cancellation beside the interview's new entity tag. */
export const CancelInterviewResult = Schema.Struct({
  result: CancelInterviewResponse,
  etag: StrongETag,
}).annotate({ identifier: "CancelInterviewResult" });

export type CancelInterviewResult = typeof CancelInterviewResult.Type;

/** Problems of `recruitment.readInvitationResponse`. */
export const ReadInvitationResponseProblem = problemUnion(
  "ReadInvitationResponseProblem",
  ["resource.not-found", "internal.error", "recruitment.unavailable"],
);

const invitationResponseCodes = [
  "authority.denied",
  "resource.not-found",
  "precondition.failed",
  "internal.error",
  "dependency.unavailable",
  "invitation.already-responded",
] as const;

/** Problems of `recruitment.confirmInvitation`. */
export const ConfirmInvitationProblem = problemUnion(
  "ConfirmInvitationProblem",
  invitationResponseCodes,
);

/** Problems of `recruitment.rejectInvitation`. */
export const RejectInvitationProblem = problemUnion(
  "RejectInvitationProblem",
  invitationResponseCodes,
);

/** Problems of `recruitment.requestNewInvitationTime`. */
export const RequestNewInvitationTimeProblem = problemUnion(
  "RequestNewInvitationTimeProblem",
  invitationResponseCodes,
);

/** Problems of `recruitment.readAssignmentBoard`. */
export const ReadAssignmentBoardProblem = problemUnion(
  "ReadAssignmentBoardProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "internal.error",
    "recruitment.admission-period-not-found",
    "application.ambiguous-period",
    "recruitment.unavailable",
  ],
);

/** Problems of `recruitment.readSchedulingBoard`. */
export const ReadSchedulingBoardProblem = problemUnion(
  "ReadSchedulingBoardProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "internal.error",
    "recruitment.unavailable",
  ],
);

/** Problems of `recruitment.readInterviewReport`. */
export const ReadInterviewReportProblem = problemUnion(
  "ReadInterviewReportProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "transaction.conflict",
    "internal.error",
    "recruitment.unavailable",
  ],
);

const interviewCommandCodes = [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "dependency.unavailable",
  "idempotency.unavailable",
] as const;

/** Problems of `recruitment.createApplicationInterview`. */
export const CreateApplicationInterviewProblem = problemUnion(
  "CreateApplicationInterviewProblem",
  [
    ...interviewCommandCodes,
    "recruitment.admission-period-not-found",
    "recruitment.application-not-found",
    "application.ambiguous-period",
    "recruitment.interview-schema-not-found",
    "recruitment.application-already-assigned",
    "recruitment.interview-schema-inactive",
  ],
);

/** Problems of `recruitment.scheduleInterview`. */
export const ScheduleInterviewProblem = problemUnion(
  "ScheduleInterviewProblem",
  [
    ...interviewCommandCodes,
    "precondition.failed",
    "recruitment.interview-not-found",
    "recruitment.already-scheduled",
    "recruitment.schedule-in-past",
  ],
);

/** Problems of `recruitment.readInterviewConduct`. */
export const ReadInterviewConductProblem = problemUnion(
  "ReadInterviewConductProblem",
  [
    "credential.missing",
    "credential.invalid",
    "authority.denied",
    "internal.error",
    "recruitment.interview-not-found",
    "recruitment.interview-not-scheduled",
    "recruitment.invitation-not-accepted",
    "recruitment.unavailable",
  ],
);

const conductCommandCodes = [
  ...interviewCommandCodes,
  "precondition.failed",
  "recruitment.interview-not-found",
  "recruitment.already-finalized",
  "recruitment.already-cancelled",
  "recruitment.interview-not-scheduled",
] as const;

/** Problems of `recruitment.finalizeInterview`. */
export const FinalizeInterviewProblem = problemUnion(
  "FinalizeInterviewProblem",
  [...conductCommandCodes, "recruitment.invitation-not-accepted", "recruitment.conduct-invalid"],
);

/** Problems of `recruitment.correctInterviewAssessment`. */
export const CorrectInterviewAssessmentProblem = problemUnion(
  "CorrectInterviewAssessmentProblem",
  [...conductCommandCodes, "recruitment.invitation-not-accepted", "recruitment.conduct-invalid"],
);

/** Problems of `recruitment.cancelInterview`. */
export const CancelInterviewProblem = problemUnion(
  "CancelInterviewProblem",
  conductCommandCodes,
);

/** Problems of the maintenance reads and command, which share one vocabulary. */
export const RecruitmentMaintenanceProblem = problemUnion("RecruitmentMaintenanceProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "resource.not-found",
  "precondition.failed",
  "recruitment.invalid-command",
  "recruitment.ineligible",
  "recruitment.empty-active-questionnaire",
  "recruitment.terminal",
  "recruitment.unavailable",
  "idempotency.unavailable",
  "internal.error",
]);

/** Reads an interview invitation by its response capability. */
export const ReadInvitationResponse = Rpc.make("recruitment.readInvitationResponse", {
  payload: Schema.Struct({ capability: InvitationCapabilityPayload }),
  success: InvitationResponseResource,
  error: rpcProblems(ReadInvitationResponseProblem),
})
  .middleware(InvitationCapabilityCredential)
  .pipe(withAccessSpec(invitationNativeAccess([], "SnapshotRead")));

/** Accepts an interview invitation by its response capability. */
export const ConfirmInvitation = Rpc.make("recruitment.confirmInvitation", {
  payload: Schema.Struct({ capability: InvitationCapabilityPayload, ifMatch: StrongETag }),
  success: InvitationResponseReceipt,
  error: rpcProblems(ConfirmInvitationProblem),
})
  .middleware(InvitationCapabilityCredential)
  .pipe(withAccessSpec(invitationNativeAccess([], "Transaction")));

/** Rejects an interview invitation by its response capability, with an optional message. */
export const RejectInvitation = Rpc.make("recruitment.rejectInvitation", {
  payload: Schema.Struct({
    capability: InvitationCapabilityPayload,
    ifMatch: StrongETag,
    request: RecruitmentInvitationRejectInputSchema,
  }),
  success: InvitationResponseReceipt,
  error: rpcProblems(RejectInvitationProblem),
})
  .middleware(InvitationCapabilityCredential)
  .pipe(withAccessSpec(invitationNativeAccess([], "Transaction")));

/** Asks for another interview time by the invitation's response capability. */
export const RequestNewInvitationTime = Rpc.make("recruitment.requestNewInvitationTime", {
  payload: Schema.Struct({
    capability: InvitationCapabilityPayload,
    ifMatch: StrongETag,
    request: RecruitmentInvitationRequestNewTimeInputSchema,
  }),
  success: InvitationResponseReceipt,
  error: rpcProblems(RequestNewInvitationTimeProblem),
})
  .middleware(InvitationCapabilityCredential)
  .pipe(withAccessSpec(invitationNativeAccess([], "Transaction")));

/** Applicants and interviewers where the caller manages interviews. */
export const ReadAssignmentBoard = Rpc.make("recruitment.readAssignmentBoard", {
  payload: RecruitmentAssignmentBoardQuerySchema,
  success: AssignmentBoard,
  error: rpcProblems(ReadAssignmentBoardProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "reviewApplicants",
        canonicalScopeResolver: "recruitment.application-assignments",
        requirements: ["organization.single-department-administrator"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Limited completed interview observations for an explicitly selected department admission
 * period; proven self assessments are excluded. Raw conduct access remains separate.
 */
export const ReadInterviewReport = Rpc.make("recruitment.readInterviewReport", {
  payload: InterviewReportQuery,
  success: InterviewReport,
  error: rpcProblems(ReadInterviewReportProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.read-interview-report",
        canonicalScopeResolver: "recruitment.interview-report",
        requirements: ["organization.single-department-administrator"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Interviews visible to the current member, each with the tag that scheduling names. */
export const ReadSchedulingBoard = Rpc.make("recruitment.readSchedulingBoard", {
  success: SchedulingBoard,
  error: rpcProblems(ReadSchedulingBoardProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.read-interviews",
        canonicalScopeResolver: "recruitment.interviews",
        requirements: ["organization.single-department-member"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Assigns, or replays by its idempotency key, an applicant to an eligible interviewer. */
export const CreateApplicationInterview = Rpc.make("recruitment.createApplicationInterview", {
  payload: Schema.Struct({
    applicationId: PublicApplicationIdSchema,
    idempotencyKey: IdempotencyKey,
    request: CreateApplicationInterviewRequest,
  }),
  success: ApplicationInterviewResource,
  error: rpcProblems(CreateApplicationInterviewProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "reviewApplicants",
        canonicalScopeResolver: "recruitment.application-by-id",
        requirements: [
          "organization.single-department-administrator",
          "recruitment.interviewer-eligible",
        ],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Schedules, or replays by its idempotency key, an assigned interview and its invitation. */
export const ScheduleInterview = Rpc.make("recruitment.scheduleInterview", {
  payload: Schema.Struct({
    interviewId: RecruitmentInterviewId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: ScheduleInterviewRequest,
  }),
  success: ScheduleInterviewResult,
  error: rpcProblems(ScheduleInterviewProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.schedule-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: ["recruitment.assigned-interviewer-or-administrator"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** The questions and conduct state of one interview, with the tag that its commands take. */
export const ReadInterviewConduct = Rpc.make("recruitment.readInterviewConduct", {
  payload: Schema.Struct({ interviewId: RecruitmentInterviewId }),
  success: InterviewConductResource,
  error: rpcProblems(ReadInterviewConductProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.conduct-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: [
          "recruitment.assigned-interviewer-or-co-interviewer",
          "recruitment.not-known-self",
        ],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Records, or replays by its idempotency key, the answers and scores of an interview. */
export const FinalizeInterview = Rpc.make("recruitment.finalizeInterview", {
  payload: Schema.Struct({
    interviewId: RecruitmentInterviewId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: FinalizeInterviewRequest,
  }),
  success: FinalizeInterviewResult,
  error: rpcProblems(FinalizeInterviewProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.conduct-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: ["recruitment.assigned-interviewer", "recruitment.not-known-self"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Appends, or replays by its idempotency key, a replacement assessment of a completed interview. */
export const CorrectInterviewAssessment = Rpc.make("recruitment.correctInterviewAssessment", {
  payload: Schema.Struct({
    interviewId: RecruitmentInterviewId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: CorrectInterviewAssessmentRequest,
  }),
  success: CorrectInterviewAssessmentResult,
  error: rpcProblems(CorrectInterviewAssessmentProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.conduct-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: [
          "recruitment.assigned-interviewer-or-co-interviewer",
          "recruitment.not-known-self",
        ],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Cancels, or replays by its idempotency key, an interview before finalization. */
export const CancelInterview = Rpc.make("recruitment.cancelInterview", {
  payload: Schema.Struct({
    interviewId: RecruitmentInterviewId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
  }),
  success: CancelInterviewResult,
  error: rpcProblems(CancelInterviewProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.conduct-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: ["recruitment.assigned-interviewer", "recruitment.not-known-self"],
        decisionTime: "Transaction",
      }),
    ),
  );

/**
 * Global questionnaire definitions and immutable maintenance history, for a current global
 * administrator.
 */
export const ReadQuestionnaires = Rpc.make("recruitment.readQuestionnaires", {
  success: QuestionnaireManagement,
  error: rpcProblems(RecruitmentMaintenanceProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.maintain",
        canonicalScopeResolver: "recruitment.maintenance",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Interviews, eligible candidates, and staffing history in the current coordinator scope. */
export const ReadInterviewStaffing = Rpc.make("recruitment.readInterviewStaffing", {
  success: InterviewStaffingManagement,
  error: rpcProblems(RecruitmentMaintenanceProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.maintain",
        canonicalScopeResolver: "recruitment.maintenance",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Creates or revises a questionnaire, or replaces a nonterminal interview staffing pair with an
 * observed revision and reason. The command's `commandId` must equal its idempotency key.
 */
export const MaintainRecruitment = Rpc.make("recruitment.maintainRecruitment", {
  payload: Schema.Struct({
    idempotencyKey: IdempotencyKey,
    request: RecruitmentMaintenanceCommand,
  }),
  success: RecruitmentMaintenanceResult,
  error: rpcProblems(RecruitmentMaintenanceProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "recruitment.maintain",
        canonicalScopeResolver: "recruitment.maintenance",
        decisionTime: "Transaction",
      }),
    ),
  );

export class RecruitmentRpcs extends RpcGroup.make(
  ReadInvitationResponse,
  ConfirmInvitation,
  RejectInvitation,
  RequestNewInvitationTime,
  ReadAssignmentBoard,
  ReadSchedulingBoard,
  ReadInterviewReport,
  CreateApplicationInterview,
  ScheduleInterview,
  ReadInterviewConduct,
  FinalizeInterview,
  CorrectInterviewAssessment,
  CancelInterview,
  ReadQuestionnaires,
  ReadInterviewStaffing,
  MaintainRecruitment,
) {}
