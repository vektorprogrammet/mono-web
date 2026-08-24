import { Context } from "effect"
import type { AuthFailure } from "./errors.js"
import type { AuthenticatedActor, SignInInput, SignInSuccess } from "./schema.js"

/**
 * Identity and session authority. Owns credentials and session lifecycle;
 * never owns roles, permissions, or access policy (Organization does).
 * Implementations must resolve every session to a PersonId that exists in
 * person_profiles - the auth schema holds no separate identity space.
 */
export interface AuthShape {
  /** Verifies credentials, issues a session, returns its Set-Cookie value. */
  readonly signIn: (input: SignInInput) => Promise<SignInSuccess>
  /**
   * Resolves a session cookie token to the authenticated person.
   * Fails closed: unknown, expired, or revoked tokens are rejections.
   */
  readonly resolveSession: (
    cookieHeader: string | undefined,
  ) => Promise<AuthenticatedActor>
  /** Revokes the session identified by the request's cookie; idempotent. */
  readonly signOut: (cookieHeader: string | undefined) => Promise<void>
}

export class Auth extends Context.Service<Auth, AuthShape>()(
  "@vektorprogrammet/domain/Auth",
) {}

/** Convenience alias matching Profile/Organization call sites. */
export type AuthShapeType = AuthShape
export type { AuthFailure }
