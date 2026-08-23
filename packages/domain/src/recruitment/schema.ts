import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import {
  AdmissionPeriodActorSchema,
  type AdmissionPeriodActor,
  AdmissionPeriodId,
} from "../admission-period/schema.js";
import {
  ApplicantIdSchema,
  PublicApplicationEmailSchema,
  PublicApplicationIdSchema,
  PublicApplicationNameSchema,
} from "../application/schema.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { isRfc3339Instant, Rfc3339InstantSchema } from "../time.js";

const StableId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value), {
      message: "a non-empty stable identifier",
    }),
  ),
);
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const NonNegative = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const Name = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty name" }),
    Schema.isMaxLength(250),
  ),
);

export const InterviewSchemaId = StableId.pipe(Schema.brand("InterviewSchemaId"));
export type InterviewSchemaId = typeof InterviewSchemaId.Type;

export const RecruitmentInterviewId = StableId.pipe(Schema.brand("RecruitmentInterviewId"));
export type RecruitmentInterviewId = typeof RecruitmentInterviewId.Type;

export const RecruitmentAssignmentCommandId = StableId.pipe(
  Schema.brand("RecruitmentAssignmentCommandId"),
);
export type RecruitmentAssignmentCommandId = typeof RecruitmentAssignmentCommandId.Type;

export const RecruitmentActorSchema = AdmissionPeriodActorSchema;
export type RecruitmentActor = AdmissionPeriodActor;

export const RecruitmentAssignmentStatusSchema = Schema.Literals(["new", "all"]);
export type RecruitmentAssignmentStatus = typeof RecruitmentAssignmentStatusSchema.Type;

export const RecruitmentAssignmentBoardQuerySchema = Schema.Struct({
  status: RecruitmentAssignmentStatusSchema,
});
export type RecruitmentAssignmentBoardQuery = typeof RecruitmentAssignmentBoardQuerySchema.Type;

export class InterviewSchema extends Model.Class<InterviewSchema>("Recruitment.InterviewSchema")({
  interviewSchemaId: Model.Field({
    select: InterviewSchemaId,
    insert: InterviewSchemaId,
    json: InterviewSchemaId,
  }),
  name: Model.Field({
    select: Name,
    insert: Name,
    update: Name,
    json: Name,
    jsonCreate: Name,
    jsonUpdate: Name,
  }),
  questionCount: Model.Field({
    select: NonNegative,
    insert: NonNegative,
    update: NonNegative,
    json: NonNegative,
    jsonCreate: NonNegative,
    jsonUpdate: NonNegative,
  }),
  active: Model.Field({
    select: Schema.Boolean,
    insert: Schema.Boolean,
    update: Schema.Boolean,
    json: Schema.Boolean,
    jsonCreate: Schema.Boolean,
    jsonUpdate: Schema.Boolean,
  }),
  revision: Model.GeneratedByDb(Revision),
}) {}

export type InterviewSchemaSelect = typeof InterviewSchema.Encoded;
export type InterviewSchemaInsert = typeof InterviewSchema.insert.Encoded;
export type InterviewSchemaUpdate = typeof InterviewSchema.update.Encoded;
export type InterviewSchemaJson = typeof InterviewSchema.json.Type;
export type InterviewSchemaJsonCreate = typeof InterviewSchema.jsonCreate.Type;
export type InterviewSchemaJsonUpdate = typeof InterviewSchema.jsonUpdate.Type;
export type InterviewSchemaValue = typeof InterviewSchema.Type;

export const RecruitmentInterviewStateSchema = Schema.Literals(["NoContact"]);
export type RecruitmentInterviewState = typeof RecruitmentInterviewStateSchema.Type;

export class RecruitmentInterview extends Model.Class<RecruitmentInterview>(
  "Recruitment.RecruitmentInterview",
)({
  interviewId: Model.Field({
    select: RecruitmentInterviewId,
    insert: RecruitmentInterviewId,
    json: RecruitmentInterviewId,
  }),
  applicationId: Model.Field({
    select: PublicApplicationIdSchema,
    insert: PublicApplicationIdSchema,
    json: PublicApplicationIdSchema,
  }),
  departmentId: Model.Field({
    select: DepartmentId,
    insert: DepartmentId,
    json: DepartmentId,
  }),
  interviewerPersonId: Model.Field({
    select: PersonId,
    insert: PersonId,
    json: PersonId,
  }),
  interviewSchemaId: Model.Field({
    select: InterviewSchemaId,
    insert: InterviewSchemaId,
    json: InterviewSchemaId,
  }),
  assignedByPersonId: Model.Field({
    select: PersonId,
    insert: PersonId,
    json: PersonId,
  }),
  assignedAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
    json: Rfc3339InstantSchema,
  }),
  state: Model.Field({
    select: RecruitmentInterviewStateSchema,
    insert: RecruitmentInterviewStateSchema,
    json: RecruitmentInterviewStateSchema,
  }),
  scheduledAt: Model.Field({
    select: Schema.NullOr(Rfc3339InstantSchema),
    insert: Schema.NullOr(Rfc3339InstantSchema),
    json: Schema.NullOr(Rfc3339InstantSchema),
  }),
  revision: Model.GeneratedByDb(Revision),
}) {}

