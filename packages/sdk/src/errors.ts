/**
 * Public error hierarchy for the SDK.
 * Consumers use instanceof checks and the .type discriminant.
 *
 * Internally, Effect TaggedErrors are mapped to these at the runPromise boundary.
 */

import { Schema } from "effect";

// --- Public error classes (exported to consumers) ---

export type SdkErrorType =
  | "unauthorized"
  | "not_found"
  | "validation"
  | "conflict"
  | "network"
  | "rate_limited"
  | "configuration"
  | "receipt_rejection"
  | "admission_period_rejection"
  | "admission_application_rejection";

export type AdmissionPeriodRejectionTag =
  | "UnauthenticatedActor"
  | "InactiveActor"
  | "AdmissionRoleDenied"
  | "AdmissionScopeDenied"
  | "DepartmentRequired"
  | "DepartmentNotFound"
  | "SemesterNotFound"
  | "AdmissionPeriodNotFound"
  | "AdmissionPeriodDecodeError"
  | "InvalidAdmissionPeriodWindow"
  | "AdmissionWindowOutsideSemester"
  | "AdmissionPeriodAlreadyExists"
  | "StaleAdmissionPeriodRevision"
  | "DuplicateAdmissionPeriodCommandConflict"
  | "AdmissionPeriodPersistenceError";

export type AdmissionApplicationRejectionTag =
  | "AdmissionApplicationDecodeError"
  | "NoOpenAdmissionPeriod"
  | "AdmissionApplicationAlreadyExists"
  | "DuplicateAdmissionApplicationCommandConflict"
  | "AdmissionApplicationPersistenceError";

export type ReceiptRejectionTag =
  | "UnauthenticatedActor"
  | "InactiveActor"
  | "ReceiptOwnerDenied"
  | "ReceiptScopeDenied"
  | "ReceiptDecodeError"
  | "ReceiptAlreadyExists"
  | "DuplicateReceiptCommandConflict"
  | "ReceiptNotFound"
  | "StaleReceiptRevision"
  | "InvalidReceiptTransition"
  | "ReceiptFileNotStaged"
  | "ReceiptPersistenceError";

export class SdkError extends Error {
  readonly type: SdkErrorType;

  constructor(type: SdkErrorType, message: string, options?: ErrorOptions) {
    super(message, options);
    this.type = type;
    this.name = "SdkError";
  }
}

export class UnauthorizedError extends SdkError {
  constructor(message = "Unauthorized") {
    super("unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends SdkError {
  constructor(message = "Not found") {
    super("not_found", message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends SdkError {
  readonly fields: Record<string, string>;

  constructor(message = "Validation failed", fields: Record<string, string> = {}) {
    super("validation", message);
    this.name = "ValidationError";
    this.fields = fields;
  }
}

export class ConflictError extends SdkError {
  constructor(message = "Conflict") {
    super("conflict", message);
    this.name = "ConflictError";
  }
}

export class NetworkError extends SdkError {
  override readonly cause: unknown;

  constructor(message = "Network error", cause?: unknown) {
    super("network", message, { cause });
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export class RateLimitedError extends SdkError {
  constructor(message = "Rate limited") {
    super("rate_limited", message);
    this.name = "RateLimitedError";
  }
}

export class ConfigurationError extends SdkError {
  constructor(message = "Invalid API URL") {
    super("configuration", message);
    this.name = "ConfigurationError";
  }
}

export class ReceiptRejectionError extends SdkError {
  readonly _tag: ReceiptRejectionTag;
  readonly receiptTag: ReceiptRejectionTag;

  constructor(tag: ReceiptRejectionTag) {
    super("receipt_rejection", tag);
    this.name = "ReceiptRejectionError";
    this._tag = tag;
    this.receiptTag = tag;
  }
}

export class UnauthenticatedActorError extends ReceiptRejectionError {
  constructor() {
    super("UnauthenticatedActor");
    this.name = "UnauthenticatedActorError";
  }
}

export class InactiveActorError extends ReceiptRejectionError {
  constructor() {
    super("InactiveActor");
    this.name = "InactiveActorError";
  }
}

export class ReceiptOwnerDeniedError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptOwnerDenied");
    this.name = "ReceiptOwnerDeniedError";
  }
}

export class ReceiptScopeDeniedError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptScopeDenied");
    this.name = "ReceiptScopeDeniedError";
  }
}

export class ReceiptDecodeSdkError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptDecodeError");
    this.name = "ReceiptDecodeSdkError";
  }
}

export class ReceiptAlreadyExistsError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptAlreadyExists");
    this.name = "ReceiptAlreadyExistsError";
  }
}

