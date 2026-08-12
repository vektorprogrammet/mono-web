/**
 * Status integer -> string enum transforms for Symfony API responses.
 */

export type ApplicationStatus =
  | "not_received" | "received" | "invited" | "accepted"
  | "completed" | "assigned" | "cancelled"

export const APPLICATION_STATUS_CODES = [-1, 0, 1, 2, 3, 4, 5] as const
export type ApplicationStatusCode = typeof APPLICATION_STATUS_CODES[number]

const APPLICATION_STATUS_MAP: Partial<Record<number, ApplicationStatus>> = {
  [-1]: "cancelled",
  0: "not_received",
  1: "received",
  2: "invited",
  3: "accepted",
  4: "completed",
  5: "assigned",
} satisfies Record<ApplicationStatusCode, ApplicationStatus>

const INTERVIEW_STATUS_MAP: Record<number, string> = {
  0: "pending",
  1: "accepted",
  2: "request_new_time",
  3: "cancelled",
  4: "no_contact",
}

export type InterviewSchedulingStatus =
  | "pending" | "accepted" | "request_new_time" | "cancelled" | "no_contact"

export function parseApplicationStatus(raw: ApplicationStatusCode): ApplicationStatus
export function parseApplicationStatus(raw: number): ApplicationStatus | undefined
export function parseApplicationStatus(raw: number): ApplicationStatus | undefined {
  return APPLICATION_STATUS_MAP[raw]
}

export function parseInterviewStatus(raw: number): InterviewSchedulingStatus {
  const status = INTERVIEW_STATUS_MAP[raw]
  if (!status) throw new Error(`Unknown interview status: ${raw}`)
  return status as InterviewSchedulingStatus
}
