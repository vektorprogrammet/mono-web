// Re-export the Promise surface as the default API
export { createClient, type Sdk, type ClientOptions } from "./promise.js";
export { apiUrl, isFixtureMode } from "./config.js";

// Error types for instanceof checks
export {
  SdkError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  ConflictError,
  NetworkError,
  RateLimitedError,
  ConfigurationError,
  ReceiptRejectionError,
  UnauthenticatedActorError,
  InactiveActorError,
  ReceiptOwnerDeniedError,
  ReceiptScopeDeniedError,
  ReceiptDecodeSdkError,
  ReceiptAlreadyExistsError,
  DuplicateReceiptCommandConflictError,
  ReceiptNotFoundError,
  StaleReceiptRevisionError,
  InvalidReceiptTransitionError,
  ReceiptFileNotStagedError,
  ReceiptPersistenceSdkError,
} from "./errors.js";
export type { SdkErrorType } from "./errors.js";
export type { ReceiptRejectionTag } from "./errors.js";

export type { Receipt, AdminReceipt, ReceiptInput } from "./schemas/receipt.js";
export {
  CommandId,
  CommandIdSchema,
  ReceiptCommandObservation,
  ReceiptCommandObservationSchema,
  ReceiptFile,
  ReceiptFileSchema,
  ReceiptId,
  ReceiptIdSchema,
  ReceiptOwnerFilter,
  ReceiptApprovalFilter,
  ReceiptApprovalFilterSchema,
  ReceiptOwnerFilterSchema,
  ReceiptPage,
  ReceiptPageSchema,
  ReceiptProjection,
  ReceiptProjectionSchema,
  ReceiptResolutionInput,
  ReceiptResolutionInputSchema,
  ReceiptReviseInput,
  ReceiptReviseInputSchema,
  ReceiptRevision,
  ReceiptRevisionSchema,
  ReceiptStatus,
  ReceiptStatusSchema,
  ReceiptSubmitInput,
  ReceiptSubmitInputSchema,
  ReceiptWithdrawInput,
  ReceiptWithdrawInputSchema,
} from "./schemas/receipt.js";
export type { Application, ApplicationDetail } from "./schemas/application.js";
export {
  AdminInterviewList,
  CandidateInterviewView,
  Interview,
  InterviewId,
  ResponseCapability,
  InterviewResponseRejectInput,
  InterviewResponseNewTimeInput,
  InterviewScheduleInput,
  InterviewSchedulingStatus,
} from "./schemas/interview.js";
export type { User, UserProfile } from "./schemas/user.js";
export type { DashboardStats } from "./schemas/dashboard.js";
export type {
  Department,
  Team,
  TeamInterest,
  FieldOfStudy,
  Sponsor,
  MailingList,
  AdmissionStats,
  Page,
} from "./schemas/common.js";
export type { SchedulingAssistant, SchedulingSchool, Substitute } from "./schemas/scheduling.js";
export type { ClientContext } from "./context.js";

export {
  AdmissionPeriodRejectionError,
  AdmissionRoleDeniedError,
  AdmissionScopeDeniedError,
  DepartmentRequiredError,
  DepartmentNotFoundError,
  SemesterNotFoundError,
  AdmissionPeriodNotFoundError,
  AdmissionPeriodDecodeSdkError,
  InvalidAdmissionPeriodWindowError,
  AdmissionWindowOutsideSemesterError,
  AdmissionPeriodAlreadyExistsError,
  StaleAdmissionPeriodRevisionError,
  DuplicateAdmissionPeriodCommandConflictError,
  AdmissionPeriodPersistenceSdkError,
  AdmissionApplicationRejectionError,
  AdmissionApplicationDecodeSdkError,
  NoOpenAdmissionPeriodError,
  AdmissionApplicationAlreadyExistsError,
  DuplicateAdmissionApplicationCommandConflictError,
  AdmissionApplicationPersistenceSdkError,
} from "./promise.js";
export type {
  AdmissionPeriodRejectionTag,
  AdmissionApplicationRejectionTag,
} from "./promise.js";
export {
  AdmissionPeriod,
  AdmissionPeriodProjection,
  AdmissionPeriodCreateInput,
  AdmissionPeriodReviseInput,
  AdmissionPeriodCommandObservation,
  AdmissionPeriodPage,
  AdmissionPeriodList,
  AdmissionApplication,
  AdmissionApplicationSubmitInput,
  AdmissionApplicationSubmitResponse,
} from "./promise.js";