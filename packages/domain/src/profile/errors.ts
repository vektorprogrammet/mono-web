import { Schema } from "effect";
import { PersonId } from "../organization/schema.js";

export class ProfileDecodeError extends Schema.TaggedError<ProfileDecodeError>()(
  "ProfileDecodeError",
  { message: Schema.String },
) {}

export class ProfileQueryLimitExceeded extends Schema.TaggedError<ProfileQueryLimitExceeded>()(
  "ProfileQueryLimitExceeded",
  { limit: Schema.Int },
) {}

export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound>()("ProfileNotFound", {
  personId: PersonId,
}) {}

export class ProfilePersistenceError extends Schema.TaggedError<ProfilePersistenceError>()(
  "ProfilePersistenceError",
  { operation: Schema.String, message: Schema.String },
) {}

export type ProfileFailure =
  | ProfileDecodeError
  | ProfileQueryLimitExceeded
  | ProfileNotFound
  | ProfilePersistenceError;