export class DuplicateReceiptCommandConflictError extends ReceiptRejectionError {
  constructor() {
    super("DuplicateReceiptCommandConflict");
    this.name = "DuplicateReceiptCommandConflictError";
  }
}

export class ReceiptNotFoundError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptNotFound");
    this.name = "ReceiptNotFoundError";
  }
}

export class StaleReceiptRevisionError extends ReceiptRejectionError {
  constructor() {
    super("StaleReceiptRevision");
    this.name = "StaleReceiptRevisionError";
  }
}

export class InvalidReceiptTransitionError extends ReceiptRejectionError {
  constructor() {
    super("InvalidReceiptTransition");
    this.name = "InvalidReceiptTransitionError";
  }
}

export class ReceiptFileNotStagedError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptFileNotStaged");
    this.name = "ReceiptFileNotStagedError";
  }
}

export class ReceiptPersistenceSdkError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptPersistenceError");
    this.name = "ReceiptPersistenceSdkError";
  }
}
export class AdmissionPeriodRejectionError extends SdkError {
  readonly _tag: AdmissionPeriodRejectionTag;
  readonly admissionTag: AdmissionPeriodRejectionTag;

  constructor(tag: AdmissionPeriodRejectionTag) {
    super("admission_period_rejection", tag);
    this.name = "AdmissionPeriodRejectionError";
    this._tag = tag;
    this.admissionTag = tag;
  }
}

export class AdmissionRoleDeniedError extends AdmissionPeriodRejectionError {
  constructor() {
    super("AdmissionRoleDenied");
    this.name = "AdmissionRoleDeniedError";
  }
}

export class AdmissionScopeDeniedError extends AdmissionPeriodRejectionError {
  constructor() {
    super("AdmissionScopeDenied");
    this.name = "AdmissionScopeDeniedError";
  }
}

export class DepartmentRequiredError extends AdmissionPeriodRejectionError {
  constructor() {
    super("DepartmentRequired");
    this.name = "DepartmentRequiredError";
  }
}

export class DepartmentNotFoundError extends AdmissionPeriodRejectionError {
  constructor() {
    super("DepartmentNotFound");
    this.name = "DepartmentNotFoundError";
  }
}

export class SemesterNotFoundError extends AdmissionPeriodRejectionError {
  constructor() {
    super("SemesterNotFound");
    this.name = "SemesterNotFoundError";
  }
}

export class AdmissionPeriodNotFoundError extends AdmissionPeriodRejectionError {
  constructor() {
    super("AdmissionPeriodNotFound");
    this.name = "AdmissionPeriodNotFoundError";
  }
}

export class AdmissionPeriodDecodeSdkError extends AdmissionPeriodRejectionError {
  constructor() {
    super("AdmissionPeriodDecodeError");
    this.name = "AdmissionPeriodDecodeSdkError";
  }
}

export class InvalidAdmissionPeriodWindowError extends AdmissionPeriodRejectionError {
  constructor() {
    super("InvalidAdmissionPeriodWindow");
    this.name = "InvalidAdmissionPeriodWindowError";
  }
}

export class AdmissionWindowOutsideSemesterError extends AdmissionPeriodRejectionError {
  constructor() {
    super("AdmissionWindowOutsideSemester");
    this.name = "AdmissionWindowOutsideSemesterError";
  }
}

export class AdmissionPeriodAlreadyExistsError extends AdmissionPeriodRejectionError {
  constructor() {
    super("AdmissionPeriodAlreadyExists");
    this.name = "AdmissionPeriodAlreadyExistsError";
  }
}

export class StaleAdmissionPeriodRevisionError extends AdmissionPeriodRejectionError {
  constructor() {
    super("StaleAdmissionPeriodRevision");
    this.name = "StaleAdmissionPeriodRevisionError";
  }
}

