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
  | RecruitmentInvalidContext
  | InterviewQuestionsUnavailable
  | RecruitmentPersistenceError
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
}

export class Recruitment extends Context.Service<Recruitment, RecruitmentShape>()(
  "@vektorprogrammet/domain/Recruitment",
) {}
