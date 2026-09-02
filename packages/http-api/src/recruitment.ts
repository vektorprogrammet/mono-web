/**
 * Public HTTP contracts for recruitment assignment, scheduling, and interviews.
 *
 * @since 0.1.0
 */
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import { ApplicantIdSchema, PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  InterviewSchemaId,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterviewId,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentSchedulingBoardSchema,
} from "@vektorprogrammet/domain/recruitment";
const InvitationResponseObservationExample: any = {
  scheduledAt: "2026-09-10T14:00:00.000Z",
  room: "Realfagbygget, R90",
  campus: "Gløshaugen",
  responseState: "Pending",
  responseMessage: null,
} as const;

const AssignmentBoardExample: any = {
  admissionPeriodId: AdmissionPeriodId.make("period-1"),
  departmentId: DepartmentId.make("1"),
  candidates: [
    {
      applicationId: PublicApplicationIdSchema.make("app-0080"),
      applicantId: ApplicantIdSchema.make("applicant-0080"),
      firstName: "Ming",
      lastName: "Medlem",
      email: "ming.medlem@example.org",
      submittedAt: "2026-08-15T12:00:00.000Z",
      applicationState: "Received",
      interviewState: "Unassigned",
      interviewer: null,
      interviewSchema: null,
      scheduledAt: null,
    },
  ],
  interviewers: [{ personId: PersonId.make("1001"), displayName: "Kari Leder" }],
  interviewSchemas: [
    {
      interviewSchemaId: InterviewSchemaId.make("interview-schema-1"),
      name: "Standardintervju",
      questionCount: 5,
      active: true,
      revision: 2,
    },
  ],
};

const SchedulingBoardExample: any = {
  departmentId: DepartmentId.make("1"),
  interviews: [
    {
      interviewId: RecruitmentInterviewId.make("interview-1"),
      applicationId: PublicApplicationIdSchema.make("app-0080"),
      departmentId: DepartmentId.make("1"),
      interviewer: {
        personId: PersonId.make("1001"),
        displayName: "Kari Leder",
        email: "kari.leder@example.org",
        phone: "+47 900 00 000",
      },
      applicant: {
        applicationId: PublicApplicationIdSchema.make("app-0080"),
        applicantId: ApplicantIdSchema.make("applicant-0080"),
        firstName: "Ming",
        lastName: "Medlem",
        email: "ming.medlem@example.org",
        phone: "+47 900 00 000",
      },
      revision: 2,
      schedule: {
        interviewId: RecruitmentInterviewId.make("interview-1"),
        scheduledAt: "2026-09-10T14:00:00.000Z",
        room: "Realfagbygget, R90",
        campus: "Gløshaugen",
        mapLink: "https://maps.example.org/r90",
        message: "Interview invitation with room details.",
        scheduledByPersonId: PersonId.make("1002"),
        committedAt: "2026-08-20T10:05:00.000Z",
        scheduleRevision: 1,
      },
      notificationState: "Pending",
      responseState: "Pending",
      responseMessage: null,
    },
  ],
};

