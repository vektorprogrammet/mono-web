/**
 * Portable Recruitment service contract for reads and lifecycle commands.
 *
 * @since 0.1.0
 */
import { Context, Effect } from "effect";
import type { AdmissionPeriodFailure } from "../admission-period/errors.js";
import type {
  OrganizationDecodeError,
  OrganizationPersistenceError,
} from "../organization/errors.js";
import type { ProfileFailure } from "../profile/errors.js";
import type {
  RecruitmentAssignmentBoard,
  RecruitmentAssignmentBoardQuery,
  RecruitmentAssignmentCommand,
  RecruitmentAssignmentContext,
  RecruitmentAssignmentResult,
  RecruitmentInvitationCapability,
  RecruitmentInvitationResponseContext,
  RecruitmentInvitationRejectInput,
  RecruitmentInvitationRequestNewTimeInput,
  RecruitmentInvitationResponseObservation,
  RecruitmentInvitationResponseResult,
  RecruitmentReadAssignmentBoardContext,
  RecruitmentReadSchedulingBoardContext,
  RecruitmentScheduleCommand,
  RecruitmentScheduleContext,
  RecruitmentScheduleResult,
  RecruitmentSchedulingBoard,
  RecruitmentConductContext,
  RecruitmentInterviewConductObservation,
  FinalizeInterviewCommand,
  FinalizeInterviewResult,
  CancelInterviewCommand,
  RecruitmentInterviewId,
  CancelInterviewResult,
} from "./schema.js";
import type {
  RecruitmentAdmissionPeriodNotFound,
  RecruitmentAmbiguousAdmissionPeriod,
  RecruitmentApplicationAlreadyAssigned,
  RecruitmentApplicationNotFound,
  RecruitmentAssignmentCommandConflict,
  RecruitmentDecodeError,
  RecruitmentInactiveActor,
  RecruitmentInterviewerNotEligible,
  RecruitmentInterviewNotFound,
  RecruitmentInterviewAlreadyFinalized,
  RecruitmentInterviewAlreadyCancelled,
  RecruitmentInterviewNotScheduled,
  RecruitmentInvitationNotAccepted,
  RecruitmentInterviewAlreadyScheduled,
  RecruitmentInterviewSchemaInactive,
  RecruitmentInterviewSchemaNotFound,
  RecruitmentInterviewStaleRevision,
  RecruitmentInvitationAlreadyResponded,
  RecruitmentInvitationNotFound,
  RecruitmentScheduleCommandConflict,
  RecruitmentScheduleInPast,
  RecruitmentInvalidContext,
  RecruitmentPersistenceError,
  RecruitmentRoleDenied,
  RecruitmentScopeDenied,
  InterviewQuestionsUnavailable,
  RecruitmentLifecycleCommandConflict,
  RecruitmentConductValidationError,
} from "./errors.js";
export type RecruitmentFailure =
  | RecruitmentDecodeError
  | RecruitmentInactiveActor
  | RecruitmentRoleDenied
  | RecruitmentScopeDenied
  | RecruitmentAdmissionPeriodNotFound
  | RecruitmentAmbiguousAdmissionPeriod
  | RecruitmentApplicationNotFound
  | RecruitmentApplicationAlreadyAssigned
  | RecruitmentInterviewSchemaNotFound
  | RecruitmentInterviewSchemaInactive
  | RecruitmentInterviewerNotEligible
  | RecruitmentAssignmentCommandConflict
  | RecruitmentInterviewNotFound
  | RecruitmentInterviewAlreadyScheduled
  | RecruitmentInterviewStaleRevision
  | RecruitmentInvitationNotFound
  | RecruitmentInvitationAlreadyResponded
  | RecruitmentScheduleCommandConflict
  | RecruitmentScheduleInPast
  | InterviewQuestionsUnavailable
  | RecruitmentInvalidContext
  | RecruitmentPersistenceError
  | RecruitmentLifecycleCommandConflict
  | RecruitmentInterviewAlreadyFinalized
  | RecruitmentInterviewAlreadyCancelled
  | RecruitmentInterviewNotScheduled
  | RecruitmentInvitationNotAccepted
  | RecruitmentConductValidationError
  | AdmissionPeriodFailure
  | OrganizationDecodeError
  | OrganizationPersistenceError
  | ProfileFailure;

export interface RecruitmentShape {
  readonly readAssignmentBoard: (
    query: RecruitmentAssignmentBoardQuery,
    context: RecruitmentReadAssignmentBoardContext,
  ) => Effect.Effect<RecruitmentAssignmentBoard, RecruitmentFailure>;
  readonly assignApplicant: (
    command: RecruitmentAssignmentCommand,
    context: RecruitmentAssignmentContext,
  ) => Effect.Effect<RecruitmentAssignmentResult, RecruitmentFailure>;
  readonly readSchedulingBoard: (
    context: RecruitmentReadSchedulingBoardContext,
  ) => Effect.Effect<RecruitmentSchedulingBoard, RecruitmentFailure>;
  readonly scheduleInterview: (
    command: RecruitmentScheduleCommand,
    context: RecruitmentScheduleContext,
  ) => Effect.Effect<RecruitmentScheduleResult, RecruitmentFailure>;
  readonly readInvitationResponse: (
    capability: RecruitmentInvitationCapability,
  ) => Effect.Effect<RecruitmentInvitationResponseObservation, RecruitmentFailure>;
  readonly confirmInvitation: (
    capability: RecruitmentInvitationCapability,
    context: RecruitmentInvitationResponseContext,
  ) => Effect.Effect<RecruitmentInvitationResponseResult, RecruitmentFailure>;
  readonly rejectInvitation: (
    capability: RecruitmentInvitationCapability,
    input: RecruitmentInvitationRejectInput,
    context: RecruitmentInvitationResponseContext,
  ) => Effect.Effect<RecruitmentInvitationResponseResult, RecruitmentFailure>;
  readonly requestNewInvitationTime: (
    capability: RecruitmentInvitationCapability,
    input: RecruitmentInvitationRequestNewTimeInput,
    context: RecruitmentInvitationResponseContext,
  ) => Effect.Effect<RecruitmentInvitationResponseResult, RecruitmentFailure>;
  readonly readInterviewConduct: (
    interviewId: RecruitmentInterviewId,
    context: RecruitmentConductContext,
  ) => Effect.Effect<RecruitmentInterviewConductObservation, RecruitmentFailure>;
  readonly finalizeInterview: (
    command: FinalizeInterviewCommand,
    context: RecruitmentConductContext,
  ) => Effect.Effect<FinalizeInterviewResult, RecruitmentFailure>;
  readonly cancelInterview: (
    command: CancelInterviewCommand,
    context: RecruitmentConductContext,
  ) => Effect.Effect<CancelInterviewResult, RecruitmentFailure>;
}

export class Recruitment extends Context.Service<Recruitment, RecruitmentShape>()(
  "@vektorprogrammet/domain/Recruitment",
) {}
