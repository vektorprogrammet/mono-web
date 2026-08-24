import { Schema, SchemaGetter } from "effect";
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
  PublicApplicationPhoneSchema,
} from "../application/schema.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { isRfc3339Instant, Rfc3339InstantSchema } from "../time.js";
import { PersonContactEmail, PersonContactPhone } from "../profile/schema.js";

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
export const RecruitmentScheduleCommandId = StableId.pipe(
  Schema.brand("RecruitmentScheduleCommandId"),
);
export type RecruitmentScheduleCommandId = typeof RecruitmentScheduleCommandId.Type;

export const RecruitmentInvitationId = StableId.pipe(Schema.brand("RecruitmentInvitationId"));
export type RecruitmentInvitationId = typeof RecruitmentInvitationId.Type;

export const RecruitmentNotificationEffectId = StableId.pipe(
  Schema.brand("RecruitmentNotificationEffectId"),
);
export type RecruitmentNotificationEffectId = typeof RecruitmentNotificationEffectId.Type;

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
  revision: Model.GeneratedByDb(Revision),
}) {}

export type RecruitmentInterviewSelect = typeof RecruitmentInterview.Encoded;
export type RecruitmentInterviewInsert = typeof RecruitmentInterview.insert.Encoded;
export type RecruitmentInterviewJson = typeof RecruitmentInterview.json.Type;
export type RecruitmentInterviewValue = typeof RecruitmentInterview.Type;

const ScheduleMessage = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, {
      message: "a non-empty schedule message",
    }),
    Schema.isMaxLength(2_000),
  ),
);
const HttpsMapLink = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" && url.username.length === 0 && url.password.length === 0
          );
        } catch {
          return false;
        }
      },
      { message: "an HTTPS URL without user credentials" },
    ),
  ),
);
const CapabilitySha256 = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => /^[a-f0-9]{64}$/u.test(value), {
      message: "a lowercase SHA-256 digest",
    }),
  ),
);

export class RecruitmentInterviewSchedule extends Model.Class<RecruitmentInterviewSchedule>(
  "Recruitment.RecruitmentInterviewSchedule",
)({
  interviewId: Model.Field({
    select: RecruitmentInterviewId,
    insert: RecruitmentInterviewId,
    json: RecruitmentInterviewId,
  }),
  scheduledAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
    json: Rfc3339InstantSchema,
  }),
  room: Model.Field({
    select: Name,
    insert: Name,
    json: Name,
  }),
  campus: Model.Field({
    select: Schema.NullOr(Name),
    insert: Schema.NullOr(Name),
    json: Schema.NullOr(Name),
  }),
  mapLink: Model.Field({
    select: Schema.NullOr(HttpsMapLink),
    insert: Schema.NullOr(HttpsMapLink),
    json: Schema.NullOr(HttpsMapLink),
  }),
  message: Model.Field({
    select: ScheduleMessage,
    insert: ScheduleMessage,
    json: ScheduleMessage,
  }),
  scheduledByPersonId: Model.Field({
    select: PersonId,
    insert: PersonId,
    json: PersonId,
  }),
  committedAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
    json: Rfc3339InstantSchema,
  }),
  scheduleRevision: Model.Field({
    select: Revision,
    insert: Revision,
    json: Revision,
  }),
}) {}

export type RecruitmentInterviewScheduleSelect = typeof RecruitmentInterviewSchedule.Encoded;
export type RecruitmentInterviewScheduleValue = typeof RecruitmentInterviewSchedule.Type;

export const RecruitmentInvitationCapabilitySchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => /^[A-Za-z0-9_-]{43}$/u.test(value), {
      message: "a 43-character base64url capability",
    }),
  ),
  Schema.brand("RecruitmentInvitationCapability"),
);
export type RecruitmentInvitationCapability =
  typeof RecruitmentInvitationCapabilitySchema.Type;

export const RecruitmentInvitationResponseStateSchema = Schema.Literals([
  "Pending",
  "Accepted",
  "Rejected",
  "RequestedNewTime",
]);
export type RecruitmentInvitationResponseState =
  typeof RecruitmentInvitationResponseStateSchema.Type;

const TrimmedRecruitmentInvitationResponseMessageSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value === value.trim(), {
      message: "a trimmed non-empty invitation response message",
    }),
    Schema.isMaxLength(2_000),
  ),
);
export const RecruitmentInvitationResponseMessageSchema = Schema.String.pipe(
  Schema.decodeTo(TrimmedRecruitmentInvitationResponseMessageSchema, {
    decode: SchemaGetter.transform((value: string) => value.trim()),
    encode: SchemaGetter.transform((value: string) => value),
  }),
);
export type RecruitmentInvitationResponseMessage =
  typeof RecruitmentInvitationResponseMessageSchema.Type;

