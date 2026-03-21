/**
 * Interview schema — transforms integer schedulingStatus from the API
 * into a typed string enum using adapter/status.ts.
 */

import { Schema } from "effect"
import { parseInterviewStatus } from "../adapter/status.js"

export const InterviewSchedulingStatus = Schema.Literal(
  "pending",
  "accepted",
  "request_new_time",
  "cancelled",
  "no_contact",
)
export type InterviewSchedulingStatus = Schema.Schema.Type<typeof InterviewSchedulingStatus>

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
export const InterviewFromRaw = Schema.transform(
  RawInterview,
  Interview,
  {
    strict: false,
    decode: (raw) => ({
      ...raw,
      schedulingStatus: parseInterviewStatus(raw.schedulingStatus),
    }),
    encode: (interview) => ({
      id: interview.id,
      applicationId: interview.applicationId,
      interviewerId: interview.interviewerId,
      interviewerName: interview.interviewerName,
      schedulingStatus: 0, // reverse mapping not needed for read-only domain
      interviewTime: interview.interviewTime,
      room: interview.room,
      campus: interview.campus,
      schemaId: interview.schemaId,
    }),
  },
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
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
}) {}
