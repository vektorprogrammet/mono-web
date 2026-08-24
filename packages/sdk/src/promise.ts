/**
 * Promise-based public surface for the SDK.
 * Re-exports everything consumers need without requiring an Effect dependency.
 *
 * This is the default entrypoint (`"."`).
 */

import { Effect } from "effect";
import { createTransport, type CookieOption } from "./transport.js";
import { toSdkError, type InternalSdkError } from "./errors.js";
import { createAuthDomain } from "./domains/auth.js";
import { createMeDomain } from "./domains/me.js";
import { createReceiptsDomain } from "./domains/receipts.js";
import { createAdminReceiptsDomain } from "./domains/admin/receipts.js";
import { createAdminApplicationsDomain } from "./domains/admin/applications.js";
import { createAdminInterviewsDomain } from "./domains/admin/interviews.js";
import { createAdminRecruitmentDomain } from "./domains/admin/recruitment.js";
import { createRecruitmentInvitationResponsesDomain } from "./domains/recruitment-invitation-responses.js";
import { createAdminOrganizationDomain } from "./domains/admin/organization.js";
import { createAdminSchedulingDomain } from "./domains/admin/scheduling.js";
import { createAdminTeamsDomain } from "./domains/admin/teams.js";
import { createAdminMiscDomain } from "./domains/admin/misc.js";
import { createPublicMiscDomain } from "./domains/public/misc.js";
import { createPublicOrganizationDomain } from "./domains/public/organization.js";
import { createPublicContactMessageDomain } from "./domains/public/contact-message.js";
import { createAdminUsersDomain } from "./domains/admin/users.js";
import { createAdmissionApplicationsDomain } from "./domains/admission-applications.js";
import { createAdmissionPeriodsDomain } from "./domains/admission-period.js";

