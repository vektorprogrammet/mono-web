/**
 * Interview schemas — canonical Symfony list, schedule, and response models.
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

const boundedIdentifier = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  Schema.check(
    Schema.makeFilter(
      (value: string) => /^\w+$/.test(value),
      { message: "letters, numbers, and underscores only" },
    ),
  ),
)

export const ResponseCapability = boundedIdentifier.pipe(Schema.brand("ResponseCapability"))
export type ResponseCapability = typeof ResponseCapability.Type

const responseMessage = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(2000)),
)

export const InterviewResponseRejectInput = Schema.Struct({
  message: responseMessage,
})
export type InterviewResponseRejectInput = typeof InterviewResponseRejectInput.Type

export const InterviewResponseNewTimeInput = Schema.Struct({
  message: responseMessage.pipe(
    Schema.check(
      Schema.makeFilter(
        (value: string) => value.trim().length > 0,
        { message: "a non-empty message" },
      ),
    ),
  ),
})
export type InterviewResponseNewTimeInput = typeof InterviewResponseNewTimeInput.Type

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

export class CandidateInterviewView extends Schema.Class<CandidateInterviewView>(
  "CandidateInterviewView",
)({
  schedulingStatus: InterviewSchedulingStatus,
  interviewTime: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
}) {}

const RawCandidateInterviewView = Schema.Struct({
  id: Schema.Number,
  scheduled: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
  mapLink: Schema.NullOr(Schema.String),
  interviewerName: Schema.NullOr(Schema.String),
  status: Schema.String,
})


export const CandidateInterviewViewFromRaw = RawCandidateInterviewView.pipe(
  Schema.decodeTo(CandidateInterviewView, {
    decode: SchemaGetter.transform((raw: Schema.Schema.Type<typeof RawCandidateInterviewView>) => ({
      schedulingStatus: parseInterviewStatusLabel(raw.status),
      interviewTime: raw.scheduled,
      room: raw.room,
      campus: raw.campus,
    })),
    encode: SchemaGetter.transform((candidate) => ({
      id: 0,
      scheduled: candidate.interviewTime,
      room: candidate.room,
      campus: candidate.campus,
      mapLink: null,
      interviewerName: null,
      status: encodeInterviewStatusLabel(candidate.schedulingStatus),
    })),
  }),
)

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