const RecruitmentInvitationRejectInputEncodedSchema = Schema.Struct({
  message: Schema.optional(Schema.String),
});
const RecruitmentInvitationRejectInputNormalizedSchema = Schema.Struct({
  message: Schema.optional(RecruitmentInvitationResponseMessageSchema),
});
export const RecruitmentInvitationRejectInputSchema =
  RecruitmentInvitationRejectInputEncodedSchema.pipe(
    Schema.decodeTo(RecruitmentInvitationRejectInputNormalizedSchema, {
      decode: SchemaGetter.transform((input: { readonly message?: string }) => {
        const message = input.message?.trim();
        return message === undefined || message.length === 0 ? {} : { message };
      }),
      encode: SchemaGetter.transform((input: { readonly message?: string }) => input),
    }),
  );
export type RecruitmentInvitationRejectInput =
  typeof RecruitmentInvitationRejectInputSchema.Type;

export const RecruitmentInvitationRequestNewTimeInputSchema = Schema.Struct({
  message: RecruitmentInvitationResponseMessageSchema,
});
export type RecruitmentInvitationRequestNewTimeInput =
  typeof RecruitmentInvitationRequestNewTimeInputSchema.Type;

export class RecruitmentInvitation extends Model.Class<RecruitmentInvitation>(
  "Recruitment.RecruitmentInvitation",
)({
  invitationId: Model.Field({
    select: RecruitmentInvitationId,
    insert: RecruitmentInvitationId,
  }),
  interviewId: Model.Field({
    select: RecruitmentInterviewId,
    insert: RecruitmentInterviewId,
  }),
  scheduleRevision: Model.Field({
    select: Revision,
    insert: Revision,
  }),
  capabilitySha256: Model.Field({
    select: CapabilitySha256,
    insert: CapabilitySha256,
  }),
  responseState: Model.Field({
    select: RecruitmentInvitationResponseStateSchema,
    insert: RecruitmentInvitationResponseStateSchema,
    update: RecruitmentInvitationResponseStateSchema,
  }),
  responseMessage: Model.GeneratedByDb(
    Schema.NullOr(RecruitmentInvitationResponseMessageSchema),
  ),
  respondedAt: Model.GeneratedByDb(Schema.NullOr(Rfc3339InstantSchema)),
  responseRevision: Model.GeneratedByDb(Revision),
  supersededAt: Model.GeneratedByDb(Schema.NullOr(Rfc3339InstantSchema)),
  createdAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
  }),
}) {}

export type RecruitmentInvitationSelect = typeof RecruitmentInvitation.Encoded;
export type RecruitmentInvitationValue = typeof RecruitmentInvitation.Type;

const RecruitmentInvitationResponseObservationFields = {
  scheduledAt: RecruitmentInterviewSchedule.fields.scheduledAt,
  room: RecruitmentInterviewSchedule.fields.room,
  campus: RecruitmentInterviewSchedule.fields.campus,
};
export const RecruitmentInvitationResponseObservationSchema = Schema.Union([
  Schema.Struct({
    ...RecruitmentInvitationResponseObservationFields,
    responseState: Schema.Literals(["Pending", "Accepted"]),
    responseMessage: Schema.Literal(null),
  }),
  Schema.Struct({
    ...RecruitmentInvitationResponseObservationFields,
    responseState: Schema.Literals(["Rejected"]),
    responseMessage: Schema.NullOr(RecruitmentInvitationResponseMessageSchema),
  }),
  Schema.Struct({
    ...RecruitmentInvitationResponseObservationFields,
    responseState: Schema.Literals(["RequestedNewTime"]),
    responseMessage: RecruitmentInvitationResponseMessageSchema,
  }),
]);
export type RecruitmentInvitationResponseObservation =
  typeof RecruitmentInvitationResponseObservationSchema.Type;

export const RecruitmentInvitationResponseNotificationStateSchema = Schema.Literals([
  "NotRequired",
  "Pending",
]);
export type RecruitmentInvitationResponseNotificationState =
  typeof RecruitmentInvitationResponseNotificationStateSchema.Type;

const RecruitmentInvitationResponseResultFields = {
  _tag: Schema.Literals(["InvitationResponseRecorded"]),
  interviewRevision: Revision,
  scheduleRevision: Revision,
  responseRevision: Revision,
  respondedAt: Rfc3339InstantSchema,
};
export const RecruitmentInvitationResponseResultSchema = Schema.Union([
  Schema.Struct({
    ...RecruitmentInvitationResponseResultFields,
    responseState: Schema.Literals(["Accepted"]),
    responseMessage: Schema.Literal(null),
    notificationState: Schema.Literals(["NotRequired"]),
  }),
  Schema.Struct({
    ...RecruitmentInvitationResponseResultFields,
    responseState: Schema.Literals(["Rejected"]),
    responseMessage: Schema.NullOr(RecruitmentInvitationResponseMessageSchema),
    notificationState: Schema.Literals(["Pending"]),
  }),
  Schema.Struct({
    ...RecruitmentInvitationResponseResultFields,
    responseState: Schema.Literals(["RequestedNewTime"]),
    responseMessage: RecruitmentInvitationResponseMessageSchema,
    notificationState: Schema.Literals(["Pending"]),
  }),
]);
export type RecruitmentInvitationResponseResult =
  typeof RecruitmentInvitationResponseResultSchema.Type;

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
  "Scheduled",
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
export const RecruitmentNotificationDeliveryStateSchema = Schema.Literals([
  "Pending",
  "Processing",
  "Delivered",
  "Failed",
  "Quarantined",
]);
export type RecruitmentNotificationDeliveryState =
  typeof RecruitmentNotificationDeliveryStateSchema.Type;

