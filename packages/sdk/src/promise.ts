/**
 * Promise-based public surface for the SDK.
 * Re-exports everything consumers need without requiring an Effect dependency.
 *
 * This is the default entrypoint (`"."`).
 */

import { Effect } from "effect";
import { createTransport, type AuthOption } from "./transport.js";
import { toSdkError, type InternalSdkError } from "./errors.js";
import { createContext } from "./context.js";
import { createAuthDomain } from "./domains/auth.js";
import { createMeDomain } from "./domains/me.js";
import { createReceiptsDomain } from "./domains/receipts.js";
import { createAdminReceiptsDomain } from "./domains/admin/receipts.js";
import { createAdminApplicationsDomain } from "./domains/admin/applications.js";
import { createAdminInterviewsDomain } from "./domains/admin/interviews.js";
import { createAdminRecruitmentDomain } from "./domains/admin/recruitment.js";
import { createInterviewResponsesDomain } from "./domains/interview-responses.js";
import { createAdminSchedulingDomain } from "./domains/admin/scheduling.js";
import { createAdminTeamsDomain } from "./domains/admin/teams.js";
import { createAdminMiscDomain } from "./domains/admin/misc.js";
import { createPublicMiscDomain } from "./domains/public/misc.js";
import { createPublicContactMessageDomain } from "./domains/public/contact-message.js";
import { createPublicTeamsDomain } from "./domains/public/teams.js";
import { createAdminUsersDomain } from "./domains/admin/users.js";
import { createAdmissionApplicationsDomain } from "./domains/admission-applications.js";
import { createAdmissionPeriodsDomain } from "./domains/admission-period.js";

// --- Public re-exports ---

export type { ClientContext } from "./context.js";
export { apiUrl, isFixtureMode } from "./config.js";
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
  PublicApplicationRejectionError,
  PublicApplicationDecodeSdkError,
  NoEligibleAdmissionPeriodError,
  PublicApplicationDepartmentNotFoundError,
  PublicApplicationFieldOfStudyNotFoundError,
  PublicApplicationFieldOfStudyInactiveError,
  PublicApplicationFieldOfStudyDepartmentMismatchError,
  DuplicatePublicApplicationError,
  DuplicatePublicApplicationCommandConflictError,
  RequestBodyTooLargeError,
  PublicApplicationRateLimitExceededError,
  PublicApplicationNotFoundError,
  PublicApplicationPersistenceSdkError,
  RecruitmentRejectionError,
  RecruitmentUnauthenticatedActorError,
  RecruitmentInactiveActorError,
  RecruitmentRoleDeniedError,
  RecruitmentScopeDeniedError,
  RecruitmentAdmissionPeriodNotFoundError,
  RecruitmentAmbiguousAdmissionPeriodError,
  RecruitmentApplicationNotFoundError,
  RecruitmentApplicationAlreadyAssignedError,
  RecruitmentInterviewSchemaNotFoundError,
  RecruitmentInterviewSchemaInactiveError,
  RecruitmentInterviewerNotEligibleError,
  RecruitmentAssignmentCommandConflictError,
  RecruitmentDecodeSdkError,
  RecruitmentPersistenceSdkError,
} from "./errors.js";
export type {
  SdkErrorType,
  ReceiptRejectionTag,
  AdmissionPeriodRejectionTag,
  PublicApplicationRejectionTag,
  RecruitmentRejectionTag,
} from "./errors.js";

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
export type {
  AdmissionPeriodId,
  AdmissionCommandId,
  AdmissionRevision,
  Rfc3339Instant,
  AdmissionPeriodCommandObservation,
  AdmissionPeriodList,
} from "./schemas/admission-period.js";
export {
  AdmissionPeriod,
  AdmissionPeriodSchema,
  AdmissionPeriodProjection,
  AdmissionPeriodProjectionSchema,
  AdmissionPeriodCreateInput,
  AdmissionPeriodCreateInputSchema,
  AdmissionPeriodReviseInput,
  AdmissionPeriodReviseInputSchema,
  AdmissionPeriodPage,
  AdmissionPeriodPageSchema,
  AdmissionPeriodListSchema,
  AdmissionPeriodIdSchema,
  AdmissionCommandIdSchema,
  AdmissionRevisionSchema,
  Rfc3339InstantSchema,
} from "./schemas/admission-period.js";
export {
  PublicApplicationSubmitInput,
  PublicApplicationSubmitInputSchema,
  PublicApplicationSubmitResponse,
  PublicApplicationSubmitResponseSchema,
  PublicApplicationFieldOfStudy,
  PublicApplicationFieldOfStudySchema,
  PublicApplicationDepartment,
  PublicApplicationDepartmentSchema,
  PublicApplicationCatalog,
  PublicApplicationCatalogSchema,
  PublicApplicationConfirmation,
  PublicApplicationConfirmationSchema,
} from "./schemas/admission-application.js";
export { ContactMessageInput, ContactMessageInputSchema } from "./schemas/contact-message.js";
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
export {
  RecruitmentAdmissionPeriodId,
  InterviewSchemaId,
  RecruitmentInterviewId,
  RecruitmentAssignmentCommandId,
  RecruitmentApplicationId,
  RecruitmentApplicantId,
  RecruitmentPersonId,
  RecruitmentDepartmentId,
  RecruitmentAssignmentStatusSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentCandidateSchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentAssignmentObservationSchema,
  RecruitmentAssignmentResultSchema,
  RecruitmentInterviewSchema,
  RecruitmentInterviewerOptionSchema,
  RecruitmentInterviewSchemaOptionSchema,
} from "./schemas/recruitment.js";
export type {
  RecruitmentAssignmentStatus,
  RecruitmentAssignmentBoardQuery,
  RecruitmentAssignmentBoard,
  RecruitmentAssignmentCandidate,
  RecruitmentAssignmentCommand,
  RecruitmentAssignmentObservation,
  RecruitmentAssignmentResult,
  RecruitmentInterview,
  RecruitmentInterviewerOption,
  RecruitmentInterviewSchemaOption,
} from "./schemas/recruitment.js";
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

