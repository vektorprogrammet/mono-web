/**
 * Interview schema — transforms integer schedulingStatus from the API
 * into a typed string enum using adapter/status.ts.
 */

import { Schema, SchemaGetter } from "effect"
import { parseInterviewStatus } from "../adapter/status.js"

export const InterviewSchedulingStatus = Schema.Literals([
  "created",
  "pending",
  "accepted",
  "request_new_time",
  "cancelled",
  "no_contact",
])
export type InterviewSchedulingStatus = Schema.Schema.Type<typeof InterviewSchedulingStatus>
const boundedIdentifier = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
)

export const DepartmentId = boundedIdentifier.pipe(Schema.brand("DepartmentId"))
export type DepartmentId = typeof DepartmentId.Type

export const SemesterId = boundedIdentifier.pipe(Schema.brand("SemesterId"))
export type SemesterId = typeof SemesterId.Type

export const Cycle = Schema.Struct({
  departmentId: DepartmentId,
  semesterId: SemesterId,
})
export type Cycle = typeof Cycle.Type

export const AssignedInterviewId = boundedIdentifier.pipe(Schema.brand("AssignedInterviewId"))
export type AssignedInterviewId = typeof AssignedInterviewId.Type

export const ResponseCapability = boundedIdentifier.pipe(Schema.brand("ResponseCapability"))
export type ResponseCapability = typeof ResponseCapability.Type


export class AssignedInterview extends Schema.Class<AssignedInterview>("AssignedInterview")({
  id: AssignedInterviewId,
  applicationId: Schema.String,
  applicantLabel: Schema.String,
  cycle: Cycle,
  interviewerLabel: Schema.String,
  schedulingStatus: InterviewSchedulingStatus,
  interviewTime: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
}) {}
const RawAssignedInterview = Schema.Struct({
  id: Schema.String,
  applicationId: Schema.String,
  applicantLabel: Schema.String,
  cycle: Schema.Struct({
    departmentId: Schema.String,
    semesterId: Schema.String,
  }),
  interviewerLabel: Schema.String,
  schedulingStatus: Schema.Number,
  interviewTime: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
})

export const AssignedInterviewFromRaw = RawAssignedInterview.pipe(
  Schema.decodeTo(AssignedInterview, {
    decode: SchemaGetter.transform((raw: Schema.Schema.Type<typeof RawAssignedInterview>) => ({
      id: Schema.decodeUnknownSync(AssignedInterviewId)(raw.id),
      applicationId: raw.applicationId,
      applicantLabel: raw.applicantLabel,
      cycle: Schema.decodeUnknownSync(Cycle)(raw.cycle),
      interviewerLabel: raw.interviewerLabel,
      schedulingStatus: parseInterviewStatus(raw.schedulingStatus),
      interviewTime: raw.interviewTime,
      room: raw.room,
      campus: raw.campus,
    })),
    encode: SchemaGetter.transform((interview) => ({
      id: interview.id,
      applicationId: interview.applicationId,
      applicantLabel: interview.applicantLabel,
      cycle: interview.cycle,
      interviewerLabel: interview.interviewerLabel,
      schedulingStatus: 0,
      interviewTime: interview.interviewTime,
      room: interview.room,
      campus: interview.campus,
    })),
  }),
)

export class CandidateInterviewView extends Schema.Class<CandidateInterviewView>("CandidateInterviewView")({
  schedulingStatus: InterviewSchedulingStatus,
  interviewTime: Schema.String,
  room: Schema.String,
  campus: Schema.String,
}) {}


/**
 * Raw API response shape — schedulingStatus is an integer from the server.
 */
const RawInterview = Schema.Struct({
  id: Schema.Number,
  applicationId: Schema.Number,
  interviewerId: Schema.NullOr(Schema.Number),
  interviewerName: Schema.NullOr(Schema.String),
  schedulingStatus: Schema.Number,
  interviewTime: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
  schemaId: Schema.NullOr(Schema.Number),
})

/**
 * Interview with derived string schedulingStatus.
 */
export class Interview extends Schema.Class<Interview>("Interview")({
  id: Schema.Number,
  applicationId: Schema.Number,
  interviewerId: Schema.NullOr(Schema.Number),
  interviewerName: Schema.NullOr(Schema.String),
  schedulingStatus: InterviewSchedulingStatus,
  interviewTime: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
  schemaId: Schema.NullOr(Schema.Number),
}) {}

/**
 * Transform: raw API response (integer schedulingStatus) → Interview (string schedulingStatus).
 */
export const InterviewFromRaw = RawInterview.pipe(
  Schema.decodeTo(Interview, {
    decode: SchemaGetter.transform((raw: Schema.Schema.Type<typeof RawInterview>) => ({
      id: raw.id,
      applicationId: raw.applicationId,
      interviewerId: raw.interviewerId,
      interviewerName: raw.interviewerName,
      schedulingStatus: parseInterviewStatus(raw.schedulingStatus),
      interviewTime: raw.interviewTime,
      room: raw.room,
      campus: raw.campus,
      schemaId: raw.schemaId,
    })),
    encode: SchemaGetter.transform((interview) => ({
      id: interview.id,
      applicationId: interview.applicationId,
      interviewerId: interview.interviewerId,
      interviewerName: interview.interviewerName,
      schedulingStatus: 0, // reverse mapping not needed for read-only domain
      interviewTime: interview.interviewTime,
      room: interview.room,
      campus: interview.campus,
      schemaId: interview.schemaId,
    })),
  }),
)

/**
 * InterviewSchema_ — the schema/template used for conducting interviews.
 * (Trailing underscore to avoid clash with the ES `Schema` class name.)
 */
export class InterviewSchema_ extends Schema.Class<InterviewSchema_>("InterviewSchema")({
  id: Schema.Number,
  name: Schema.String,
  questions: Schema.Array(Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    type: Schema.String,
  })),
}) {}

/**
 * Input type for scheduling an interview.
 */
export class InterviewScheduleInput extends Schema.Class<InterviewScheduleInput>("InterviewScheduleInput")({
  interviewTime: Schema.String,
  room: Schema.String,
  campus: Schema.String,
}) {}
