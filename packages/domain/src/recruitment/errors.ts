import { Schema } from "effect";
import { PublicApplicationId } from "../application/schema.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { ProfileFailure } from "../profile/errors.js";
import {
  InterviewSchemaId,
  RecruitmentAssignmentCommandId,
  RecruitmentInterviewId,
} from "./schema.js";

export class RecruitmentDecodeError extends Schema.TaggedError<RecruitmentDecodeError>()(
  "RecruitmentDecodeError",
  { message: Schema.String },
) {}

export class RecruitmentInactiveActor extends Schema.TaggedError<RecruitmentInactiveActor>()(
  "RecruitmentInactiveActor",
  { personId: PersonId },
) {}

export class RecruitmentRoleDenied extends Schema.TaggedError<RecruitmentRoleDenied>()(
  "RecruitmentRoleDenied",
  { personId: PersonId },
) {}

export class RecruitmentScopeDenied extends Schema.TaggedError<RecruitmentScopeDenied>()(
  "RecruitmentScopeDenied",
  {
    personId: PersonId,
    departmentId: DepartmentId,
    applicationId: Schema.optional(PublicApplicationId),
  },
) {}

export class RecruitmentAdmissionPeriodNotFound extends Schema.TaggedError<RecruitmentAdmissionPeriodNotFound>()(
  "RecruitmentAdmissionPeriodNotFound",
  { departmentId: DepartmentId },
) {}

export class RecruitmentAmbiguousAdmissionPeriod extends Schema.TaggedError<RecruitmentAmbiguousAdmissionPeriod>()(
  "RecruitmentAmbiguousAdmissionPeriod",
  { departmentId: DepartmentId },
) {}

export class RecruitmentApplicationNotFound extends Schema.TaggedError<RecruitmentApplicationNotFound>()(
  "RecruitmentApplicationNotFound",
  { applicationId: PublicApplicationId },
) {}

export class RecruitmentApplicationAlreadyAssigned extends Schema.TaggedError<RecruitmentApplicationAlreadyAssigned>()(
  "RecruitmentApplicationAlreadyAssigned",
  { applicationId: PublicApplicationId, interviewId: Schema.optional(RecruitmentInterviewId) },
) {}

export class RecruitmentInterviewSchemaNotFound extends Schema.TaggedError<RecruitmentInterviewSchemaNotFound>()(
  "RecruitmentInterviewSchemaNotFound",
  { interviewSchemaId: InterviewSchemaId },
) {}

export class RecruitmentInterviewSchemaInactive extends Schema.TaggedError<RecruitmentInterviewSchemaInactive>()(
  "RecruitmentInterviewSchemaInactive",
  { interviewSchemaId: InterviewSchemaId },
) {}

export class RecruitmentInterviewerNotEligible extends Schema.TaggedError<RecruitmentInterviewerNotEligible>()(
  "RecruitmentInterviewerNotEligible",
  { personId: PersonId, departmentId: DepartmentId },
) {}

export class RecruitmentAssignmentCommandConflict extends Schema.TaggedError<RecruitmentAssignmentCommandConflict>()(
  "RecruitmentAssignmentCommandConflict",
  { commandId: RecruitmentAssignmentCommandId },
) {}

export class RecruitmentInvalidContext extends Schema.TaggedError<RecruitmentInvalidContext>()(
  "RecruitmentInvalidContext",
  { message: Schema.String },
) {}

export class RecruitmentPersistenceError extends Schema.TaggedError<RecruitmentPersistenceError>()(
  "RecruitmentPersistenceError",
  { operation: Schema.String, message: Schema.String },
) {}

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
  | ProfileFailure;
