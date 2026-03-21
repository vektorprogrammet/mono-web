/**
 * Effect-native entrypoint for the SDK.
 * Consumers who use Effect directly import from "@vektorprogrammet/sdk/effect".
 *
 * Methods return Effect<A, InternalSdkError> directly — no Promise wrapping.
 */

import { createTransport, type AuthOption } from "./transport.js"
import { createContext } from "./context.js"
import { createAuthDomain } from "./domains/auth.js"
import { createMeDomain } from "./domains/me.js"
import { createReceiptsDomain } from "./domains/receipts.js"
import { createAdminReceiptsDomain } from "./domains/admin/receipts.js"
import { createAdminApplicationsDomain } from "./domains/admin/applications.js"
import { createAdminInterviewsDomain } from "./domains/admin/interviews.js"
import { createAdminUsersDomain } from "./domains/admin/users.js"
import { createAdminSchedulingDomain } from "./domains/admin/scheduling.js"
import { createAdminTeamsDomain } from "./domains/admin/teams.js"
import { createAdminMiscDomain } from "./domains/admin/misc.js"
import { createPublicMiscDomain } from "./domains/public/misc.js"
import { createPublicTeamsDomain } from "./domains/public/teams.js"

// --- Public re-exports ---

export type { InternalSdkError } from "./errors.js"
export type { ClientContext } from "./context.js"
export { apiUrl, isFixtureMode } from "./config.js"

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

// --- Client options ---

export type ClientOptions = {
  auth?: AuthOption
}

// --- Effect client factory ---

export function createEffectClient(baseUrl: string, options?: ClientOptions) {
  const transport = createTransport(baseUrl, options?.auth)
  const initialToken = typeof options?.auth === "string" ? options.auth : undefined
  const context = createContext(initialToken)

  const adminMisc = createAdminMiscDomain(transport)
  const publicMisc = createPublicMiscDomain(transport)
  const publicTeams = createPublicTeamsDomain(transport)

  return {
    auth: createAuthDomain(transport),
    me: createMeDomain(transport),
    receipts: createReceiptsDomain(transport),
    admin: {
      receipts: createAdminReceiptsDomain(transport),
      applications: createAdminApplicationsDomain(transport),
      interviews: createAdminInterviewsDomain(transport),
      users: createAdminUsersDomain(transport),
      scheduling: createAdminSchedulingDomain(transport),
      teams: createAdminTeamsDomain(transport),
      mailingLists: adminMisc.mailingLists.bind(adminMisc),
      admissionStats: adminMisc.admissionStats.bind(adminMisc),
    },
    public: {
      departments: publicMisc.departments.bind(publicMisc),
      fieldOfStudies: publicMisc.fieldOfStudies.bind(publicMisc),
      sponsors: publicMisc.sponsors.bind(publicMisc),
      teams: publicTeams.list.bind(publicTeams),
    },
    context,
  }
}

export type EffectSdk = ReturnType<typeof createEffectClient>
