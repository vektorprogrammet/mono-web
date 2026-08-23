import { Schema } from "effect";
import { PublicApplicationIdSchema } from "./schema.js";

export class PublicApplicationDecodeError extends Schema.TaggedError<PublicApplicationDecodeError>()(
  "PublicApplicationDecodeError",
  { message: Schema.String },
) {}

export class NoEligibleAdmissionPeriod extends Schema.TaggedError<NoEligibleAdmissionPeriod>()(
  "NoEligibleAdmissionPeriod",
  { departmentId: PublicApplicationIdSchema },
) {}

/** `_tag` remains DepartmentNotFound for the public error contract. */
export class PublicApplicationDepartmentNotFound extends Schema.TaggedError<PublicApplicationDepartmentNotFound>()(
  "DepartmentNotFound",
  { departmentId: PublicApplicationIdSchema },
) {}

export class FieldOfStudyNotFound extends Schema.TaggedError<FieldOfStudyNotFound>()(
  "FieldOfStudyNotFound",
  { fieldOfStudyId: PublicApplicationIdSchema },
) {}

export class FieldOfStudyInactive extends Schema.TaggedError<FieldOfStudyInactive>()(
  "FieldOfStudyInactive",
  { fieldOfStudyId: PublicApplicationIdSchema },
) {}

export class FieldOfStudyDepartmentMismatch extends Schema.TaggedError<FieldOfStudyDepartmentMismatch>()(
  "FieldOfStudyDepartmentMismatch",
  { fieldOfStudyId: PublicApplicationIdSchema, departmentId: PublicApplicationIdSchema },
) {}

export class DuplicatePublicApplication extends Schema.TaggedError<DuplicatePublicApplication>()(
  "DuplicatePublicApplication",
  {},
) {}

export class DuplicatePublicApplicationCommandConflict extends Schema.TaggedError<DuplicatePublicApplicationCommandConflict>()(
  "DuplicatePublicApplicationCommandConflict",
  { commandId: PublicApplicationIdSchema },
) {}

export class PublicApplicationNotFound extends Schema.TaggedError<PublicApplicationNotFound>()(
  "PublicApplicationNotFound",
  { applicationId: PublicApplicationIdSchema },
) {}

export class PublicApplicationPersistenceError extends Schema.TaggedError<PublicApplicationPersistenceError>()(
  "PublicApplicationPersistenceError",
  { operation: Schema.String, message: Schema.String },
) {}

/** Transport adapters may use these typed failures before entering the transaction. */
export class RequestBodyTooLarge extends Schema.TaggedError<RequestBodyTooLarge>()(
  "RequestBodyTooLarge",
  {},
) {}

export class PublicApplicationRateLimitExceeded extends Schema.TaggedError<PublicApplicationRateLimitExceeded>()(
  "PublicApplicationRateLimitExceeded",
  {},
) {}

export type PublicApplicationError =
  | PublicApplicationDecodeError
  | NoEligibleAdmissionPeriod
  | PublicApplicationDepartmentNotFound
  | FieldOfStudyNotFound
  | FieldOfStudyInactive
  | FieldOfStudyDepartmentMismatch
  | DuplicatePublicApplication
  | DuplicatePublicApplicationCommandConflict
  | PublicApplicationNotFound
  | PublicApplicationPersistenceError
  | RequestBodyTooLarge
  | PublicApplicationRateLimitExceeded;
