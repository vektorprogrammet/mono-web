import { Context } from "effect";
import type { IdentityFailure } from "./errors.js";
import type {
  IdentityActor,
  IdentityRequestContext,
  IdentitySecurityEvent,
  IdentitySession,
  IdentitySessionId,
  IdentitySessionMutationSuccess,
  IdentitySignInInput,
  IdentitySignInSuccess,
} from "./schema.js";

/**
 * Identity and session authority. Owns credentials and session lifecycle;
 * never owns roles, permissions, or access policy (Organization does).
 * Implementations must resolve every session to the canonical PersonId that
 * exists in person_profiles - the auth schema holds no separate identity space.
 */
export interface IdentityShape {
  /** Verifies credentials and issues a Better Auth session. */
  readonly signIn: (input: IdentitySignInInput) => Promise<IdentitySignInSuccess>;
  /**
   * Resolves a session cookie to the canonical person from persisted state.
   * Unknown, expired, and revoked cookies fail closed.
   */
  readonly resolveSession: (cookieHeader: string | undefined) => Promise<IdentityActor>;
  /** Reads only safe metadata for the authoritative current session. */
  readonly readCurrentSession: (cookieHeader: string | undefined) => Promise<IdentitySession>;
  /** Lists only safe metadata for sessions owned by the current person. */
  readonly listSessions: (
    cookieHeader: string | undefined,
  ) => Promise<ReadonlyArray<IdentitySession>>;
  /** Revokes the current session and emits one transactional audit transition. */
  readonly revokeCurrentSession: (
    cookieHeader: string | undefined,
    request: IdentityRequestContext,
  ) => Promise<IdentitySessionMutationSuccess>;
  /** Revokes one owned session or returns the concealed owned-session miss. */
  readonly revokeSession: (
    cookieHeader: string | undefined,
    sessionId: IdentitySessionId,
    request: IdentityRequestContext,
  ) => Promise<IdentitySessionMutationSuccess>;
  /** Revokes all other owned sessions while keeping the current session active. */
  readonly revokeOtherSessions: (
    cookieHeader: string | undefined,
    request: IdentityRequestContext,
  ) => Promise<IdentitySessionMutationSuccess>;
  /** Revokes every owned session, including the current session. */
  readonly revokeAllSessions: (
    cookieHeader: string | undefined,
    request: IdentityRequestContext,
  ) => Promise<IdentitySessionMutationSuccess>;
  /** Appends one closed, bounded identity security event. */
  readonly recordSecurityEvent: (event: IdentitySecurityEvent) => Promise<void>;
  /** Better Auth credential-engine sign-out used only below the native resource seam. */
  readonly signOut: (cookieHeader: string | undefined) => Promise<IdentitySessionMutationSuccess>;
}

export class Identity extends Context.Service<Identity, IdentityShape>()(
  "@vektorprogrammet/domain/Identity",
) {}

export type { IdentityFailure };
