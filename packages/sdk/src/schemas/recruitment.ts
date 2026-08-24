import { Schema, SchemaGetter } from "effect";
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

const Name = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty name" }),
    Schema.isMaxLength(250),
  ),
);
const ApplicantName = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const normalized = value.trim();
        return (
          normalized.length > 0 &&
          Array.from(normalized).length <= 100 &&
          !/[\p{Cc}\p{Cf}]/u.test(normalized)
        );
      },
      { message: "a valid applicant name" },
    ),
  ),
);
const ApplicantEmail = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const normalized = value.trim();
        return (
          normalized.length > 0 &&
          Array.from(normalized).length <= 254 &&
          !/[\p{Cc}\p{Cf}\s]/u.test(normalized) &&
          /^[^@]+@[^@]+\.[^@]+$/u.test(normalized)
        );
      },
      { message: "a valid applicant email" },
    ),
  ),
);
const ApplicantPhone = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const normalized = value.trim();
        return (
          normalized.length > 0 &&
          Array.from(normalized).length <= 32 &&
          !/[\p{Cc}\p{Cf}]/u.test(normalized)
        );
      },
      { message: "a valid applicant phone number" },
    ),
  ),
);
const PersonContactEmail = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const normalized = value.trim();
        const separator = normalized.indexOf("@");
        return (
          normalized.length <= 320 &&
          separator > 0 &&
          separator === normalized.lastIndexOf("@") &&
          separator < normalized.length - 1
        );
      },
      { message: "a valid staff email address" },
    ),
  ),
);
const PersonContactPhone = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const normalized = value.trim();
        return (
          normalized.length > 0 &&
          normalized.length <= 32 &&
          /^[+\d][\d\s().-]*$/u.test(normalized)
        );
      },
      { message: "a valid staff phone number" },
    ),
  ),
);
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
            url.protocol === "https:" &&
            url.username.length === 0 &&
            url.password.length === 0
          );
        } catch {
          return false;
        }
      },
      { message: "an HTTPS URL without user credentials" },
    ),
  ),
);

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

export const RecruitmentScheduleCommandId = StableId.pipe(
  Schema.brand("RecruitmentScheduleCommandId"),
);
export type RecruitmentScheduleCommandId = typeof RecruitmentScheduleCommandId.Type;

export const RecruitmentInvitationId = StableId.pipe(Schema.brand("RecruitmentInvitationId"));
export type RecruitmentInvitationId = typeof RecruitmentInvitationId.Type;

export const RecruitmentInvitationCapabilitySchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => /^[A-Za-z0-9_-]{43}$/u.test(value),
      { message: "a 43-character base64url invitation capability" },
    ),
  ),
  Schema.brand("RecruitmentInvitationCapability"),
);
export type RecruitmentInvitationCapability =
  typeof RecruitmentInvitationCapabilitySchema.Type;

export const RecruitmentNotificationEffectId = StableId.pipe(
  Schema.brand("RecruitmentNotificationEffectId"),
);
export type RecruitmentNotificationEffectId = typeof RecruitmentNotificationEffectId.Type;

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


export const RecruitmentInterviewStateForBoardSchema = Schema.Literals([
  "Unassigned",
  "NoContact",
  "Scheduled",
]);
export type RecruitmentInterviewStateForBoard =
  typeof RecruitmentInterviewStateForBoardSchema.Type;

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

export const RecruitmentInvitationResponseStateSchema = Schema.Literals([
  "Pending",
  "Accepted",
  "Rejected",
  "RequestedNewTime",
]);
export type RecruitmentInvitationResponseState =
  typeof RecruitmentInvitationResponseStateSchema.Type;

export const RecruitmentInvitationResponseMessageSchema = Schema.Trim.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
);
export type RecruitmentInvitationResponseMessage =
  typeof RecruitmentInvitationResponseMessageSchema.Type;

const RecruitmentInvitationRejectEncodedSchema = Schema.Struct({
  message: Schema.optional(Schema.String),
});
const RecruitmentInvitationRejectNormalizedSchema = Schema.Struct({
  message: Schema.optional(RecruitmentInvitationResponseMessageSchema),
});
export const RecruitmentInvitationRejectInputSchema =
  RecruitmentInvitationRejectEncodedSchema.pipe(
    Schema.decodeTo(RecruitmentInvitationRejectNormalizedSchema, {
      decode: SchemaGetter.transform((input) => {
        const message = input.message?.trim();
        return message === undefined || message.length === 0
          ? {}
          : { message };
      }),
      encode: SchemaGetter.transform((input) => input),
    }),
  );
export type RecruitmentInvitationRejectInput =
  typeof RecruitmentInvitationRejectInputSchema.Type;

