/**
 * Symfony status-code and status-label transforms for SDK interview/application responses.
 */

export type ApplicationStatus =
  | "not_received"
  | "received"
  | "invited"
  | "accepted"
  | "completed"
  | "assigned"
  | "cancelled";

export const APPLICATION_STATUS_CODES = [-1, 0, 1, 2, 3, 4, 5] as const;
export type ApplicationStatusCode = (typeof APPLICATION_STATUS_CODES)[number];

const APPLICATION_STATUS_CODE_BY_STATUS: Record<ApplicationStatus, ApplicationStatusCode> = {
  cancelled: -1,
  not_received: 0,
  received: 1,
  invited: 2,
  accepted: 3,
  completed: 4,
  assigned: 5,
};

const APPLICATION_STATUS_MAP: Partial<Record<number, ApplicationStatus>> = {
  [-1]: "cancelled",
  0: "not_received",
  1: "received",
  2: "invited",
  3: "accepted",
  4: "completed",
  5: "assigned",
} satisfies Record<ApplicationStatusCode, ApplicationStatus>;

export type InterviewSchedulingStatus =
  | "created"
  | "pending"
  | "accepted"
  | "request_new_time"
  | "cancelled"
  | "no_contact";

export const INTERVIEW_STATUS_CODES = [0, 1, 2, 3, 4] as const;
export type InterviewStatusCode = (typeof INTERVIEW_STATUS_CODES)[number];

const INTERVIEW_STATUS_MAP: Record<InterviewStatusCode, InterviewSchedulingStatus> = {
  0: "pending",
  1: "accepted",
  2: "request_new_time",
  3: "cancelled",
  4: "no_contact",
};

const INTERVIEW_STATUS_CODE_BY_STATUS: Record<InterviewSchedulingStatus, InterviewStatusCode> = {
  created: 0,
  pending: 0,
  accepted: 1,
  request_new_time: 2,
  cancelled: 3,
  no_contact: 4,
};

export function parseApplicationStatus(raw: ApplicationStatusCode): ApplicationStatus;
export function parseApplicationStatus(raw: number): ApplicationStatus | undefined;
export function parseApplicationStatus(raw: number): ApplicationStatus | undefined {
  return APPLICATION_STATUS_MAP[raw];
}

export const encodeApplicationStatus = (status: ApplicationStatus): ApplicationStatusCode =>
  APPLICATION_STATUS_CODE_BY_STATUS[status];

export function parseInterviewStatus(raw: number): InterviewSchedulingStatus {
  const status = INTERVIEW_STATUS_MAP[raw as InterviewStatusCode];
  if (!status) throw new Error(`Unknown interview status: ${raw}`);
  return status;
}

const INTERVIEW_STATUS_LABEL_MAP: Record<string, InterviewSchedulingStatus> = {
  "Ikke satt opp": "created",
  "Ikke oppnådd kontakt": "no_contact",
  "Ingen svar": "pending",
  Akseptert: "accepted",
  "Ny tid ønskes": "request_new_time",
  Kansellert: "cancelled",
  created: "created",
  pending: "pending",
  accepted: "accepted",
  request_new_time: "request_new_time",
  cancelled: "cancelled",
  no_contact: "no_contact",
};

export function parseInterviewStatusLabel(raw: string): InterviewSchedulingStatus {
  const status = INTERVIEW_STATUS_LABEL_MAP[raw.trim()];
  if (!status) throw new Error(`Unknown interview status label: ${raw}`);
  return status;
}

export const encodeInterviewStatusLabel = (status: InterviewSchedulingStatus): string => {
  switch (status) {
    case "created":
      return "Ikke satt opp";
    case "pending":
      return "Ingen svar";
    case "accepted":
      return "Akseptert";
    case "request_new_time":
      return "Ny tid ønskes";
    case "cancelled":
      return "Kansellert";
    case "no_contact":
      return "Ikke oppnådd kontakt";
  }
};

export const encodeInterviewStatus = (status: InterviewSchedulingStatus): InterviewStatusCode =>
  INTERVIEW_STATUS_CODE_BY_STATUS[status];