const ConductObservationExample: any = {
  interviewId: RecruitmentInterviewId.make("interview-1"),
  applicationId: PublicApplicationIdSchema.make("app-0080"),
  applicant: {
    applicantId: ApplicantIdSchema.make("applicant-0080"),
    firstName: "Ming",
    lastName: "Medlem",
  },
  schedule: {
    interviewId: RecruitmentInterviewId.make("interview-1"),
    scheduledAt: "2026-09-10T14:00:00.000Z",
    room: "Realfagbygget, R90",
    campus: "Gløshaugen",
    mapLink: "https://maps.example.org/r90",
    message: "Interview invitation with room details.",
    scheduledByPersonId: PersonId.make("1002"),
    committedAt: "2026-08-20T10:05:00.000Z",
    scheduleRevision: 1,
  },
  invitationResponse: "Accepted",
  questions: [
    {
      interviewId: RecruitmentInterviewId.make("interview-1"),
      questionId: "q-1",
      ordinal: 1,
      prompt: "Why did you apply to this programme?",
      helpText: null,
      kind: "text",
      alternatives: [],
    },
  ],
  answers: [{ questionId: "q-1", answer: "I am drawn to the study programme's breadth." }],
  score: { explanatoryPower: 7, roleModel: 8, suitability: 6 },
  completionState: "Completed",
  cancellationState: "NotCancelled",
  finalizedAt: "2026-09-12T15:00:00.000Z",
  cancelledAt: null,
  revision: 3,
  canFinalize: false,
  canCancel: false,
};

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, invitationNativeAccess, personNativeAccess } from "./access.js";
import { InvitationCapabilitySecurity, operationAnnotations, PersonSecurity } from "./common.js";
import {
  RecruitmentCancelInterviewProblem,
  RecruitmentConfirmInvitationProblem,
  RecruitmentCreateApplicationInterviewProblem,
  RecruitmentFinalizeInterviewProblem,
  RecruitmentReadAssignmentBoardProblem,
  RecruitmentReadInterviewConductProblem,
  RecruitmentReadInvitationResponseProblem,
  RecruitmentReadSchedulingBoardProblem,
  RecruitmentRejectInvitationProblem,
  RecruitmentRequestNewInvitationTimeProblem,
  RecruitmentScheduleInterviewProblem,
} from "./endpoint-problems.js";
import {
  ConditionalReadHeaders,
  createdMutationResponse,
  endpointProblemResponses,
  entityMutationResponse,
  IdempotencyHeaders,
  IdempotencyIfMatchHeaders,
  noContentMutationResponse,
  privateConditionalResponses,
  privateReadResponse,
} from "./http-semantics.js";
import {
  CancelInterviewRequest,
  CancelInterviewResponse,
  CreateApplicationInterviewRequest,
  EmptyJsonRequest,
  FinalizeInterviewRequest,
  FinalizeInterviewResponse,
  RecruitmentInterviewResource,
  ScheduleInterviewRequest,
  ScheduleInterviewResponse,
} from "./v2-schemas.js";

/**
 * Exact empty JSON object required when accepting an invitation.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ConfirmInvitationPayload = EmptyJsonRequest.annotate({
  identifier: "ConfirmInvitationRequest",
  description: "An exact empty JSON object.",
  examples: [{}],
});

export const InvitationRejectInput = RecruitmentInvitationRejectInputSchema.annotate({
  identifier: "InvitationRejectInput",
  description: "Optional short rejection message.",
  examples: [{ message: "Cannot attend that day." }, {}],
});

export const InvitationRequestNewTimeInput =
  RecruitmentInvitationRequestNewTimeInputSchema.annotate({
    identifier: "InvitationRequestNewTimeInput",
    description: "Short message proposing another time.",
    examples: [{ message: "Could we do Thursday instead?" }],
  });

export const InvitationResponseObservation =
  RecruitmentInvitationResponseObservationSchema.annotate({
    identifier: "InvitationResponseObservation",
    description: "Interview invitation state visible to the invitee.",
    examples: [InvitationResponseObservationExample],
  });

export const AssignmentBoard = RecruitmentAssignmentBoardSchema.annotate({
  identifier: "AssignmentBoard",
  description: "Candidates and interviewers in the caller's leader scope.",
  examples: [AssignmentBoardExample],
});

export const SchedulingBoard = RecruitmentSchedulingBoardSchema.annotate({
  identifier: "SchedulingBoard",
  description: "Interviews visible to the current member.",
  examples: [SchedulingBoardExample],
});

export const ConductObservation = RecruitmentInterviewConductObservationSchema.annotate({
  identifier: "ConductObservation",
  description: "Interview questions, answers, and conduct state.",
  examples: [ConductObservationExample],
});

/** @since 0.1.0 @category Endpoints */
export const ReadInvitationResponseEndpoint = HttpApiEndpoint.get(
  "readInvitationResponse",
  "/api/recruitment/invitation-response",
  {
    headers: ConditionalReadHeaders,
    success: privateConditionalResponses(InvitationResponseObservation),
    error: endpointProblemResponses(RecruitmentReadInvitationResponseProblem),
  },
)
  .middleware(InvitationCapabilitySecurity)
  .pipe((endpoint) => annotateAccessSpec(endpoint, invitationNativeAccess([], "SnapshotRead")))
  .annotateMerge(
    operationAnnotations(
      "Read invitation response",
      "Reads an interview invitation by capability.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ConfirmInvitationEndpoint = HttpApiEndpoint.post(
  "confirmInvitation",
  "/api/recruitment/invitation-response::confirm",
  {
    headers: IdempotencyIfMatchHeaders,
    payload: ConfirmInvitationPayload,
    success: noContentMutationResponse({ etag: true }),
    error: endpointProblemResponses(RecruitmentConfirmInvitationProblem),
  },
)
  .middleware(InvitationCapabilitySecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      invitationNativeAccess(["recruitment.invitation-pending"], "Transaction"),
    ),
  )
  .annotateMerge(
    operationAnnotations("Confirm invitation", "Accepts an interview invitation by capability."),
  );

