import { Context, type Effect } from "effect";
import type {
  IdentityEngineError,
  IdentityFailure,
  IdentityInvalidCredentials,
  IdentityOwnedSessionNotFound,
  IdentityRateLimited,
  IdentitySessionExpired,
  IdentitySessionNotFound,
} from "./errors.js";
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

/** A cookie that names no usable session, or an engine that cannot tell. */
export type IdentitySessionFailure =
  | IdentitySessionNotFound
  | IdentitySessionExpired
  | IdentityEngineError;

/**
 * Identity and session authority. Owns credentials and session lifecycle;
 * never owns roles, permissions, or access policy (Organization does).
 * Implementations must resolve every session to the canonical PersonId that
 * exists in person_profiles - the auth schema holds no separate identity space.
 */
export interface IdentityOperations {
  /** Verifies credentials and issues a Better Auth session. */
  readonly signIn: (
    input: IdentitySignInInput,
  ) => Effect.Effect<
    IdentitySignInSuccess,
    IdentityInvalidCredentials | IdentityRateLimited | IdentitySessionFailure
  >;
  /**
   * Resolves a session cookie to the canonical person from persisted state.
   * Unknown, expired, and revoked cookies fail closed.
   */
  readonly resolveSession: (
    cookieHeader: string | undefined,
  ) => Effect.Effect<IdentityActor, IdentitySessionFailure>;
  /** Reads only safe metadata for the authoritative current session. */
  readonly readCurrentSession: (
    cookieHeader: string | undefined,
  ) => Effect.Effect<IdentitySession, IdentitySessionFailure>;
  /** Lists only safe metadata for sessions owned by the current person. */
  readonly listSessions: (
    cookieHeader: string | undefined,
  ) => Effect.Effect<ReadonlyArray<IdentitySession>, IdentitySessionFailure>;
  /** Revokes the current session and emits one transactional audit transition. */
  readonly revokeCurrentSession: (
    cookieHeader: string | undefined,
    request: IdentityRequestContext,
  ) => Effect.Effect<IdentitySessionMutationSuccess, IdentitySessionFailure>;
  /** Revokes one owned session or returns the concealed owned-session miss. */
  readonly revokeSession: (
    cookieHeader: string | undefined,
    sessionId: IdentitySessionId,
    request: IdentityRequestContext,
  ) => Effect.Effect<
    IdentitySessionMutationSuccess,
    IdentityOwnedSessionNotFound | IdentitySessionFailure
  >;
  /** Revokes all other owned sessions while keeping the current session active. */
  readonly revokeOtherSessions: (
    cookieHeader: string | undefined,
    request: IdentityRequestContext,
  ) => Effect.Effect<IdentitySessionMutationSuccess, IdentitySessionFailure>;
  /** Revokes every owned session, including the current session. */
  readonly revokeAllSessions: (
    cookieHeader: string | undefined,
    request: IdentityRequestContext,
  ) => Effect.Effect<IdentitySessionMutationSuccess, IdentitySessionFailure>;
  /** Appends one closed, bounded identity security event. */
  readonly recordSecurityEvent: (
    event: IdentitySecurityEvent,
  ) => Effect.Effect<void, IdentityEngineError>;
  /** Better Auth credential-engine sign-out used only below the native resource seam. */
  readonly signOut: (
    cookieHeader: string | undefined,
  ) => Effect.Effect<IdentitySessionMutationSuccess, IdentityEngineError>;
}

export class Identity extends Context.Service<Identity, IdentityOperations>()(
  "@vektorprogrammet/domain/Identity",
) {}

export type { IdentityFailure };