export type RecruitmentInterviewSelect = typeof RecruitmentInterview.Encoded;
export type RecruitmentInterviewInsert = typeof RecruitmentInterview.insert.Encoded;
export type RecruitmentInterviewJson = typeof RecruitmentInterview.json.Type;
export type RecruitmentInterviewValue = typeof RecruitmentInterview.Type;

export const RecruitmentInterviewerOptionSchema = Schema.Struct({
  personId: PersonId,
  displayName: Name,
});
export type RecruitmentInterviewerOption = typeof RecruitmentInterviewerOptionSchema.Type;

export const RecruitmentInterviewSchemaOptionSchema = Schema.Struct({
  interviewSchemaId: InterviewSchemaId,
  name: Name,
  questionCount: NonNegative,
  active: Schema.Boolean,
  revision: Revision,
});
export type RecruitmentInterviewSchemaOption = typeof RecruitmentInterviewSchemaOptionSchema.Type;

export const RecruitmentInterviewStateForBoardSchema = Schema.Literals([
  "Unassigned",
  "NoContact",
]);
export type RecruitmentInterviewStateForBoard = typeof RecruitmentInterviewStateForBoardSchema.Type;

export const RecruitmentApplicationStateSchema = Schema.Literals(["Received"]);
export type RecruitmentApplicationState = typeof RecruitmentApplicationStateSchema.Type;

export const RecruitmentAssignmentCandidateSchema = Schema.Struct({
  applicationId: PublicApplicationIdSchema,
  applicantId: ApplicantIdSchema,
  firstName: PublicApplicationNameSchema,
  lastName: PublicApplicationNameSchema,
  email: PublicApplicationEmailSchema,
  submittedAt: Rfc3339InstantSchema,
  applicationState: RecruitmentApplicationStateSchema,
  interviewState: RecruitmentInterviewStateForBoardSchema,
  interviewer: Schema.NullOr(RecruitmentInterviewerOptionSchema),
  interviewSchema: Schema.NullOr(RecruitmentInterviewSchemaOptionSchema),
  scheduledAt: Schema.NullOr(Rfc3339InstantSchema),
});
export type RecruitmentAssignmentCandidate = typeof RecruitmentAssignmentCandidateSchema.Type;

export const RecruitmentAssignmentBoardSchema = Schema.Struct({
  admissionPeriodId: AdmissionPeriodId,
  departmentId: DepartmentId,
  candidates: Schema.Array(RecruitmentAssignmentCandidateSchema),
  interviewers: Schema.Array(RecruitmentInterviewerOptionSchema),
  interviewSchemas: Schema.Array(RecruitmentInterviewSchemaOptionSchema),
});
export type RecruitmentAssignmentBoard = typeof RecruitmentAssignmentBoardSchema.Type;

export const RecruitmentAssignmentCommandSchema = Schema.Struct({
  commandId: RecruitmentAssignmentCommandId,
  applicationId: PublicApplicationIdSchema,
  interviewerPersonId: PersonId,
  interviewSchemaId: InterviewSchemaId,
});
export type RecruitmentAssignmentCommand = typeof RecruitmentAssignmentCommandSchema.Type;

export const RecruitmentAssignmentObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["ApplicantAssigned"]),
  commandId: RecruitmentAssignmentCommandId,
  interview: RecruitmentInterview,
});
export type RecruitmentAssignmentObservation = typeof RecruitmentAssignmentObservationSchema.Type;

export const RecruitmentAssignmentResultSchema = Schema.Struct({
  observation: RecruitmentAssignmentObservationSchema,
  replayed: Schema.Boolean,
});
export type RecruitmentAssignmentResult = typeof RecruitmentAssignmentResultSchema.Type;

export interface RecruitmentReadAssignmentBoardContext {
  readonly actor: RecruitmentActor;
  readonly now: string;
}

export interface RecruitmentAssignmentContext {
  readonly actor: RecruitmentActor;
  readonly now: string;
  readonly interviewId: RecruitmentInterviewId;
}

export const isRecruitmentNow = isRfc3339Instant;
export const RecruitmentInstantSchema = Rfc3339InstantSchema;