export class DuplicateAdmissionPeriodCommandConflictError extends AdmissionPeriodRejectionError {
  constructor() {
    super("DuplicateAdmissionPeriodCommandConflict");
    this.name = "DuplicateAdmissionPeriodCommandConflictError";
  }
}

export class AdmissionPeriodPersistenceSdkError extends AdmissionPeriodRejectionError {
  constructor() {
    super("AdmissionPeriodPersistenceError");
    this.name = "AdmissionPeriodPersistenceSdkError";
  }
}

export class AdmissionApplicationRejectionError extends SdkError {
  readonly _tag: AdmissionApplicationRejectionTag;
  readonly applicationTag: AdmissionApplicationRejectionTag;

  constructor(tag: AdmissionApplicationRejectionTag) {
    super("admission_application_rejection", tag);
    this.name = "AdmissionApplicationRejectionError";
    this._tag = tag;
    this.applicationTag = tag;
  }
}

export class AdmissionApplicationDecodeSdkError extends AdmissionApplicationRejectionError {
  constructor() {
    super("AdmissionApplicationDecodeError");
    this.name = "AdmissionApplicationDecodeSdkError";
  }
}
export class NoOpenAdmissionPeriodError extends AdmissionApplicationRejectionError {
  constructor() {
    super("NoOpenAdmissionPeriod");
    this.name = "NoOpenAdmissionPeriodError";
  }
}
export class AdmissionApplicationAlreadyExistsError extends AdmissionApplicationRejectionError {
  constructor() {
    super("AdmissionApplicationAlreadyExists");
    this.name = "AdmissionApplicationAlreadyExistsError";
  }
}
export class DuplicateAdmissionApplicationCommandConflictError extends AdmissionApplicationRejectionError {
  constructor() {
    super("DuplicateAdmissionApplicationCommandConflict");
    this.name = "DuplicateAdmissionApplicationCommandConflictError";
  }
}
export class AdmissionApplicationPersistenceSdkError extends AdmissionApplicationRejectionError {
  constructor() {
    super("AdmissionApplicationPersistenceError");
    this.name = "AdmissionApplicationPersistenceSdkError";
  }
}

// --- Internal Effect TaggedErrors ---



export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class Validation extends Schema.TaggedError<Validation>()("Validation", {
  message: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String),
}) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

export class Network extends Schema.TaggedError<Network>()("Network", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  message: Schema.String,
}) {}

export class Configuration extends Schema.TaggedError<Configuration>()("Configuration", {
  message: Schema.String,
}) {}

export class UnauthenticatedActor extends Schema.TaggedError<UnauthenticatedActor>()(
  "UnauthenticatedActor",
  {},
) {}

export class InactiveActor extends Schema.TaggedError<InactiveActor>()("InactiveActor", {}) {}

export class ReceiptOwnerDenied extends Schema.TaggedError<ReceiptOwnerDenied>()(
  "ReceiptOwnerDenied",
  {},
) {}

export class ReceiptScopeDenied extends Schema.TaggedError<ReceiptScopeDenied>()(
  "ReceiptScopeDenied",
  {},
) {}

export class ReceiptDecodeError extends Schema.TaggedError<ReceiptDecodeError>()(
  "ReceiptDecodeError",
  {},
) {}

export class ReceiptAlreadyExists extends Schema.TaggedError<ReceiptAlreadyExists>()(
  "ReceiptAlreadyExists",
  {},
) {}

export class DuplicateReceiptCommandConflict extends Schema.TaggedError<DuplicateReceiptCommandConflict>()(
  "DuplicateReceiptCommandConflict",
  {},
) {}

export class ReceiptNotFound extends Schema.TaggedError<ReceiptNotFound>()("ReceiptNotFound", {}) {}

export class StaleReceiptRevision extends Schema.TaggedError<StaleReceiptRevision>()(
  "StaleReceiptRevision",
  {},
) {}

export class InvalidReceiptTransition extends Schema.TaggedError<InvalidReceiptTransition>()(
  "InvalidReceiptTransition",
  {},
) {}

export class ReceiptFileNotStaged extends Schema.TaggedError<ReceiptFileNotStaged>()(
  "ReceiptFileNotStaged",
  {},
) {}