// --- Client options ---

export type ClientOptions = {
  auth?: AuthOption;
};

// --- Promisify helpers ---

/**
 * Wraps a single Effect-returning function into a Promise-returning function.
 * Maps InternalSdkError to public SdkError subclasses at the boundary.
 */
function promisify<Args extends unknown[], A>(
  fn: (...args: Args) => Effect.Effect<A, InternalSdkError>,
): (...args: Args) => Promise<A> {
  return (...args) => Effect.runPromise(fn(...args).pipe(Effect.mapError(toSdkError)));
}

/**
 * Wraps an entire domain object — every method becomes Promise-returning.
 */
function promisifyDomain<T extends object>(
  domain: T,
): {
  [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, any>
    ? (...args: A) => Promise<R>
    : never;
} {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(domain)) {
    result[key] = promisify((domain as any)[key] as any);
  }
  return result as any;
}

// --- Client factory ---
export function createClient(baseUrl: string | undefined, options?: ClientOptions) {
  const transport = createTransport(baseUrl, options?.auth);
  const initialToken = typeof options?.auth === "string" ? options.auth : undefined;
  const context = createContext(initialToken);

  const adminMisc = createAdminMiscDomain(transport);
  const publicMisc = createPublicMiscDomain(transport);
  const publicTeams = createPublicTeamsDomain(transport);
  const publicContactMessages = createPublicContactMessageDomain(transport);

  return {
    auth: promisifyDomain(createAuthDomain(transport)),
    me: promisifyDomain(createMeDomain(transport)),
    receipts: promisifyDomain(createReceiptsDomain(transport)),
    admissionPeriods: promisifyDomain(createAdmissionPeriodsDomain(transport)),
    applications: promisifyDomain(createAdmissionApplicationsDomain(transport)),
    admin: {
      receipts: promisifyDomain(createAdminReceiptsDomain(transport)),
      applications: promisifyDomain(createAdminApplicationsDomain(transport)),
      interviews: promisifyDomain(createAdminInterviewsDomain(transport)),
      recruitment: promisifyDomain(createAdminRecruitmentDomain(transport)),
      users: promisifyDomain(createAdminUsersDomain(transport)),
      scheduling: promisifyDomain(createAdminSchedulingDomain(transport)),
      teams: promisifyDomain(createAdminTeamsDomain(transport)),
      mailingLists: promisify(adminMisc.mailingLists.bind(adminMisc)),
      admissionStats: promisify(adminMisc.admissionStats.bind(adminMisc)),
    },
    interviewResponses: promisifyDomain(createInterviewResponsesDomain(transport)),
    public: {
      departments: promisify(publicMisc.departments.bind(publicMisc)),
      fieldOfStudies: promisify(publicMisc.fieldOfStudies.bind(publicMisc)),
      sponsors: promisify(publicMisc.sponsors.bind(publicMisc)),
      teams: promisify(publicTeams.list.bind(publicTeams)),
      contactMessages: promisifyDomain(publicContactMessages),
    },
    context,
  };
}

export type Sdk = ReturnType<typeof createClient>;
