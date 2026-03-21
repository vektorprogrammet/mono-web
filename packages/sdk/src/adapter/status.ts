/**
 * Status integer -> string enum transforms for Symfony API responses.
 */

const APPLICATION_STATUS_MAP: Record<number, string> = {
  0: "not_received",
  1: "received",
  2: "invited",
  3: "accepted",
  4: "completed",
  5: "assigned",
  [-1]: "cancelled",
}

const INTERVIEW_STATUS_MAP: Record<number, string> = {
  0: "pending",
  1: "accepted",
  2: "request_new_time",
  3: "cancelled",
  4: "no_contact",
}

export type ApplicationStatus =
  | "not_received" | "received" | "invited" | "accepted"
  | "completed" | "assigned" | "cancelled"

export type InterviewSchedulingStatus =
  | "pending" | "accepted" | "request_new_time" | "cancelled" | "no_contact"

export function parseApplicationStatus(raw: number): ApplicationStatus {
  const status = APPLICATION_STATUS_MAP[raw]
  if (!status) throw new Error(`Unknown application status: ${raw}`)
  return status as ApplicationStatus
}

export function parseInterviewStatus(raw: number): InterviewSchedulingStatus {
  const status = INTERVIEW_STATUS_MAP[raw]
  if (!status) throw new Error(`Unknown interview status: ${raw}`)
  return status as InterviewSchedulingStatus
}