export class ReceiptPersistenceError extends Schema.TaggedError<ReceiptPersistenceError>()(
  "ReceiptPersistenceError",
  {},
) {}
export class AdmissionRoleDenied extends Schema.TaggedError<AdmissionRoleDenied>()(
  "AdmissionRoleDenied",
  {},
) {}
export class AdmissionScopeDenied extends Schema.TaggedError<AdmissionScopeDenied>()(
  "AdmissionScopeDenied",
  {},
) {}
export class DepartmentRequired extends Schema.TaggedError<DepartmentRequired>()(
  "DepartmentRequired",
  {},
) {}
export class DepartmentNotFound extends Schema.TaggedError<DepartmentNotFound>()(
  "DepartmentNotFound",
  {},
) {}
export class SemesterNotFound extends Schema.TaggedError<SemesterNotFound>()(
  "SemesterNotFound",
  {},
) {}
export class AdmissionPeriodNotFound extends Schema.TaggedError<AdmissionPeriodNotFound>()(
  "AdmissionPeriodNotFound",
  {},
) {}
export class AdmissionPeriodDecodeError extends Schema.TaggedError<AdmissionPeriodDecodeError>()(
  "AdmissionPeriodDecodeError",
  {},
) {}
export class InvalidAdmissionPeriodWindow extends Schema.TaggedError<InvalidAdmissionPeriodWindow>()(
  "InvalidAdmissionPeriodWindow",
  {},
) {}
export class AdmissionWindowOutsideSemester extends Schema.TaggedError<AdmissionWindowOutsideSemester>()(
  "AdmissionWindowOutsideSemester",
  {},
) {}
export class AdmissionPeriodAlreadyExists extends Schema.TaggedError<AdmissionPeriodAlreadyExists>()(
  "AdmissionPeriodAlreadyExists",
  {},
) {}
export class StaleAdmissionPeriodRevision extends Schema.TaggedError<StaleAdmissionPeriodRevision>()(
  "StaleAdmissionPeriodRevision",
  {},
) {}
export class DuplicateAdmissionPeriodCommandConflict extends Schema.TaggedError<DuplicateAdmissionPeriodCommandConflict>()(
  "DuplicateAdmissionPeriodCommandConflict",
  {},
) {}
export class AdmissionPeriodPersistenceError extends Schema.TaggedError<AdmissionPeriodPersistenceError>()(
  "AdmissionPeriodPersistenceError",
  {},
) {}
export class AdmissionApplicationDecodeError extends Schema.TaggedError<AdmissionApplicationDecodeError>()(
  "AdmissionApplicationDecodeError",
  {},
) {}
export class NoOpenAdmissionPeriod extends Schema.TaggedError<NoOpenAdmissionPeriod>()(
  "NoOpenAdmissionPeriod",
  {},
) {}
export class AdmissionApplicationAlreadyExists extends Schema.TaggedError<AdmissionApplicationAlreadyExists>()(
  "AdmissionApplicationAlreadyExists",
  {},
) {}
export class DuplicateAdmissionApplicationCommandConflict extends Schema.TaggedError<DuplicateAdmissionApplicationCommandConflict>()(
  "DuplicateAdmissionApplicationCommandConflict",
  {},
) {}
export class AdmissionApplicationPersistenceError extends Schema.TaggedError<AdmissionApplicationPersistenceError>()(
  "AdmissionApplicationPersistenceError",
  {},
) {}

export type ReceiptFailure =
  | UnauthenticatedActor
  | InactiveActor
  | ReceiptOwnerDenied
  | ReceiptScopeDenied
  | ReceiptDecodeError
  | ReceiptAlreadyExists
  | DuplicateReceiptCommandConflict
  | ReceiptNotFound
  | StaleReceiptRevision
  | InvalidReceiptTransition
  | ReceiptFileNotStaged
  | ReceiptPersistenceError;
export type AdmissionPeriodFailure =
  | UnauthenticatedActor
  | InactiveActor
  | AdmissionRoleDenied
  | AdmissionScopeDenied
  | DepartmentRequired
  | DepartmentNotFound
  | SemesterNotFound
  | AdmissionPeriodNotFound
  | AdmissionPeriodDecodeError
  | InvalidAdmissionPeriodWindow
  | AdmissionWindowOutsideSemester
  | AdmissionPeriodAlreadyExists
  | StaleAdmissionPeriodRevision
  | DuplicateAdmissionPeriodCommandConflict
  | AdmissionPeriodPersistenceError;
