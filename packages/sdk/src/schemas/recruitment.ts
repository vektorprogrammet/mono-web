import { Schema } from "effect";
import { Rfc3339InstantSchema } from "./admission-period.js";

const StableId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value),
      { message: "a non-empty stable identifier" },
    ),
  ),
);
const NonEmpty = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" })),
);
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const NonNegative = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const RecruitmentAdmissionPeriodId = StableId.pipe(
  Schema.brand("RecruitmentAdmissionPeriodId"),
);
export type RecruitmentAdmissionPeriodId = typeof RecruitmentAdmissionPeriodId.Type;

export const InterviewSchemaId = StableId.pipe(Schema.brand("InterviewSchemaId"));
export type InterviewSchemaId = typeof InterviewSchemaId.Type;

export const RecruitmentInterviewId = StableId.pipe(Schema.brand("RecruitmentInterviewId"));
export type RecruitmentInterviewId = typeof RecruitmentInterviewId.Type;

export const RecruitmentAssignmentCommandId = StableId.pipe(
  Schema.brand("RecruitmentAssignmentCommandId"),
);
export type RecruitmentAssignmentCommandId = typeof RecruitmentAssignmentCommandId.Type;

export const RecruitmentApplicationId = StableId.pipe(Schema.brand("RecruitmentApplicationId"));
export type RecruitmentApplicationId = typeof RecruitmentApplicationId.Type;

export const RecruitmentApplicantId = StableId.pipe(Schema.brand("RecruitmentApplicantId"));
export type RecruitmentApplicantId = typeof RecruitmentApplicantId.Type;

export const RecruitmentPersonId = StableId.pipe(Schema.brand("RecruitmentPersonId"));
export type RecruitmentPersonId = typeof RecruitmentPersonId.Type;

export const RecruitmentDepartmentId = StableId.pipe(Schema.brand("RecruitmentDepartmentId"));
export type RecruitmentDepartmentId = typeof RecruitmentDepartmentId.Type;

export const RecruitmentAssignmentStatusSchema = Schema.Literals(["new", "all"]);
export type RecruitmentAssignmentStatus = typeof RecruitmentAssignmentStatusSchema.Type;

export const RecruitmentAssignmentBoardQuerySchema = Schema.Struct({
  status: RecruitmentAssignmentStatusSchema,
});
export type RecruitmentAssignmentBoardQuery = typeof RecruitmentAssignmentBoardQuerySchema.Type;

export const RecruitmentInterviewerOptionSchema = Schema.Struct({
  personId: RecruitmentPersonId,
  displayName: NonEmpty,
});
export type RecruitmentInterviewerOption = typeof RecruitmentInterviewerOptionSchema.Type;

export const RecruitmentInterviewSchemaOptionSchema = Schema.Struct({
  interviewSchemaId: InterviewSchemaId,
  name: NonEmpty,
  questionCount: NonNegative,
  active: Schema.Boolean,
  revision: Revision,
});
export type RecruitmentInterviewSchemaOption = typeof RecruitmentInterviewSchemaOptionSchema.Type;

export const RecruitmentInterviewStateSchema = Schema.Literals(["NoContact"]);
export type RecruitmentInterviewState = typeof RecruitmentInterviewStateSchema.Type;

export const RecruitmentInterviewStateForBoardSchema = Schema.Literals(["Unassigned", "NoContact"]);
export type RecruitmentInterviewStateForBoard = typeof RecruitmentInterviewStateForBoardSchema.Type;

export const RecruitmentApplicationStateSchema = Schema.Literals(["Received"]);
export type RecruitmentApplicationState = typeof RecruitmentApplicationStateSchema.Type;

export const RecruitmentAssignmentCandidateSchema = Schema.Struct({
  applicationId: RecruitmentApplicationId,
  applicantId: RecruitmentApplicantId,
  firstName: NonEmpty,
  lastName: NonEmpty,
  email: NonEmpty,
  submittedAt: Rfc3339InstantSchema,
  applicationState: RecruitmentApplicationStateSchema,
  interviewState: RecruitmentInterviewStateForBoardSchema,
  interviewer: Schema.NullOr(RecruitmentInterviewerOptionSchema),
  interviewSchema: Schema.NullOr(RecruitmentInterviewSchemaOptionSchema),
  scheduledAt: Schema.NullOr(Rfc3339InstantSchema),
});
export type RecruitmentAssignmentCandidate = typeof RecruitmentAssignmentCandidateSchema.Type;

export const RecruitmentAssignmentBoardSchema = Schema.Struct({
  admissionPeriodId: RecruitmentAdmissionPeriodId,
  departmentId: RecruitmentDepartmentId,
  candidates: Schema.Array(RecruitmentAssignmentCandidateSchema),
  interviewers: Schema.Array(RecruitmentInterviewerOptionSchema),
  interviewSchemas: Schema.Array(RecruitmentInterviewSchemaOptionSchema),
});
export type RecruitmentAssignmentBoard = typeof RecruitmentAssignmentBoardSchema.Type;

export const RecruitmentAssignmentCommandSchema = Schema.Struct({
  commandId: RecruitmentAssignmentCommandId,
  applicationId: RecruitmentApplicationId,
  interviewerPersonId: RecruitmentPersonId,
  interviewSchemaId: InterviewSchemaId,
});
export type RecruitmentAssignmentCommand = typeof RecruitmentAssignmentCommandSchema.Type;

export const RecruitmentInterviewSchema = Schema.Struct({
  interviewId: RecruitmentInterviewId,
  applicationId: RecruitmentApplicationId,
  departmentId: RecruitmentDepartmentId,
  interviewerPersonId: RecruitmentPersonId,
  interviewSchemaId: InterviewSchemaId,
  assignedByPersonId: RecruitmentPersonId,
  assignedAt: Rfc3339InstantSchema,
  state: RecruitmentInterviewStateSchema,
  scheduledAt: Schema.NullOr(Rfc3339InstantSchema),
  revision: Revision,
});
export type RecruitmentInterview = typeof RecruitmentInterviewSchema.Type;

export const RecruitmentAssignmentObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["ApplicantAssigned"]),
  commandId: RecruitmentAssignmentCommandId,
  interview: RecruitmentInterviewSchema,
});
export type RecruitmentAssignmentObservation = typeof RecruitmentAssignmentObservationSchema.Type;

export const RecruitmentAssignmentResultSchema = Schema.Struct({
  observation: RecruitmentAssignmentObservationSchema,
  replayed: Schema.Boolean,
});
export type RecruitmentAssignmentResult = typeof RecruitmentAssignmentResultSchema.Type;

export const RecruitmentAssignmentBoardObservationSchema = RecruitmentAssignmentBoardSchema;
export type RecruitmentAssignmentBoardObservation = RecruitmentAssignmentBoard;
