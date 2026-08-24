import { Schema } from "effect"

export class AuthInvalidCredentials extends Schema.TaggedError<AuthInvalidCredentials>()(
  "AuthInvalidCredentials",
  {},
) {}

export class AuthSessionNotFound extends Schema.TaggedError<AuthSessionNotFound>()(
  "AuthSessionNotFound",
  { sessionToken: Schema.String },
) {}

export class AuthSessionExpired extends Schema.TaggedError<AuthSessionExpired>()(
  "AuthSessionExpired",
  { sessionToken: Schema.String },
) {}

export class AuthRateLimited extends Schema.TaggedError<AuthRateLimited>()(
  "AuthRateLimited",
  {},
) {}

export class AuthEngineError extends Schema.TaggedError<AuthEngineError>()("AuthEngineError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type AuthFailure =
  | AuthInvalidCredentials
  | AuthSessionNotFound
  | AuthSessionExpired
  | AuthRateLimited
  | AuthEngineError