/** @since 0.1.0 @category Endpoints */
export const RejectInvitationEndpoint = HttpApiEndpoint.post(
  "rejectInvitation",
  "/api/recruitment/invitation-response::reject",
  {
    headers: IdempotencyIfMatchHeaders,
    payload: InvitationRejectInput,
    success: noContentMutationResponse({ etag: true }),
    error: endpointProblemResponses(RecruitmentRejectInvitationProblem),
  },
)
  .middleware(InvitationCapabilitySecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      invitationNativeAccess(["recruitment.invitation-pending"], "Transaction"),
    ),
  )
  .annotateMerge(
    operationAnnotations("Reject invitation", "Rejects an interview invitation by capability."),
  );

/** @since 0.1.0 @category Endpoints */
export const RequestNewInvitationTimeEndpoint = HttpApiEndpoint.post(
  "requestNewInvitationTime",
  "/api/recruitment/invitation-response::request-new-time",
  {
    headers: IdempotencyIfMatchHeaders,
    payload: InvitationRequestNewTimeInput,
    success: noContentMutationResponse({ etag: true }),
    error: endpointProblemResponses(RecruitmentRequestNewInvitationTimeProblem),
  },
)
  .middleware(InvitationCapabilitySecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      invitationNativeAccess(["recruitment.invitation-pending"], "Transaction"),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Request a new invitation time",
      "Requests another interview time by capability.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadAssignmentBoardEndpoint = HttpApiEndpoint.get(
  "readAssignmentBoard",
  "/api/recruitment/application-assignments",
  {
    query: RecruitmentAssignmentBoardQuerySchema.fields,
    success: privateReadResponse(AssignmentBoard),
    error: endpointProblemResponses(RecruitmentReadAssignmentBoardProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "reviewApplicants",
        canonicalScopeResolver: "recruitment.application-assignments",
        requirements: ["organization.single-department-leader"],
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Read assignment board",
      "Returns applicants and interviewers in leader scope.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadSchedulingBoardEndpoint = HttpApiEndpoint.get(
  "readSchedulingBoard",
  "/api/recruitment/interviews",
  {
    success: privateReadResponse(SchedulingBoard),
    error: endpointProblemResponses(RecruitmentReadSchedulingBoardProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "recruitment.read-interviews",
        canonicalScopeResolver: "recruitment.interviews",
        requirements: ["organization.single-department-member"],
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Read scheduling board",
      "Returns interviews visible to the current member.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const AssignApplicantEndpoint = HttpApiEndpoint.post(
  "createApplicationInterview",
  "/api/recruitment/applications/:applicationId/interviews",
  {
    params: { applicationId: PublicApplicationIdSchema },
    headers: IdempotencyHeaders,
    payload: CreateApplicationInterviewRequest,
    success: createdMutationResponse(RecruitmentInterviewResource.pipe(HttpApiSchema.status(201))),
    error: endpointProblemResponses(RecruitmentCreateApplicationInterviewProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "reviewApplicants",
        canonicalScopeResolver: "recruitment.application-by-id",
        requirements: ["organization.single-department-leader", "recruitment.interviewer-eligible"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("Assign applicant", "Assigns an applicant to an eligible interviewer."),
  );

/** @since 0.1.0 @category Endpoints */
export const ScheduleInterviewEndpoint = HttpApiEndpoint.post(
  "scheduleInterview",
  "/api/recruitment/interviews/:interviewId::schedule",
  {
    params: { interviewId: RecruitmentInterviewId },
    headers: IdempotencyIfMatchHeaders,
    payload: ScheduleInterviewRequest,
    success: entityMutationResponse(ScheduleInterviewResponse),
    error: endpointProblemResponses(RecruitmentScheduleInterviewProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "recruitment.schedule-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: ["recruitment.assigned-interviewer-or-leader"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("Schedule interview", "Schedules an assigned interview and invitation."),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadInterviewConductEndpoint = HttpApiEndpoint.get(
  "readInterviewConduct",
  "/api/recruitment/interviews/:interviewId",
  {
    params: { interviewId: RecruitmentInterviewId },
    headers: ConditionalReadHeaders,
    success: privateConditionalResponses(ConductObservation),
    error: endpointProblemResponses(RecruitmentReadInterviewConductProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "recruitment.conduct-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: ["recruitment.assigned-interviewer"],
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Read interview conduct",
      "Returns interview questions and conduct state.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const FinalizeInterviewEndpoint = HttpApiEndpoint.post(
  "finalizeInterview",
  "/api/recruitment/interviews/:interviewId::finalize",
  {
    params: { interviewId: RecruitmentInterviewId },
    headers: IdempotencyIfMatchHeaders,
    payload: FinalizeInterviewRequest,
    success: entityMutationResponse(FinalizeInterviewResponse),
    error: endpointProblemResponses(RecruitmentFinalizeInterviewProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "recruitment.conduct-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: ["recruitment.assigned-interviewer"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("Finalize interview", "Records answers and scores for an interview."),
  );

/** @since 0.1.0 @category Endpoints */
export const CancelInterviewEndpoint = HttpApiEndpoint.post(
  "cancelInterview",
  "/api/recruitment/interviews/:interviewId::cancel",
  {
    params: { interviewId: RecruitmentInterviewId },
    headers: IdempotencyIfMatchHeaders,
    payload: CancelInterviewRequest,
    success: entityMutationResponse(CancelInterviewResponse),
    error: endpointProblemResponses(RecruitmentCancelInterviewProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "recruitment.conduct-interview",
        canonicalScopeResolver: "recruitment.interview-by-id",
        requirements: ["recruitment.assigned-interviewer"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("Cancel interview", "Cancels an interview before finalization."),
  );

/**
 * Recruitment assignment, scheduling, conduct, and invitation API.
 *
 * @since 0.1.0
 * @category Groups
 */
export class RecruitmentApi extends HttpApiGroup.make("recruitment")
  .add(
    ReadInvitationResponseEndpoint,
    ConfirmInvitationEndpoint,
    RejectInvitationEndpoint,
    RequestNewInvitationTimeEndpoint,
    ReadAssignmentBoardEndpoint,
    ReadSchedulingBoardEndpoint,
    AssignApplicantEndpoint,
    ScheduleInterviewEndpoint,
    ReadInterviewConductEndpoint,
    FinalizeInterviewEndpoint,
    CancelInterviewEndpoint,
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Recruitment",
      description: "Applicant assignment, interview scheduling, conduct, and invitation response.",
    }),
  ) {}