// --- Public re-exports ---

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
  NotInScopeError,
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
  RecruitmentInterviewNotFoundError,
  RecruitmentInvitationNotFoundError,
  RecruitmentInvitationAlreadyRespondedError,
  RecruitmentInterviewAlreadyScheduledError,
  RecruitmentInterviewStaleRevisionError,
  RecruitmentScheduleCommandConflictError,
  RecruitmentScheduleInPastError,
  RecruitmentProfileContactNotFoundError,
  OrganizationRejectionError,
  OrganizationUnauthenticatedActorError,
  OrganizationRoleDeniedError,
  OrganizationInvalidReferenceError,
  OrganizationCommandConflictError,
  OrganizationDecodeSdkError,
  OrganizationRequestBodyTooLargeError,
  OrganizationPersistenceSdkError,
} from "./errors.js";
export type {
  SdkErrorType,
  ReceiptRejectionTag,
  AdmissionPeriodRejectionTag,
  PublicApplicationRejectionTag,
  RecruitmentRejectionTag,
  OrganizationRejectionTag,
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
  Interview,
  InterviewId,
  InterviewScheduleInput,
  InterviewSchedulingStatus,
} from "./schemas/interview.js";
export {
  RecruitmentAdmissionPeriodId,
  InterviewSchemaId,
  RecruitmentInterviewId,
  RecruitmentAssignmentCommandId,
  RecruitmentScheduleCommandId,
  RecruitmentInvitationId,
  RecruitmentNotificationEffectId,
  RecruitmentInvitationCapabilitySchema,
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
  RecruitmentInvitationResponseStateSchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentNotificationDeliveryStateSchema,
  RecruitmentInterviewScheduleSchema,
  RecruitmentSchedulingApplicantSchema,
  RecruitmentSchedulingInterviewerSchema,
  RecruitmentSchedulingInterviewSchema,
  RecruitmentSchedulingBoardSchema,
  RecruitmentScheduleCommandSchema,
  RecruitmentScheduleObservationSchema,
  RecruitmentScheduleResultSchema,
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
  RecruitmentInvitationResponseState,
  RecruitmentInvitationCapability,
  RecruitmentInvitationResponseMessage,
  RecruitmentInvitationRejectInput,
  RecruitmentInvitationRequestNewTimeInput,
  RecruitmentInvitationResponseObservation,
  RecruitmentNotificationDeliveryState,
  RecruitmentInterviewSchedule,
  RecruitmentSchedulingApplicant,
  RecruitmentSchedulingInterviewer,
  RecruitmentSchedulingInterview,
  RecruitmentSchedulingBoard,
  RecruitmentScheduleCommand,
  RecruitmentScheduleObservation,
  RecruitmentScheduleResult,
  RecruitmentInterviewSchemaOption,
} from "./schemas/recruitment.js";
export {
  ProfileCommandId,
  SessionActor,
  UpdateOwnProfileCommand,
  UserProfile,
  UserRole,
  type User,
} from "./schemas/user.js";
export type { DashboardStats } from "./schemas/dashboard.js";
export type { TeamInterest, Sponsor, MailingList, AdmissionStats, Page } from "./schemas/common.js";
export {
  DepartmentId,
  TeamId,
  FieldOfStudyId,
  OrganizationCommandId,
  OrganizationEntityKindSchema,
  DepartmentJsonSchema,
  TeamJsonSchema,
  FieldOfStudyJsonSchema,
  DepartmentListSchema,
  TeamListSchema,
  FieldOfStudyListSchema,
  CreateDepartmentCommandSchema,
  CreateTeamCommandSchema,
  CreateFieldOfStudyCommandSchema,
  OrganizationCreateCommandSchema,
  DepartmentCreatedObservationSchema,
  TeamCreatedObservationSchema,
  FieldOfStudyCreatedObservationSchema,
  OrganizationCreatedObservationSchema,
  DepartmentReplayedObservationSchema,
  TeamReplayedObservationSchema,
  FieldOfStudyReplayedObservationSchema,
  OrganizationReplayedObservationSchema,
  OrganizationCreateObservationSchema,
  CreateDepartmentResultSchema,
  CreateTeamResultSchema,
  CreateFieldOfStudyResultSchema,
  OrganizationCreateResultSchema,
} from "./schemas/organization.js";
export type {
  OrganizationEntityKind,
  DepartmentJson,
  TeamJson,
  FieldOfStudyJson,
  DepartmentList,
  TeamList,
  FieldOfStudyList,
  CreateDepartmentCommand,
  CreateTeamCommand,
  CreateFieldOfStudyCommand,
  OrganizationCreateCommand,
  DepartmentCreatedObservation,
  TeamCreatedObservation,
  FieldOfStudyCreatedObservation,
  OrganizationCreatedObservation,
  DepartmentReplayedObservation,
  TeamReplayedObservation,
  FieldOfStudyReplayedObservation,
  OrganizationReplayedObservation,
  OrganizationCreateObservation,
  CreateDepartmentResult,
  CreateTeamResult,
  CreateFieldOfStudyResult,
  OrganizationCreateResult,
} from "./schemas/organization.js";
export type { SchedulingAssistant, SchedulingSchool, Substitute } from "./schemas/scheduling.js";

// --- Client options ---

export type ClientOptions = {
  cookie?: CookieOption;
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
  const transport = createTransport(baseUrl, options?.cookie);

  const adminMisc = createAdminMiscDomain(transport);
  const publicMisc = createPublicMiscDomain(transport);
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
      organization: promisifyDomain(createAdminOrganizationDomain(transport)),
      teams: promisifyDomain(createAdminTeamsDomain(transport)),
      mailingLists: promisify(adminMisc.mailingLists.bind(adminMisc)),
      admissionStats: promisify(adminMisc.admissionStats.bind(adminMisc)),
    },
    recruitmentInvitationResponses: promisifyDomain(
      createRecruitmentInvitationResponsesDomain(transport),
    ),
    public: {
      organization: promisifyDomain(createPublicOrganizationDomain(transport)),
      sponsors: promisify(publicMisc.sponsors.bind(publicMisc)),
      contactMessages: promisifyDomain(publicContactMessages),
    },
  };
}

export type Sdk = ReturnType<typeof createClient>;

export type { AdminUsersPage, AdminUsersResult, DirectoryEntry } from "./domains/admin/users.js";
