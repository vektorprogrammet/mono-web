export { Auth } from "./service.js"
export type { AuthShape } from "./service.js"
export {
  AuthInvalidCredentials,
  AuthSessionNotFound,
  AuthSessionExpired,
  AuthRateLimited,
  AuthEngineError,
} from "./errors.js"
export { AuthenticatedActor, decodeAuthenticatedActor } from "./schema.js"
