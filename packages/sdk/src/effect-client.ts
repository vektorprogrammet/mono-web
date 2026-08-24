/**
 * Effect-native entrypoint for the SDK.
 * Consumers who use Effect directly import from "@vektorprogrammet/sdk/effect".
 *
 * Methods return Effect<A, InternalSdkError> directly — no Promise wrapping.
 */

import { apiUrl } from "./config.js";
import { createAuthDomain } from "./domains/auth.js";
import { createMeDomain } from "./domains/me.js";
import { createReceiptsDomain } from "./domains/receipts.js";
import { createAdminReceiptsDomain } from "./domains/admin/receipts.js";
import { createAdminApplicationsDomain } from "./domains/admin/applications.js";
import { createAdminInterviewsDomain } from "./domains/admin/interviews.js";
import { createAdminRecruitmentDomain } from "./domains/admin/recruitment.js";
import { createAdminSchedulingDomain } from "./domains/admin/scheduling.js";
import { createRecruitmentInvitationResponsesDomain } from "./domains/recruitment-invitation-responses.js";
import { createAdminOrganizationDomain } from "./domains/admin/organization.js";
import { createAdminTeamsDomain } from "./domains/admin/teams.js";
import { createAdminMiscDomain } from "./domains/admin/misc.js";
import { createPublicMiscDomain } from "./domains/public/misc.js";
import { createPublicOrganizationDomain } from "./domains/public/organization.js";
import { createPublicContactMessageDomain } from "./domains/public/contact-message.js";
import { createAdminUsersDomain } from "./domains/admin/users.js";
import { createAdmissionApplicationsDomain } from "./domains/admission-applications.js";
import { createAdmissionPeriodsDomain } from "./domains/admission-period.js";
import { createTransport, type CookieOption } from "./transport.js";

// --- Public re-exports ---
export type {
  InternalSdkError,
  ReceiptFailure,
  AdmissionPeriodFailure,
  AdmissionPeriodSdkError,
  PublicApplicationFailure,
  PublicApplicationSdkError,
  RecruitmentFailure,
  RecruitmentSdkError,
  OrganizationFailure,
  OrganizationSdkError,
  ReceiptRejectionTag,
  AdmissionPeriodRejectionTag,
  PublicApplicationRejectionTag,
  RecruitmentRejectionTag,
  OrganizationRejectionTag,
} from "./errors.js";
export { apiUrl, isFixtureMode } from "./config.js";

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
export type { Receipt, AdminReceipt, ReceiptInput } from "./schemas/receipt.js";
export type { Application, ApplicationDetail } from "./schemas/application.js";
export {
  AdminInterviewList,
  Interview,
  InterviewId,
  InterviewScheduleInput,
  InterviewSchedulingStatus,
} from "./schemas/interview.js";
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
  RecruitmentAssignmentBoardQuery,
  RecruitmentAssignmentBoard,
  RecruitmentAssignmentCandidate,
  RecruitmentAssignmentCommand,
  RecruitmentAssignmentObservation,
  RecruitmentAssignmentResult,
  RecruitmentInterview,
  RecruitmentInterviewerOption,
  RecruitmentInterviewSchemaOption,
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
} from "./schemas/recruitment.js";

// --- Client options ---

export type ClientOptions = {
  cookie?: CookieOption;
};

// --- Effect client factory ---

export function createEffectClient(baseUrl: string | undefined, options?: ClientOptions) {
  const transport = createTransport(baseUrl, options?.cookie);

  const adminMisc = createAdminMiscDomain(transport);
  const publicMisc = createPublicMiscDomain(transport);
  const publicContactMessages = createPublicContactMessageDomain(transport);

  return {
    auth: createAuthDomain(transport),
    me: createMeDomain(transport),
    receipts: createReceiptsDomain(transport),
    admissionPeriods: createAdmissionPeriodsDomain(transport),
    applications: createAdmissionApplicationsDomain(transport),
    admin: {
      receipts: createAdminReceiptsDomain(transport),
      applications: createAdminApplicationsDomain(transport),
      interviews: createAdminInterviewsDomain(transport),
      recruitment: createAdminRecruitmentDomain(transport),
      users: createAdminUsersDomain(transport),
      scheduling: createAdminSchedulingDomain(transport),
      organization: createAdminOrganizationDomain(transport),
      teams: createAdminTeamsDomain(transport),
      mailingLists: adminMisc.mailingLists.bind(adminMisc),
      admissionStats: adminMisc.admissionStats.bind(adminMisc),
    },
    recruitmentInvitationResponses:
      createRecruitmentInvitationResponsesDomain(transport),
    public: {
      organization: createPublicOrganizationDomain(transport),
      sponsors: publicMisc.sponsors.bind(publicMisc),
      contactMessages: publicContactMessages,
    },
  };
}
/**
 * Creates an Effect SDK client from SDK-owned runtime configuration.
 *
 * A cookie option carries the exact server-side Cookie header; actor and grant
 * authority remain server-owned.
 */
export function createConfiguredEffectClient(options?: ClientOptions) {
  return createEffectClient(apiUrl, options);
}

export type EffectSdk = ReturnType<typeof createEffectClient>;
