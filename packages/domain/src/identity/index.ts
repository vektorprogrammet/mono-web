export { Identity } from "./service.js";

export * from "./access.js";

export type { IdentityOperations, IdentitySessionFailure } from "./service.js";

export {
  IdentityEngineError,
  IdentityInvalidCredentials,
  IdentityOwnedSessionNotFound,
  IdentityRateLimited,
  IdentitySessionExpired,
  IdentitySessionNotFound,
} from "./errors.js";

export {
  decodeIdentityActor,
  decodeIdentitySession,
  IdentityActor,
  IdentityRequestContext,
  IdentitySecurityEvent,
  IdentitySecurityEventDetails,
  IdentitySecurityEventKind,
  IdentitySecurityOutcomeCode,
  IdentitySession,
  IdentitySessionId,
} from "./schema.js";

export type {
  IdentitySessionMutationSuccess,
  IdentitySignInInput,
  IdentitySignInSuccess,
  SessionToken,
} from "./schema.js";