export type AdmissionApplicationFailure =
  | AdmissionApplicationDecodeError
  | NoOpenAdmissionPeriod
  | AdmissionApplicationAlreadyExists
  | DuplicateAdmissionApplicationCommandConflict
  | AdmissionApplicationPersistenceError;

export type AdmissionApplicationSdkError = AdmissionApplicationFailure;

export type AdmissionPeriodSdkError = AdmissionPeriodFailure;


export type ReceiptSdkError = ReceiptFailure;

export type InternalSdkError =
  | Unauthorized
  | NotFound
  | Validation
  | Conflict
  | Network
  | RateLimited
  | Configuration
  | ReceiptFailure
  | AdmissionPeriodFailure
  | AdmissionApplicationFailure;

/**
 * Maps an internal Effect TaggedError to a public SdkError subclass.
 * Used at the Effect.runPromise boundary.
 */
export function toSdkError(error: InternalSdkError): SdkError {
  switch (error._tag) {
    case "Unauthorized":
      return new UnauthorizedError(error.message);
    case "NotFound":
      return new NotFoundError(error.message);
    case "Validation":
      return new ValidationError(error.message, error.fields as Record<string, string>);
    case "Conflict":
      return new ConflictError(error.message);
    case "Network":
      return new NetworkError(error.message, error.cause);
    case "RateLimited":
      return new RateLimitedError(error.message);
    case "Configuration":
      return new ConfigurationError(error.message);
    case "UnauthenticatedActor":
      return new UnauthenticatedActorError();
    case "InactiveActor":
      return new InactiveActorError();
    case "ReceiptOwnerDenied":
      return new ReceiptOwnerDeniedError();
    case "ReceiptScopeDenied":
      return new ReceiptScopeDeniedError();
    case "ReceiptDecodeError":
      return new ReceiptDecodeSdkError();
    case "ReceiptAlreadyExists":
      return new ReceiptAlreadyExistsError();
    case "DuplicateReceiptCommandConflict":
      return new DuplicateReceiptCommandConflictError();
    case "ReceiptNotFound":
      return new ReceiptNotFoundError();
    case "StaleReceiptRevision":
      return new StaleReceiptRevisionError();
    case "InvalidReceiptTransition":
      return new InvalidReceiptTransitionError();
    case "ReceiptFileNotStaged":
      return new ReceiptFileNotStagedError();
    case "ReceiptPersistenceError":
      return new ReceiptPersistenceSdkError();
    case "AdmissionRoleDenied":
      return new AdmissionRoleDeniedError();
    case "AdmissionScopeDenied":
      return new AdmissionScopeDeniedError();
    case "DepartmentRequired":
      return new DepartmentRequiredError();
    case "DepartmentNotFound":
      return new DepartmentNotFoundError();
    case "SemesterNotFound":
      return new SemesterNotFoundError();
    case "AdmissionPeriodNotFound":
      return new AdmissionPeriodNotFoundError();
    case "AdmissionPeriodDecodeError":
      return new AdmissionPeriodDecodeSdkError();
    case "InvalidAdmissionPeriodWindow":
      return new InvalidAdmissionPeriodWindowError();
    case "AdmissionWindowOutsideSemester":
      return new AdmissionWindowOutsideSemesterError();
    case "AdmissionPeriodAlreadyExists":
      return new AdmissionPeriodAlreadyExistsError();
    case "StaleAdmissionPeriodRevision":
      return new StaleAdmissionPeriodRevisionError();
    case "DuplicateAdmissionPeriodCommandConflict":
      return new DuplicateAdmissionPeriodCommandConflictError();
    case "AdmissionPeriodPersistenceError":
      return new AdmissionPeriodPersistenceSdkError();
    case "AdmissionApplicationDecodeError":
      return new AdmissionApplicationDecodeSdkError();
    case "NoOpenAdmissionPeriod":
      return new NoOpenAdmissionPeriodError();
    case "AdmissionApplicationAlreadyExists":
      return new AdmissionApplicationAlreadyExistsError();
    case "DuplicateAdmissionApplicationCommandConflict":
      return new DuplicateAdmissionApplicationCommandConflictError();
    case "AdmissionApplicationPersistenceError":
      return new AdmissionApplicationPersistenceSdkError();
  }
}
