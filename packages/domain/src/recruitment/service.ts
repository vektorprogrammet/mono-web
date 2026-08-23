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
  RecruitmentReadAssignmentBoardContext,
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
  RecruitmentInterviewSchemaInactive,
  RecruitmentInterviewSchemaNotFound,
  RecruitmentInvalidContext,
  RecruitmentPersistenceError,
  RecruitmentRoleDenied,
  RecruitmentScopeDenied,
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
  | RecruitmentInvalidContext
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
}

export class Recruitment extends Context.Service<Recruitment, RecruitmentShape>()(
  "@vektorprogrammet/domain/Recruitment",
) {}