export const RecruitmentInvitationRequestNewTimeInputSchema = Schema.Struct({
  message: RecruitmentInvitationResponseMessageSchema,
});
export type RecruitmentInvitationRequestNewTimeInput =
  typeof RecruitmentInvitationRequestNewTimeInputSchema.Type;

const RecruitmentInvitationResponseObservationFields = {
  scheduledAt: Rfc3339InstantSchema,
  room: Name,
  campus: Schema.NullOr(Name),
};
export const RecruitmentInvitationResponseObservationSchema = Schema.Union([
  Schema.Struct({
    ...RecruitmentInvitationResponseObservationFields,
    responseState: Schema.Literals(["Pending", "Accepted"]),
    responseMessage: Schema.Null,
  }),
  Schema.Struct({
    ...RecruitmentInvitationResponseObservationFields,
    responseState: Schema.Literals(["Rejected"]),
    responseMessage: Schema.NullOr(
      RecruitmentInvitationResponseMessageSchema,
    ),
  }),
  Schema.Struct({
    ...RecruitmentInvitationResponseObservationFields,
    responseState: Schema.Literals(["RequestedNewTime"]),
    responseMessage: RecruitmentInvitationResponseMessageSchema,
  }),
]);
export type RecruitmentInvitationResponseObservation =
  typeof RecruitmentInvitationResponseObservationSchema.Type;

export const RecruitmentNotificationDeliveryStateSchema = Schema.Literals([
  "Pending",
  "Processing",
  "Delivered",
  "Failed",
  "Quarantined",
]);
export type RecruitmentNotificationDeliveryState =
  typeof RecruitmentNotificationDeliveryStateSchema.Type;

export const RecruitmentInterviewScheduleSchema = Schema.Struct({
  interviewId: RecruitmentInterviewId,
  scheduledAt: Rfc3339InstantSchema,
  room: Name,
  campus: Schema.NullOr(Name),
  mapLink: Schema.NullOr(HttpsMapLink),
  message: ScheduleMessage,
  scheduledByPersonId: RecruitmentPersonId,
  committedAt: Rfc3339InstantSchema,
  scheduleRevision: Revision,
});
export type RecruitmentInterviewSchedule = typeof RecruitmentInterviewScheduleSchema.Type;

export const RecruitmentSchedulingApplicantSchema = Schema.Struct({
  applicationId: RecruitmentApplicationId,
  applicantId: RecruitmentApplicantId,
  firstName: ApplicantName,
  lastName: ApplicantName,
  email: ApplicantEmail,
  phone: ApplicantPhone,
});
export type RecruitmentSchedulingApplicant = typeof RecruitmentSchedulingApplicantSchema.Type;

export const RecruitmentSchedulingInterviewerSchema = Schema.Struct({
  personId: RecruitmentPersonId,
  displayName: Name,
  email: PersonContactEmail,
  phone: PersonContactPhone,
});
export type RecruitmentSchedulingInterviewer =
  typeof RecruitmentSchedulingInterviewerSchema.Type;

const RecruitmentSchedulingInterviewFields = {
  interviewId: RecruitmentInterviewId,
  applicationId: RecruitmentApplicationId,
  departmentId: RecruitmentDepartmentId,
  interviewer: RecruitmentSchedulingInterviewerSchema,
  applicant: RecruitmentSchedulingApplicantSchema,
  revision: Revision,
  schedule: Schema.NullOr(RecruitmentInterviewScheduleSchema),
  notificationState: Schema.NullOr(
    RecruitmentNotificationDeliveryStateSchema,
  ),
};
export const RecruitmentSchedulingInterviewSchema = Schema.Union([
  Schema.Struct({
    ...RecruitmentSchedulingInterviewFields,
    responseState: Schema.Null,
    responseMessage: Schema.Null,
  }),
  Schema.Struct({
    ...RecruitmentSchedulingInterviewFields,
    responseState: Schema.Literals(["Pending", "Accepted"]),
    responseMessage: Schema.Null,
  }),
  Schema.Struct({
    ...RecruitmentSchedulingInterviewFields,
    responseState: Schema.Literals(["Rejected"]),
    responseMessage: Schema.NullOr(
      RecruitmentInvitationResponseMessageSchema,
    ),
  }),
  Schema.Struct({
    ...RecruitmentSchedulingInterviewFields,
    responseState: Schema.Literals(["RequestedNewTime"]),
    responseMessage: RecruitmentInvitationResponseMessageSchema,
  }),
]);
export type RecruitmentSchedulingInterview =
  typeof RecruitmentSchedulingInterviewSchema.Type;

export const RecruitmentSchedulingBoardSchema = Schema.Struct({
  departmentId: RecruitmentDepartmentId,
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
  schedule: RecruitmentInterviewScheduleSchema,
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

export const RecruitmentAssignmentBoardObservationSchema = RecruitmentAssignmentBoardSchema;
export type RecruitmentAssignmentBoardObservation = RecruitmentAssignmentBoard;
