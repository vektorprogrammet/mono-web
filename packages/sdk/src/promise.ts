/**
 * Promise-based public surface for the SDK.
 * Re-exports everything consumers need without requiring an Effect dependency.
 *
 * This is the default entrypoint (`"."`).
 */

import { Effect } from "effect"
import { createTransport, type AuthOption } from "./transport.js"
import { toSdkError, type InternalSdkError } from "./errors.js"
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

export type { ClientContext } from "./context.js"
export { apiUrl, isFixtureMode } from "./config.js"
export {
  SdkError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  ConflictError,
  NetworkError,
  RateLimitedError,
} from "./errors.js"

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

// --- Promisify helpers ---

/**
 * Wraps a single Effect-returning function into a Promise-returning function.
 * Maps InternalSdkError to public SdkError subclasses at the boundary.
 */
function promisify<Args extends unknown[], A>(
  fn: (...args: Args) => Effect.Effect<A, InternalSdkError>,
): (...args: Args) => Promise<A> {
  return (...args) =>
    Effect.runPromise(
      fn(...args).pipe(Effect.mapError(toSdkError)),
    )
}

/**
 * Wraps an entire domain object — every method becomes Promise-returning.
 */
function promisifyDomain<T extends object>(
  domain: T,
): { [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, any> ? (...args: A) => Promise<R> : never } {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(domain)) {
    result[key] = promisify((domain as any)[key] as any)
  }
  return result as any
}

// --- Client factory ---

export function createClient(baseUrl: string, options?: ClientOptions) {
  const transport = createTransport(baseUrl, options?.auth)
  const initialToken = typeof options?.auth === "string" ? options.auth : undefined
  const context = createContext(initialToken)

  const adminMisc = createAdminMiscDomain(transport)
  const publicMisc = createPublicMiscDomain(transport)
  const publicTeams = createPublicTeamsDomain(transport)

  return {
    auth: promisifyDomain(createAuthDomain(transport)),
    me: promisifyDomain(createMeDomain(transport)),
    receipts: promisifyDomain(createReceiptsDomain(transport)),
    admin: {
      receipts: promisifyDomain(createAdminReceiptsDomain(transport)),
      applications: promisifyDomain(createAdminApplicationsDomain(transport)),
      interviews: promisifyDomain(createAdminInterviewsDomain(transport)),
      users: promisifyDomain(createAdminUsersDomain(transport)),
      scheduling: promisifyDomain(createAdminSchedulingDomain(transport)),
      teams: promisifyDomain(createAdminTeamsDomain(transport)),
      mailingLists: promisify(adminMisc.mailingLists.bind(adminMisc)),
      admissionStats: promisify(adminMisc.admissionStats.bind(adminMisc)),
    },
    public: {
      departments: promisify(publicMisc.departments.bind(publicMisc)),
      fieldOfStudies: promisify(publicMisc.fieldOfStudies.bind(publicMisc)),
      sponsors: promisify(publicMisc.sponsors.bind(publicMisc)),
      teams: promisify(publicTeams.list.bind(publicTeams)),
    },
    context,
  }
}

export type Sdk = ReturnType<typeof createClient>
