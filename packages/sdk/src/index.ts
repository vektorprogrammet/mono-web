// Re-export the Promise surface as the default API
export { createClient, type Sdk, type ClientOptions } from "./promise.js"
export { apiUrl, isFixtureMode } from "./config.js"

// Error types for instanceof checks
export {
  SdkError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  ConflictError,
  NetworkError,
  RateLimitedError,
} from "./errors.js"

// Domain types (re-exported from Schema classes)
export type { Receipt, AdminReceipt, ReceiptInput } from "./schemas/receipt.js"
export type { Application, ApplicationDetail } from "./schemas/application.js"
export type { Interview, InterviewScheduleInput } from "./schemas/interview.js"
export type { User, UserProfile } from "./schemas/user.js"
export type { DashboardStats } from "./schemas/dashboard.js"
export type {
  Department,
  Team,
  TeamInterest,
  FieldOfStudy,
  Sponsor,
  MailingList,
  AdmissionStats,
  Page,
} from "./schemas/common.js"
export type { SchedulingAssistant, SchedulingSchool, Substitute } from "./schemas/scheduling.js"
export type { ClientContext } from "./context.js"
