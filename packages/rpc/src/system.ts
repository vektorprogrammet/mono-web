/**
 * System: the caller's first-party session and session management.
 *
 * Every RPC here takes the Better Auth session cookie alone (`SessionCredential`). The health
 * probe stays plain HTTP at `GET /health`, outside this group.
 *
 * @since 0.3.0
 */
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { browserSessionNativeAccess, withAccessSpec } from "./access.js";
import { SessionCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems } from "./problem.js";

/** A bounded opaque session identifier. */
export const SessionId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value.length <= 128, {
      message: "a bounded opaque session identifier",
    }),
  ),
);

/** Credential-free owner-only session metadata. */
export const SessionResponse = Schema.Struct({
  sessionId: SessionId,
  personId: PersonId,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  current: Schema.Boolean,
}).annotate({
  identifier: "SessionResponse",
  description: "Safe first-party session metadata without credential material.",
});

export type SessionResponse = typeof SessionResponse.Type;

export const SessionListResponse = Schema.Array(SessionResponse).annotate({
  identifier: "SessionListResponse",
  description: "Sessions owned by the authenticated person.",
});

export const SessionReadProblem = problemUnion("SessionReadProblem", [
  "credential.missing",
  "credential.invalid",
  "internal.error",
  "identity.unavailable",
]);

export const SessionListProblem = problemUnion("SessionListProblem", [
  "credential.missing",
  "credential.invalid",
  "internal.error",
  "identity.unavailable",
]);

/** Every session command but the owned-session delete names only the caller's own session. */
export const SessionCommandProblem = problemUnion("SessionCommandProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "dependency.unavailable",
  "idempotency.unavailable",
]);

export const OwnedSessionDeleteProblem = problemUnion("OwnedSessionDeleteProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "dependency.unavailable",
  "idempotency.unavailable",
]);

/** A replayable session command: its idempotency key, and nothing else. */
const SessionCommand = Schema.Struct({ idempotencyKey: IdempotencyKey });

/** Reads safe metadata for the authoritative current Better Auth session. */
export const ReadSession = Rpc.make("system.readSession", {
  success: SessionResponse,
  error: rpcProblems(SessionReadProblem),
})
  .middleware(SessionCredential)
  .pipe(
    withAccessSpec(
      browserSessionNativeAccess({
        canonicalScopeResolver: "identity.current-session",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Revokes the authoritative current session. */
export const DeleteSession = Rpc.make("system.deleteSession", {
  payload: SessionCommand,
  success: Schema.Void,
  error: rpcProblems(SessionCommandProblem),
})
  .middleware(SessionCredential)
  .pipe(
    withAccessSpec(
      browserSessionNativeAccess({
        canonicalScopeResolver: "identity.current-session",
        decisionTime: "Transaction",
      }),
    ),
  );

/** Lists only safe metadata for sessions owned by the authenticated person. */
export const ListSessions = Rpc.make("system.listSessions", {
  success: SessionListResponse,
  error: rpcProblems(SessionListProblem),
})
  .middleware(SessionCredential)
  .pipe(
    withAccessSpec(
      browserSessionNativeAccess({
        canonicalScopeResolver: "identity.owned-sessions",
        requirements: ["sessions.owner"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Revokes one owned session; missing and non-owned identifiers are concealed. */
export const DeleteOwnedSession = Rpc.make("system.deleteOwnedSession", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, sessionId: SessionId }),
  success: Schema.Void,
  error: rpcProblems(OwnedSessionDeleteProblem),
})
  .middleware(SessionCredential)
  .pipe(
    withAccessSpec(
      browserSessionNativeAccess({
        canonicalScopeResolver: "identity.session-by-id",
        requirements: ["sessions.owner"],
        concealRequirement: true,
        decisionTime: "Transaction",
      }),
    ),
  );

/** Revokes every owned session except the authoritative current session. */
export const RevokeOtherSessions = Rpc.make("system.revokeOtherSessions", {
  payload: SessionCommand,
  success: Schema.Void,
  error: rpcProblems(SessionCommandProblem),
})
  .middleware(SessionCredential)
  .pipe(
    withAccessSpec(
      browserSessionNativeAccess({
        canonicalScopeResolver: "identity.current-session",
        decisionTime: "Transaction",
      }),
    ),
  );

/** Revokes every owned session, including the authoritative current session. */
export const RevokeAllSessions = Rpc.make("system.revokeAllSessions", {
  payload: SessionCommand,
  success: Schema.Void,
  error: rpcProblems(SessionCommandProblem),
})
  .middleware(SessionCredential)
  .pipe(
    withAccessSpec(
      browserSessionNativeAccess({
        canonicalScopeResolver: "identity.current-session",
        decisionTime: "Transaction",
      }),
    ),
  );

export class SystemRpcs extends RpcGroup.make(
  ReadSession,
  DeleteSession,
  ListSessions,
  DeleteOwnedSession,
  RevokeOtherSessions,
  RevokeAllSessions,
) {}
