/**
 * Credential middlewares of the native RPC contract.
 *
 * Each middleware authenticates the credential that its RPCs accept, before the handler runs, and
 * answers a rejected credential with a declared problem. It grants no authority: a handler still
 * resolves the credential and the authority inside the transaction that commits its command, and
 * evaluates the RPC's AccessSpec there. The backend implements each middleware from the request
 * headers that RPC over HTTP carries.
 *
 * @since 0.3.0
 */
import { RpcMiddleware } from "effect/unstable/rpc";
import { problemUnion, rpcProblems } from "./problem.js";

const CredentialProblem = rpcProblems(
  problemUnion("CredentialProblem", ["credential.missing", "credential.invalid"]),
);

/** A Better Auth session cookie, and nothing else: session management. */
export class SessionCredential extends RpcMiddleware.Service<SessionCredential>()(
  "@vektorprogrammet/rpc/SessionCredential",
  { error: CredentialProblem },
) {}

/** A Better Auth session cookie or an OAuth user bearer that names one Person. */
export class PersonCredential extends RpcMiddleware.Service<PersonCredential>()(
  "@vektorprogrammet/rpc/PersonCredential",
  { error: CredentialProblem },
) {}

/** A Person credential, or an OAuth service bearer that names one service principal. */
export class PersonOrServiceCredential extends RpcMiddleware.Service<PersonOrServiceCredential>()(
  "@vektorprogrammet/rpc/PersonOrServiceCredential",
  { error: CredentialProblem },
) {}

/**
 * A recruitment invitation capability in the payload, with no cookie or bearer beside it. A missing
 * capability answers resource.not-found, so the RPC conceals whether the invitation exists.
 */
export class InvitationCapabilityCredential extends RpcMiddleware.Service<InvitationCapabilityCredential>()(
  "@vektorprogrammet/rpc/InvitationCapabilityCredential",
  {
    error: rpcProblems(
      problemUnion("InvitationCapabilityProblem", ["resource.not-found", "credential.invalid"]),
    ),
  },
) {}

/** The homepage server's deployment secret. It names no principal. */
export class ContactBackendCredential extends RpcMiddleware.Service<ContactBackendCredential>()(
  "@vektorprogrammet/rpc/ContactBackendCredential",
  { error: CredentialProblem },
) {}