export const RecruitmentSchedulingApplicantSchema = Schema.Struct({
  applicationId: PublicApplicationIdSchema,
  applicantId: ApplicantIdSchema,
  firstName: PublicApplicationNameSchema,
  lastName: PublicApplicationNameSchema,
  email: PublicApplicationEmailSchema,
  phone: PublicApplicationPhoneSchema,
});
export type RecruitmentSchedulingApplicant = typeof RecruitmentSchedulingApplicantSchema.Type;

export const RecruitmentSchedulingInterviewerSchema = Schema.Struct({
  personId: PersonId,
  displayName: Name,
  email: PersonContactEmail,
  phone: PersonContactPhone,
});
export type RecruitmentSchedulingInterviewer = typeof RecruitmentSchedulingInterviewerSchema.Type;

const RecruitmentSchedulingInterviewFields = {
  interviewId: RecruitmentInterviewId,
  applicationId: PublicApplicationIdSchema,
  departmentId: DepartmentId,
  interviewer: RecruitmentSchedulingInterviewerSchema,
  applicant: RecruitmentSchedulingApplicantSchema,
  revision: Revision,
  schedule: Schema.NullOr(RecruitmentInterviewSchedule),
  notificationState: Schema.NullOr(RecruitmentNotificationDeliveryStateSchema),
};
export const RecruitmentSchedulingInterviewSchema = Schema.Union([
  Schema.Struct({
    ...RecruitmentSchedulingInterviewFields,
    responseState: Schema.Literal(null),
    responseMessage: Schema.Literal(null),
  }),
  Schema.Struct({
    ...RecruitmentSchedulingInterviewFields,
    responseState: Schema.Literals(["Pending", "Accepted"]),
    responseMessage: Schema.Literal(null),
  }),
  Schema.Struct({
    ...RecruitmentSchedulingInterviewFields,
    responseState: Schema.Literals(["Rejected"]),
    responseMessage: Schema.NullOr(RecruitmentInvitationResponseMessageSchema),
  }),
  Schema.Struct({
    ...RecruitmentSchedulingInterviewFields,
    responseState: Schema.Literals(["RequestedNewTime"]),
    responseMessage: RecruitmentInvitationResponseMessageSchema,
  }),
]);
export type RecruitmentSchedulingInterview = typeof RecruitmentSchedulingInterviewSchema.Type;

export const RecruitmentSchedulingBoardSchema = Schema.Struct({
  departmentId: DepartmentId,
  interviews: Schema.Array(RecruitmentSchedulingInterviewSchema),
});
export type RecruitmentSchedulingBoard = typeof RecruitmentSchedulingBoardSchema.Type;

export const RecruitmentScheduleCommandSchema = Schema.Struct({
  commandId: RecruitmentScheduleCommandId,
  interviewId: RecruitmentInterviewId,
  expectedRevision: Revision,
  scheduledAt: Rfc3339InstantSchema,
  room: Name,
  campus: Schema.NullOr(Name),
  mapLink: Schema.NullOr(HttpsMapLink),
  message: ScheduleMessage,
});
export type RecruitmentScheduleCommand = typeof RecruitmentScheduleCommandSchema.Type;

export const RecruitmentScheduleObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["InterviewScheduled"]),
  commandId: RecruitmentScheduleCommandId,
  interviewId: RecruitmentInterviewId,
  schedule: RecruitmentInterviewSchedule,
  interviewRevision: Revision,
  responseState: RecruitmentInvitationResponseStateSchema,
  notificationState: RecruitmentNotificationDeliveryStateSchema,
});
export type RecruitmentScheduleObservation = typeof RecruitmentScheduleObservationSchema.Type;

export const RecruitmentScheduleResultSchema = Schema.Struct({
  observation: RecruitmentScheduleObservationSchema,
  replayed: Schema.Boolean,
});
export type RecruitmentScheduleResult = typeof RecruitmentScheduleResultSchema.Type;

export interface RecruitmentInvitationResponseContext {
  readonly now: string;
}

export interface RecruitmentReadSchedulingBoardContext {
  readonly actor: RecruitmentActor;
  readonly now: string;
}

export interface RecruitmentScheduleContext {
  readonly actor: RecruitmentActor;
  readonly now: string;
  readonly invitationId: RecruitmentInvitationId;
  readonly responseCapability: string;
}

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
