import { Context } from "effect";
import type { IdentityFailure } from "./errors.js";
import type { IdentityActor, IdentitySignInInput, IdentitySignInSuccess } from "./schema.js";

/**
 * Identity and session authority. Owns credentials and session lifecycle;
 * never owns roles, permissions, or access policy (Organization does).
 * Implementations must resolve every session to the canonical PersonId that
 * exists in person_profiles - the auth schema holds no separate identity space.
 */
export interface IdentityShape {
  /** Verifies credentials, issues a session, returns its Set-Cookie value. */
  readonly signIn: (input: IdentitySignInInput) => Promise<IdentitySignInSuccess>;
  /**
   * Resolves a session cookie token to the authenticated person.
   * Fails closed: unknown, expired, or revoked tokens are rejections.
   */
  readonly resolveSession: (cookieHeader: string | undefined) => Promise<IdentityActor>;
  /** Revokes the session identified by the request's cookie; idempotent. */
  readonly signOut: (cookieHeader: string | undefined) => Promise<void>;
}

export class Identity extends Context.Service<Identity, IdentityShape>()(
  "@vektorprogrammet/domain/Identity",
) {}

export type { IdentityFailure };
