import { Schema } from "effect";

export class IdentityInvalidCredentials extends Schema.TaggedError<IdentityInvalidCredentials>()(
  "IdentityInvalidCredentials",
  {},
) {}

export class IdentitySessionNotFound extends Schema.TaggedError<IdentitySessionNotFound>()(
  "IdentitySessionNotFound",
  { sessionToken: Schema.String },
) {}

export class IdentitySessionExpired extends Schema.TaggedError<IdentitySessionExpired>()(
  "IdentitySessionExpired",
  { sessionToken: Schema.String },
) {}

export class IdentityRateLimited extends Schema.TaggedError<IdentityRateLimited>()(
  "IdentityRateLimited",
  {},
) {}

export class IdentityEngineError extends Schema.TaggedError<IdentityEngineError>()(
  "IdentityEngineError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export type IdentityFailure =
  | IdentityInvalidCredentials
  | IdentitySessionNotFound
  | IdentitySessionExpired
  | IdentityRateLimited
  | IdentityEngineError;
