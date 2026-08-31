import {
  CancelInterviewCommandSchema,
  CancelInterviewResultSchema,
  FinalizeInterviewCommandSchema,
  FinalizeInterviewResultSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentAssignmentResultSchema,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterviewId,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentScheduleCommandSchema,
  RecruitmentScheduleResultSchema,
  RecruitmentSchedulingBoardSchema,
} from "@vektorprogrammet/domain/recruitment";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  errorBody,
  InvitationCapabilitySecurity,
  operationAnnotations,
  SessionSecurity,
} from "./common.js";

/**
 * Exact empty JSON object required when accepting an invitation.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ConfirmInvitationPayload = Schema.Record(Schema.String, Schema.Never).annotate({
  identifier: "ConfirmInvitationPayload",
  description: "An empty JSON object.",
  examples: [{}],
});

const RecruitmentForbiddenResponse = errorBody(
  "RecruitmentForbiddenResponse",
  [
    "RecruitmentInactiveActor",
    "RecruitmentRoleDenied",
    "RecruitmentScopeDenied",
    "RecruitmentInterviewerNotEligible",
  ],
  403,
);
const RecruitmentNotFoundResponse = errorBody(
  "RecruitmentNotFoundResponse",
  [
    "RecruitmentAdmissionPeriodNotFound",
    "RecruitmentApplicationNotFound",
    "RecruitmentInterviewSchemaNotFound",
    "RecruitmentInterviewNotFound",
    "RecruitmentInvitationNotFound",
  ],
  404,
);
const RecruitmentConflictResponse = errorBody(
  "RecruitmentConflictResponse",
  [
    "RecruitmentApplicationAlreadyAssigned",
    "RecruitmentAmbiguousAdmissionPeriod",
    "RecruitmentAssignmentCommandConflict",
    "RecruitmentInterviewAlreadyScheduled",
    "RecruitmentInterviewStaleRevision",
    "RecruitmentInvitationAlreadyResponded",
    "RecruitmentScheduleCommandConflict",
    "RecruitmentLifecycleCommandConflict",
    "RecruitmentInterviewAlreadyFinalized",
    "RecruitmentInterviewAlreadyCancelled",
    "RecruitmentInvitationNotAccepted",
    "RecruitmentInterviewNotScheduled",
  ],
  409,
);
const RecruitmentTooLargeResponse = errorBody(
  "RecruitmentTooLargeResponse",
  ["RequestBodyTooLarge"],
  413,
);
const RecruitmentDecodeResponse = errorBody(
  "RecruitmentDecodeResponse",
  [
    "RecruitmentDecodeError",
    "RecruitmentInterviewSchemaInactive",
    "RecruitmentScheduleInPast",
    "RecruitmentConductValidationError",
  ],
  422,
);
const RecruitmentUnavailableResponse = errorBody(
  "RecruitmentUnavailableResponse",
  [
    "ProfileContactNotFound",
    "RecruitmentPersistenceError",
    "InterviewQuestionsUnavailable",
    "RecruitmentInvalidContext",
  ],
  503,
);
const RecruitmentErrors = [
  RecruitmentForbiddenResponse,
  RecruitmentNotFoundResponse,
  RecruitmentConflictResponse,
  RecruitmentTooLargeResponse,
  RecruitmentDecodeResponse,
  RecruitmentUnavailableResponse,
] as const;

/** @since 0.1.0 @category Endpoints */
export const ReadInvitationResponseEndpoint = HttpApiEndpoint.get(
  "readInvitationResponse",
  "/api/recruitment/invitation-response",
  { success: RecruitmentInvitationResponseObservationSchema, error: RecruitmentErrors },
)
  .middleware(InvitationCapabilitySecurity)
  .annotateMerge(
    operationAnnotations(
      "Read invitation response",
      "Reads an interview invitation by capability.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ConfirmInvitationEndpoint = HttpApiEndpoint.post(
  "confirmInvitation",
  "/api/recruitment/invitation-response/confirm",
  { payload: ConfirmInvitationPayload, error: RecruitmentErrors },
)
  .middleware(InvitationCapabilitySecurity)
  .annotateMerge(
    operationAnnotations("Confirm invitation", "Accepts an interview invitation by capability."),
  );

/** @since 0.1.0 @category Endpoints */
export const RejectInvitationEndpoint = HttpApiEndpoint.post(
  "rejectInvitation",
  "/api/recruitment/invitation-response/reject",
  { payload: RecruitmentInvitationRejectInputSchema, error: RecruitmentErrors },
)
  .middleware(InvitationCapabilitySecurity)
  .annotateMerge(
    operationAnnotations("Reject invitation", "Rejects an interview invitation by capability."),
  );

/** @since 0.1.0 @category Endpoints */
export const RequestNewInvitationTimeEndpoint = HttpApiEndpoint.post(
  "requestNewInvitationTime",
  "/api/recruitment/invitation-response/request-new-time",
  { payload: RecruitmentInvitationRequestNewTimeInputSchema, error: RecruitmentErrors },
)
  .middleware(InvitationCapabilitySecurity)
  .annotateMerge(
    operationAnnotations(
      "Request a new invitation time",
      "Requests another interview time by capability.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadAssignmentBoardEndpoint = HttpApiEndpoint.get(
  "readAssignmentBoard",
  "/api/admin/recruitment/assignment-board",
  {
    query: RecruitmentAssignmentBoardQuerySchema.fields,
    success: RecruitmentAssignmentBoardSchema,
    error: RecruitmentErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Read assignment board",
      "Returns applicants and interviewers in leader scope.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadSchedulingBoardEndpoint = HttpApiEndpoint.get(
  "readSchedulingBoard",
  "/api/admin/recruitment/interviews/scheduling-board",
  { success: RecruitmentSchedulingBoardSchema, error: RecruitmentErrors },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Read scheduling board",
      "Returns interviews visible to the current member.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const AssignApplicantEndpoint = HttpApiEndpoint.post(
  "assignApplicant",
  "/api/admin/recruitment/interviews/assign",
  {
    payload: RecruitmentAssignmentCommandSchema,
    success: RecruitmentAssignmentResultSchema,
    error: RecruitmentErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations("Assign applicant", "Assigns an applicant to an eligible interviewer."),
  );

/** @since 0.1.0 @category Endpoints */
export const ScheduleInterviewEndpoint = HttpApiEndpoint.post(
  "scheduleInterview",
  "/api/admin/recruitment/interviews/schedule",
  {
    payload: RecruitmentScheduleCommandSchema,
    success: RecruitmentScheduleResultSchema,
    error: RecruitmentErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations("Schedule interview", "Schedules an assigned interview and invitation."),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadInterviewConductEndpoint = HttpApiEndpoint.get(
  "readInterviewConduct",
  "/api/admin/recruitment/interviews/:interviewId/conduct",
  {
    params: { interviewId: RecruitmentInterviewId },
    success: RecruitmentInterviewConductObservationSchema,
    error: RecruitmentErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Read interview conduct",
      "Returns interview questions and conduct state.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const FinalizeInterviewEndpoint = HttpApiEndpoint.post(
  "finalizeInterview",
  "/api/admin/recruitment/interviews/:interviewId/finalize",
  {
    params: { interviewId: RecruitmentInterviewId },
    payload: FinalizeInterviewCommandSchema,
    success: FinalizeInterviewResultSchema,
    error: RecruitmentErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations("Finalize interview", "Records answers and scores for an interview."),
  );

/** @since 0.1.0 @category Endpoints */
export const CancelInterviewEndpoint = HttpApiEndpoint.post(
  "cancelInterview",
  "/api/admin/recruitment/interviews/:interviewId/cancel",
  {
    params: { interviewId: RecruitmentInterviewId },
    payload: CancelInterviewCommandSchema,
    success: CancelInterviewResultSchema,
    error: RecruitmentErrors,
  },
)
  .middleware(SessionSecurity)
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
