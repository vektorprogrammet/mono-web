import { Capability, Concealment, Http, Operation } from "@effx/runtime";
import { HttpApiSchema } from "effect/unstable/httpapi";
import { ExternalNativeApi } from "./api.js";
import {
  InvitationCapabilitySecurity,
  nativeOperationAnnotations,
  PersonSecurity,
} from "./common.js";
import {
  RecruitmentCancelInterviewCodes,
  RecruitmentConfirmInvitationCodes,
  RecruitmentCorrectInterviewAssessmentCodes,
  RecruitmentCreateApplicationInterviewCodes,
  RecruitmentFinalizeInterviewCodes,
  RecruitmentMaintenanceCodes,
  RecruitmentReadAssignmentBoardCodes,
  RecruitmentReadInterviewConductCodes,
  RecruitmentReadInterviewReportCodes,
  RecruitmentReadInvitationResponseCodes,
  RecruitmentReadSchedulingBoardCodes,
  RecruitmentRejectInvitationCodes,
  RecruitmentRequestNewInvitationTimeCodes,
  RecruitmentScheduleInterviewCodes,
  nativeProblems,
} from "./endpoint-problems.js";
import {
  ConditionalReadHeaders,
  CreatedMutationResponseHeaders,
  EntityMutationResponseHeaders,
  IdempotencyHeaders,
  IdempotencyIfMatchHeaders,
  IfMatchHeaders,
  PrivateReadResponseHeaders,
  ProfileReadResponseHeaders,
} from "./http-semantics.js";
import {
  RecruitmentApplicationByIdResolver,
  RecruitmentAssignmentBoardResolver,
  RecruitmentInterviewByIdResolver,
  RecruitmentInterviewReportResolver,
  RecruitmentInvitationByCapabilityResolver,
  RecruitmentMaintenanceResolver,
  RecruitmentSchedulingBoardResolver,
  invitationCommandAccessAnnotations,
  invitationReadAccessAnnotations,
  recruitmentCommandAccessAnnotations,
  recruitmentReadAccessAnnotations,
} from "./recruitment-effx-adapters.js";
import {
  AssignmentBoard,
  ConductObservation,
  ConfirmInvitationPayload,
  EmptyRecruitmentInput,
  InterviewReport,
  InterviewReportQuery,
  InterviewStaffingManagement,
  InvitationRejectInput,
  InvitationRequestNewTimeInput,
  InvitationResponseObservation,
  QuestionnaireManagement,
  RecruitmentApplicationParams,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentInterviewParams,
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
  SchedulingBoard,
} from "./recruitment.js";
import {
  CancelInterviewRequest,
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

/** Only facts shared by all sixteen operations belong in the group defaults. */
export const RecruitmentGroup = Http.group({
  root: ExternalNativeApi,
  group: "recruitment",
  title: "Recruitment",
  description: "Applicant assignment, interview scheduling, conduct, and invitation response.",
  defaults: {
    metadata: { annotator: nativeOperationAnnotations },
    problems: { registry: nativeProblems },
    access: { exposure: "External" },
  },
});

export const ReadInvitationResponse = Operation.query({
  name: "recruitment.readInvitationResponse",
  input: EmptyRecruitmentInput,
  success: InvitationResponseObservation,
})
  .in(RecruitmentGroup)
  .http.get("/api/recruitment/invitation-response")
  .http.contract({
    headers: ConditionalReadHeaders,
    responseHeaders: ProfileReadResponseHeaders,
    conditional: true,
    middleware: [InvitationCapabilitySecurity],
    metadata: {
      summary: "Read invitation response",
      description: "Reads an interview invitation by capability.",
    },
  })
  .http.problems({
    identifier: "RecruitmentReadInvitationResponseProblem",
    codes: RecruitmentReadInvitationResponseCodes,
  })
  .http.access({
    annotator: invitationReadAccessAnnotations,
    acceptedCredentials: ["ObjectCapability"],
    principalKinds: ["CapabilityHolder"],
    capabilities: Capability.one("recruitment.invitation-response"),
    requirements: [],
    canonicalScopeResolver: RecruitmentInvitationByCapabilityResolver,
    concealment: Concealment.notFound(
      "CredentialFailure",
      "PrincipalKind",
      "Capability",
      "Scope",
      "Requirement",
    ),
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ConfirmInvitation = Operation.command({
  name: "recruitment.confirmInvitation",
  input: ConfirmInvitationPayload,
  success: HttpApiSchema.NoContent,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/invitation-response:confirm")
  .http.contract({
    params: EmptyRecruitmentInput,
    headers: IfMatchHeaders,
    payload: ConfirmInvitationPayload,
    status: 204,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [InvitationCapabilitySecurity],
    metadata: {
      summary: "Confirm invitation",
      description: "Accepts an interview invitation by capability.",
    },
  })
  .http.problems({
    identifier: "RecruitmentConfirmInvitationProblem",
    codes: RecruitmentConfirmInvitationCodes,
  })
  .http.access({
    annotator: invitationCommandAccessAnnotations,
    acceptedCredentials: ["ObjectCapability"],
    principalKinds: ["CapabilityHolder"],
    capabilities: Capability.one("recruitment.invitation-response"),
    requirements: [],
    canonicalScopeResolver: RecruitmentInvitationByCapabilityResolver,
    concealment: Concealment.notFound(
      "CredentialFailure",
      "PrincipalKind",
      "Capability",
      "Scope",
      "Requirement",
    ),
    decisionTime: "Transaction",
  })
  .declare();

export const RejectInvitation = Operation.command({
  name: "recruitment.rejectInvitation",
  input: InvitationRejectInput,
  success: HttpApiSchema.NoContent,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/invitation-response:reject")
  .http.contract({
    params: EmptyRecruitmentInput,
    headers: IfMatchHeaders,
    payload: InvitationRejectInput,
    status: 204,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [InvitationCapabilitySecurity],
    metadata: {
      summary: "Reject invitation",
      description: "Rejects an interview invitation by capability.",
    },
  })
  .http.problems({
    identifier: "RecruitmentRejectInvitationProblem",
    codes: RecruitmentRejectInvitationCodes,
  })
  .http.access({
    annotator: invitationCommandAccessAnnotations,
    acceptedCredentials: ["ObjectCapability"],
    principalKinds: ["CapabilityHolder"],
    capabilities: Capability.one("recruitment.invitation-response"),
    requirements: [],
    canonicalScopeResolver: RecruitmentInvitationByCapabilityResolver,
    concealment: Concealment.notFound(
      "CredentialFailure",
      "PrincipalKind",
      "Capability",
      "Scope",
      "Requirement",
    ),
    decisionTime: "Transaction",
  })
  .declare();

export const RequestNewInvitationTime = Operation.command({
  name: "recruitment.requestNewInvitationTime",
  input: InvitationRequestNewTimeInput,
  success: HttpApiSchema.NoContent,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/invitation-response:request-new-time")
  .http.contract({
    params: EmptyRecruitmentInput,
    headers: IfMatchHeaders,
    payload: InvitationRequestNewTimeInput,
    status: 204,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [InvitationCapabilitySecurity],
    metadata: {
      summary: "Request a new invitation time",
      description: "Requests another interview time by capability.",
    },
  })
  .http.problems({
    identifier: "RecruitmentRequestNewInvitationTimeProblem",
    codes: RecruitmentRequestNewInvitationTimeCodes,
  })
  .http.access({
    annotator: invitationCommandAccessAnnotations,
    acceptedCredentials: ["ObjectCapability"],
    principalKinds: ["CapabilityHolder"],
    capabilities: Capability.one("recruitment.invitation-response"),
    requirements: [],
    canonicalScopeResolver: RecruitmentInvitationByCapabilityResolver,
    concealment: Concealment.notFound(
      "CredentialFailure",
      "PrincipalKind",
      "Capability",
      "Scope",
      "Requirement",
    ),
    decisionTime: "Transaction",
  })
  .declare();

export const ReadAssignmentBoard = Operation.query({
  name: "recruitment.readAssignmentBoard",
  input: RecruitmentAssignmentBoardQuerySchema,
  success: AssignmentBoard,
})
  .in(RecruitmentGroup)
  .http.get("/api/recruitment/application-assignments")
  .http.contract({
    query: RecruitmentAssignmentBoardQuerySchema,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read assignment board",
      description: "Returns applicants and interviewers where the caller manages interviews.",
    },
  })
  .http.problems({
    identifier: "RecruitmentReadAssignmentBoardProblem",
    codes: RecruitmentReadAssignmentBoardCodes,
  })
  .http.access({
    annotator: recruitmentReadAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("reviewApplicants"),
    requirements: [{ id: "organization.single-department-administrator" }],
    canonicalScopeResolver: RecruitmentAssignmentBoardResolver,
    concealment: Concealment.reveal,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadInterviewReport = Operation.query({
  name: "recruitment.readInterviewReport",
  input: InterviewReportQuery,
  success: InterviewReport,
})
  .in(RecruitmentGroup)
  .http.get("/api/recruitment/interview-report")
  .http.contract({
    query: InterviewReportQuery,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read completed interview report",
      description:
        "Returns limited completed interview observations for an explicitly selected department admission period; proven self assessments are excluded.",
    },
  })
  .http.problems({
    identifier: "RecruitmentReadInterviewReportProblem",
    codes: RecruitmentReadInterviewReportCodes,
  })
  .http.access({
    annotator: recruitmentReadAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.read-interview-report"),
    requirements: [{ id: "organization.single-department-administrator" }],
    canonicalScopeResolver: RecruitmentInterviewReportResolver,
    concealment: Concealment.reveal,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadSchedulingBoard = Operation.query({
  name: "recruitment.readSchedulingBoard",
  input: EmptyRecruitmentInput,
  success: SchedulingBoard,
})
  .in(RecruitmentGroup)
  .http.get("/api/recruitment/interviews")
  .http.contract({
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read scheduling board",
      description: "Returns interviews visible to the current member.",
    },
  })
  .http.problems({
    identifier: "RecruitmentReadSchedulingBoardProblem",
    codes: RecruitmentReadSchedulingBoardCodes,
  })
  .http.access({
    annotator: recruitmentReadAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.read-interviews"),
    requirements: [{ id: "organization.single-department-member" }],
    canonicalScopeResolver: RecruitmentSchedulingBoardResolver,
    concealment: Concealment.reveal,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const CreateApplicationInterview = Operation.command({
  name: "recruitment.createApplicationInterview",
  input: CreateApplicationInterviewRequest,
  success: RecruitmentInterviewResource,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/applications/:applicationId/interviews")
  .http.contract({
    params: RecruitmentApplicationParams,
    headers: IdempotencyHeaders,
    payload: CreateApplicationInterviewRequest,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Assign applicant",
      description: "Assigns an applicant to an eligible interviewer.",
    },
  })
  .http.problems({
    identifier: "RecruitmentCreateApplicationInterviewProblem",
    codes: RecruitmentCreateApplicationInterviewCodes,
  })
  .http.access({
    annotator: recruitmentCommandAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("reviewApplicants"),
    requirements: [
      { id: "organization.single-department-administrator" },
      { id: "recruitment.interviewer-eligible" },
    ],
    canonicalScopeResolver: RecruitmentApplicationByIdResolver,
    concealment: Concealment.reveal,
    decisionTime: "Transaction",
  })
  .declare();

export const ScheduleInterview = Operation.command({
  name: "recruitment.scheduleInterview",
  input: ScheduleInterviewRequest,
  success: ScheduleInterviewResponse,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/interviews/:interviewId:schedule")
  .http.contract({
    params: RecruitmentInterviewParams,
    headers: IdempotencyIfMatchHeaders,
    payload: ScheduleInterviewRequest,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Schedule interview",
      description: "Schedules an assigned interview and invitation.",
    },
  })
  .http.problems({
    identifier: "RecruitmentScheduleInterviewProblem",
    codes: RecruitmentScheduleInterviewCodes,
  })
  .http.access({
    annotator: recruitmentCommandAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.schedule-interview"),
    requirements: [{ id: "recruitment.assigned-interviewer-or-administrator" }],
    canonicalScopeResolver: RecruitmentInterviewByIdResolver,
    concealment: Concealment.reveal,
    decisionTime: "Transaction",
  })
  .declare();

export const ReadInterviewConduct = Operation.query({
  name: "recruitment.readInterviewConduct",
  input: RecruitmentInterviewParams,
  success: ConductObservation,
})
  .in(RecruitmentGroup)
  .http.get("/api/recruitment/interviews/:interviewId")
  .http.contract({
    params: RecruitmentInterviewParams,
    headers: ConditionalReadHeaders,
    responseHeaders: ProfileReadResponseHeaders,
    conditional: true,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read interview conduct",
      description: "Returns interview questions and conduct state.",
    },
  })
  .http.problems({
    identifier: "RecruitmentReadInterviewConductProblem",
    codes: RecruitmentReadInterviewConductCodes,
  })
  .http.access({
    annotator: recruitmentReadAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.conduct-interview"),
    requirements: [
      { id: "recruitment.assigned-interviewer-or-co-interviewer" },
      { id: "recruitment.not-known-self" },
    ],
    canonicalScopeResolver: RecruitmentInterviewByIdResolver,
    concealment: Concealment.reveal,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const FinalizeInterview = Operation.command({
  name: "recruitment.finalizeInterview",
  input: FinalizeInterviewRequest,
  success: FinalizeInterviewResponse,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/interviews/:interviewId:finalize")
  .http.contract({
    params: RecruitmentInterviewParams,
    headers: IdempotencyIfMatchHeaders,
    payload: FinalizeInterviewRequest,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Finalize interview",
      description: "Records answers and scores for an interview.",
    },
  })
  .http.problems({
    identifier: "RecruitmentFinalizeInterviewProblem",
    codes: RecruitmentFinalizeInterviewCodes,
  })
  .http.access({
    annotator: recruitmentCommandAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.conduct-interview"),
    requirements: [
      { id: "recruitment.assigned-interviewer" },
      { id: "recruitment.not-known-self" },
    ],
    canonicalScopeResolver: RecruitmentInterviewByIdResolver,
    concealment: Concealment.reveal,
    decisionTime: "Transaction",
  })
  .declare();

export const CorrectInterviewAssessment = Operation.command({
  name: "recruitment.correctInterviewAssessment",
  input: CorrectInterviewAssessmentRequest,
  success: CorrectInterviewAssessmentResponse,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/interviews/:interviewId:correct")
  .http.contract({
    params: RecruitmentInterviewParams,
    headers: IdempotencyIfMatchHeaders,
    payload: CorrectInterviewAssessmentRequest,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Correct interview assessment",
      description: "Appends a replacement assessment to a completed interview.",
    },
  })
  .http.problems({
    identifier: "RecruitmentCorrectInterviewAssessmentProblem",
    codes: RecruitmentCorrectInterviewAssessmentCodes,
  })
  .http.access({
    annotator: recruitmentCommandAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.conduct-interview"),
    requirements: [
      { id: "recruitment.assigned-interviewer-or-co-interviewer" },
      { id: "recruitment.not-known-self" },
    ],
    canonicalScopeResolver: RecruitmentInterviewByIdResolver,
    concealment: Concealment.reveal,
    decisionTime: "Transaction",
  })
  .declare();

export const CancelInterview = Operation.command({
  name: "recruitment.cancelInterview",
  input: CancelInterviewRequest,
  success: CancelInterviewResponse,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/interviews/:interviewId:cancel")
  .http.contract({
    params: RecruitmentInterviewParams,
    headers: IdempotencyIfMatchHeaders,
    payload: CancelInterviewRequest,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Cancel interview",
      description: "Cancels an interview before finalization.",
    },
  })
  .http.problems({
    identifier: "RecruitmentCancelInterviewProblem",
    codes: RecruitmentCancelInterviewCodes,
  })
  .http.access({
    annotator: recruitmentCommandAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.conduct-interview"),
    requirements: [
      { id: "recruitment.assigned-interviewer" },
      { id: "recruitment.not-known-self" },
    ],
    canonicalScopeResolver: RecruitmentInterviewByIdResolver,
    concealment: Concealment.reveal,
    decisionTime: "Transaction",
  })
  .declare();

export const ReadQuestionnaires = Operation.query({
  name: "recruitment.readQuestionnaires",
  input: EmptyRecruitmentInput,
  success: QuestionnaireManagement,
})
  .in(RecruitmentGroup)
  .http.get("/api/recruitment/questionnaires")
  .http.contract({
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read questionnaires",
      description:
        "Returns global questionnaire definitions and immutable maintenance history for a current global administrator.",
    },
  })
  .http.problems({
    identifier: "RecruitmentMaintenanceProblem",
    codes: RecruitmentMaintenanceCodes,
  })
  .http.access({
    annotator: recruitmentReadAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.maintain"),
    requirements: [],
    canonicalScopeResolver: RecruitmentMaintenanceResolver,
    concealment: Concealment.reveal,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadInterviewStaffing = Operation.query({
  name: "recruitment.readInterviewStaffing",
  input: EmptyRecruitmentInput,
  success: InterviewStaffingManagement,
})
  .in(RecruitmentGroup)
  .http.get("/api/recruitment/interview-staffing")
  .http.contract({
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read interview staffing",
      description:
        "Returns interviews, eligible candidates, and staffing history in the current coordinator scope.",
    },
  })
  .http.problems({
    identifier: "RecruitmentMaintenanceProblem",
    codes: RecruitmentMaintenanceCodes,
  })
  .http.access({
    annotator: recruitmentReadAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.maintain"),
    requirements: [],
    canonicalScopeResolver: RecruitmentMaintenanceResolver,
    concealment: Concealment.reveal,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const MaintainRecruitment = Operation.command({
  name: "recruitment.maintainRecruitment",
  input: RecruitmentMaintenanceCommand,
  success: RecruitmentMaintenanceResult,
})
  .in(RecruitmentGroup)
  .http.post("/api/recruitment/maintenance/commands")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: RecruitmentMaintenanceCommand,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Maintain recruitment",
      description:
        "Creates or revises a questionnaire, or replaces a nonterminal interview staffing pair with an observed revision and reason.",
    },
  })
  .http.problems({
    identifier: "RecruitmentMaintenanceProblem",
    codes: RecruitmentMaintenanceCodes,
  })
  .http.access({
    annotator: recruitmentCommandAccessAnnotations,
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("recruitment.maintain"),
    requirements: [],
    canonicalScopeResolver: RecruitmentMaintenanceResolver,
    concealment: Concealment.reveal,
    decisionTime: "Transaction",
  })
  .declare();
