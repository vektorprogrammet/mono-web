/**
 * Interview schemas for the canonical administrative interview API.
 */

import { Schema, SchemaGetter } from "effect"
import {
  encodeInterviewStatusLabel,
  parseInterviewStatusLabel,
} from "../adapter/status.js"

export const InterviewSchedulingStatus = Schema.Literals([
  "created",
  "pending",
  "accepted",
  "request_new_time",
  "cancelled",
  "no_contact",
])
export type InterviewSchedulingStatus = Schema.Schema.Type<typeof InterviewSchedulingStatus>


const positiveInteger = Schema.Number.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: number) => Number.isInteger(value) && value > 0,
      { message: "a positive integer" },
    ),
  ),
)

export const InterviewId = positiveInteger.pipe(Schema.brand("InterviewId"))
export type InterviewId = typeof InterviewId.Type

const nonEmptyString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => value.trim().length > 0,
      { message: "a non-empty string" },
    ),
  ),
)
const validDatetime = nonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => Number.isFinite(Date.parse(value)),
      { message: "a valid datetime" },
    ),
  ),
)

/**
 * The single typed interview model used by the admin list and fresh reads.
 * Symfony names the wire fields `scheduled` and `status`; the SDK exposes the
 * domain names `interviewTime` and `schedulingStatus`.
 */
export class Interview extends Schema.Class<Interview>("Interview")({
  id: InterviewId,
  applicantName: Schema.String,
  interviewerName: Schema.NullOr(Schema.String),
  interviewTime: Schema.NullOr(Schema.String),
  schedulingStatus: InterviewSchedulingStatus,
  interviewed: Schema.Boolean,
  coInterviewer: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
  mapLink: Schema.NullOr(Schema.String),
}) {}

const RawInterview = Schema.Struct({
  id: Schema.Number,
  applicantName: Schema.String,
  interviewerName: Schema.NullOr(Schema.String),
  scheduled: Schema.NullOr(Schema.String),
  status: Schema.String,
  interviewed: Schema.Boolean,
  coInterviewer: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
  mapLink: Schema.NullOr(Schema.String),
})

type RawInterviewType = Schema.Schema.Type<typeof RawInterview>
type InterviewEncoded = Schema.Codec.Encoded<typeof Interview>

const decodeInterview = (raw: RawInterviewType): InterviewEncoded => ({
  id: Schema.decodeUnknownSync(InterviewId)(raw.id),
  applicantName: raw.applicantName,
  interviewerName: raw.interviewerName,
  interviewTime: raw.scheduled,
  schedulingStatus: parseInterviewStatusLabel(raw.status),
  interviewed: raw.interviewed,
  coInterviewer: raw.coInterviewer,
  room: raw.room,
  campus: raw.campus,
  mapLink: raw.mapLink,
})

const encodeInterview = (interview: InterviewEncoded): RawInterviewType => ({
  id: interview.id,
  applicantName: interview.applicantName,
  interviewerName: interview.interviewerName,
  scheduled: interview.interviewTime,
  status: encodeInterviewStatusLabel(interview.schedulingStatus),
  interviewed: interview.interviewed,
  coInterviewer: interview.coInterviewer,
  room: interview.room,
  campus: interview.campus,
  mapLink: interview.mapLink,
})

export const InterviewFromRaw = RawInterview.pipe(
  Schema.decodeTo(Interview, {
    decode: SchemaGetter.transform(decodeInterview),
    encode: SchemaGetter.transform(encodeInterview),
  }),
)

export class AdminInterviewList extends Schema.Class<AdminInterviewList>("AdminInterviewList")({
  interviews: Schema.Array(Interview),
}) {}

const RawAdminInterviewList = Schema.Struct({
  interviews: Schema.Array(RawInterview),
})

export const AdminInterviewListFromRaw = RawAdminInterviewList.pipe(
  Schema.decodeTo(AdminInterviewList, {
    decode: SchemaGetter.transform((raw: Schema.Schema.Type<typeof RawAdminInterviewList>) => ({
      interviews: raw.interviews.map(decodeInterview),
    })),
    encode: SchemaGetter.transform((list) => ({
      interviews: list.interviews.map(encodeInterview),
    })),
  }),
)

export class InterviewSchema_ extends Schema.Class<InterviewSchema_>("InterviewSchema")({
  id: Schema.Number,
  name: Schema.String,
  questionCount: Schema.Number,
}) {}


/**
 * All fields are required because Symfony dispatches each field to the
 * notification event after it persists the schedule.
 */
export class InterviewScheduleInput extends Schema.Class<InterviewScheduleInput>(
  "InterviewScheduleInput",
)({
  datetime: validDatetime,
  room: nonEmptyString,
  campus: nonEmptyString,
  mapLink: nonEmptyString,
  from: nonEmptyString,
  to: nonEmptyString,
  message: nonEmptyString,
}) {}
