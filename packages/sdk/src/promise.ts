/**
 * Promise surface for the SDK.
 *
 * createClient returns an object with domain methods that return Promises.
 * Errors are mapped to SdkError subclasses — consumers use instanceof checks.
 *
 * This is the default export (".") of @vektorprogrammet/sdk.
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
import { createAdminMiscDomain } from "./domains/admin/misc.js"
import { createPublicDomain } from "./domains/public.js"

// Re-export public error types for consumers
export {
  SdkError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  ConflictError,
  NetworkError,
  RateLimitedError,
  type SdkErrorType,
} from "./errors.js"

export type { ClientContext } from "./context.js"

// Re-export domain types
export type { Receipt } from "./domains/receipts.js"
export type { AdminReceipt } from "./domains/admin/receipts.js"
export type { Application, AdminApplicationListData } from "./domains/admin/applications.js"
export type { Interview } from "./domains/admin/interviews.js"
export type { Assistant, School, Substitute } from "./domains/admin/scheduling.js"
export type { MailingListEntry, AdmissionStats, TeamInterest } from "./domains/admin/misc.js"
export type { Team, Sponsor, FieldOfStudy } from "./domains/public.js"
export type { UserProfile, DashboardData } from "./domains/me.js"

export type ClientOptions = {
  auth?: AuthOption
}

/**
 * Wraps an Effect method into a Promise that throws SdkError on failure.
 */
function promisify<Args extends unknown[], A>(
  fn: (...args: Args) => Effect.Effect<A, InternalSdkError>,
): (...args: Args) => Promise<A> {
  return (...args) =>
    Effect.runPromise(
      fn(...args).pipe(
        Effect.mapError(toSdkError),
      ),
    )
}

/**
 * Wraps an entire domain object — every method becomes Promise-returning.
 */
function promisifyDomain<T extends object>(
  domain: T,
): { [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, any> ? (...args: A) => Promise<R> : never } {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(domain as Record<string, unknown>)) {
    const fn = (domain as Record<string, unknown>)[key]
    if (typeof fn === "function") {
      result[key] = promisify(fn.bind(domain) as (...args: unknown[]) => Effect.Effect<unknown, InternalSdkError>)
    }
  }
  return result as { [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, any> ? (...args: A) => Promise<R> : never }
}

/**
 * Creates a new SDK client.
 *
 * @param baseUrl - Base URL for the API (e.g. "https://api.example.com")
 * @param options - Optional client configuration, including auth token
 */
export function createClient(baseUrl: string, options?: ClientOptions) {
  const transport = createTransport(baseUrl, options?.auth)
  const initialToken = typeof options?.auth === "string" ? options.auth : undefined
  const context = createContext(initialToken)

  const auth = createAuthDomain(transport)
  const me = createMeDomain(transport)
  const receipts = createReceiptsDomain(transport)
  const adminReceipts = createAdminReceiptsDomain(transport)
  const adminApplications = createAdminApplicationsDomain(transport)
  const adminInterviews = createAdminInterviewsDomain(transport)
  const adminUsers = createAdminUsersDomain(transport)
  const adminScheduling = createAdminSchedulingDomain(transport)
  const adminMisc = createAdminMiscDomain(transport)
  const publicDomain = createPublicDomain(transport)

  return {
    auth: promisifyDomain(auth),
    me: promisifyDomain(me),
    receipts: promisifyDomain(receipts),
    admin: {
      receipts: promisifyDomain(adminReceipts),
      applications: promisifyDomain(adminApplications),
      interviews: promisifyDomain(adminInterviews),
      users: promisifyDomain(adminUsers),
      scheduling: promisifyDomain(adminScheduling),
      mailingLists: promisify(adminMisc.mailingLists.bind(adminMisc)),
      admissionStats: promisify(adminMisc.admissionStats.bind(adminMisc)),
      teamInterest: promisify(adminMisc.teamInterest.bind(adminMisc)),
    },
    public: promisifyDomain(publicDomain),
    context,
  }
}

export type ApiClient = ReturnType<typeof createClient>
