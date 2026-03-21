/**
 * Application schema — transforms integer applicationStatus from the API
 * into a typed string enum using adapter/status.ts.
 */

import { Schema } from "effect"
import { parseApplicationStatus } from "../adapter/status.js"

export const ApplicationStatus = Schema.Literal(
  "not_received",
  "received",
  "invited",
  "accepted",
  "completed",
  "assigned",
  "cancelled",
)
export type ApplicationStatus = Schema.Schema.Type<typeof ApplicationStatus>

/**
 * Raw API response shape — applicationStatus is an integer from the server.
 */
const RawApplication = Schema.Struct({
  id: Schema.Number,
  userName: Schema.String,
  userEmail: Schema.String,
  applicationStatus: Schema.Number,
  interviewStatus: Schema.NullOr(Schema.String),
  interviewer: Schema.NullOr(Schema.String),
  interviewScheduled: Schema.NullOr(Schema.String),
  previousParticipation: Schema.Boolean,
})

/**
 * Application with derived string status.
 */
export class Application extends Schema.Class<Application>("Application")({
  id: Schema.Number,
  userName: Schema.String,
  userEmail: Schema.String,
  status: ApplicationStatus,
  interviewStatus: Schema.NullOr(Schema.String),
  interviewer: Schema.NullOr(Schema.String),
  interviewScheduled: Schema.NullOr(Schema.String),
  previousParticipation: Schema.Boolean,
}) {
  get statusLabel(): string {
    const labels: Record<string, string> = {
      not_received: "Ikke mottatt",
      received: "Mottatt",
      invited: "Invitert",
      accepted: "Akseptert",
      completed: "Fullført",
      assigned: "Tildelt skole",
      cancelled: "Avbrutt",
    }
    return labels[this.status] ?? this.status
  }
}

/**
 * Transform: raw API response (integer status) → Application (string status).
 */
export const ApplicationFromRaw = Schema.transform(
  RawApplication,
  Application,
  {
    strict: false,
    decode: (raw) => ({
      ...raw,
      status: parseApplicationStatus(raw.applicationStatus),
    }),
    encode: (app) => ({
      id: app.id,
      userName: app.userName,
      userEmail: app.userEmail,
      applicationStatus: 0, // reverse mapping not needed for read-only domain
      interviewStatus: app.interviewStatus,
      interviewer: app.interviewer,
      interviewScheduled: app.interviewScheduled,
      previousParticipation: app.previousParticipation,
    }),
  },
)

/**
 * ApplicationDetail — richer view returned by the single-item GET endpoint.
 * Extends Application fields with additional detail fields if available.
 */
export class ApplicationDetail extends Schema.Class<ApplicationDetail>("ApplicationDetail")({
  id: Schema.Number,
  userName: Schema.String,
  userEmail: Schema.String,
  status: ApplicationStatus,
  interviewStatus: Schema.NullOr(Schema.String),
  interviewer: Schema.NullOr(Schema.String),
  interviewScheduled: Schema.NullOr(Schema.String),
  previousParticipation: Schema.Boolean,
}) {}

const RawApplicationDetail = Schema.Struct({
  id: Schema.Number,
  userName: Schema.String,
  userEmail: Schema.String,
  applicationStatus: Schema.Number,
  interviewStatus: Schema.NullOr(Schema.String),
  interviewer: Schema.NullOr(Schema.String),
  interviewScheduled: Schema.NullOr(Schema.String),
  previousParticipation: Schema.Boolean,
})

export const ApplicationDetailFromRaw = Schema.transform(
  RawApplicationDetail,
  ApplicationDetail,
  {
    strict: false,
    decode: (raw) => ({
      ...raw,
      status: parseApplicationStatus(raw.applicationStatus),
    }),
    encode: (app) => ({
      id: app.id,
      userName: app.userName,
      userEmail: app.userEmail,
      applicationStatus: 0,
      interviewStatus: app.interviewStatus,
      interviewer: app.interviewer,
      interviewScheduled: app.interviewScheduled,
      previousParticipation: app.previousParticipation,
    }),
  },
)
