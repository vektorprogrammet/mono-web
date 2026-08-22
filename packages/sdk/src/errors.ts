/**
 * Public error hierarchy for the SDK.
 * Consumers use instanceof checks and the .type discriminant.
 *
 * Internally, Effect TaggedErrors are mapped to these at the runPromise boundary.
 */

import { Schema } from "effect"

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

export type ReceiptRejectionTag =
  | "UnauthenticatedActor"
  | "InactiveActor"
  | "ReceiptOwnerDenied"
  | "ReceiptDecodeError"
  | "ReceiptAlreadyExists"
  | "DuplicateReceiptCommandConflict"
  | "ReceiptPersistenceError"

export class SdkError extends Error {
  readonly type: SdkErrorType

  constructor(type: SdkErrorType, message: string, options?: ErrorOptions) {
    super(message, options)
    this.type = type
    this.name = "SdkError"
  }
}

export class UnauthorizedError extends SdkError {
  constructor(message = "Unauthorized") {
    super("unauthorized", message)
    this.name = "UnauthorizedError"
  }
}

export class NotFoundError extends SdkError {
  constructor(message = "Not found") {
    super("not_found", message)
    this.name = "NotFoundError"
  }
}

export class ValidationError extends SdkError {
  readonly fields: Record<string, string>

  constructor(message = "Validation failed", fields: Record<string, string> = {}) {
    super("validation", message)
    this.name = "ValidationError"
    this.fields = fields
  }
}

export class ConflictError extends SdkError {
  constructor(message = "Conflict") {
    super("conflict", message)
    this.name = "ConflictError"
  }
}

export class NetworkError extends SdkError {
  override readonly cause: unknown

  constructor(message = "Network error", cause?: unknown) {
    super("network", message, { cause })
    this.name = "NetworkError"
    this.cause = cause
  }
}

export class RateLimitedError extends SdkError {
  constructor(message = "Rate limited") {
    super("rate_limited", message)
    this.name = "RateLimitedError"
  }
}

export class ConfigurationError extends SdkError {
  constructor(message = "Invalid API URL") {
    super("configuration", message)
    this.name = "ConfigurationError"
  }
}

export class ReceiptRejectionError extends SdkError {
  readonly _tag: ReceiptRejectionTag
  readonly receiptTag: ReceiptRejectionTag

  constructor(tag: ReceiptRejectionTag) {
    super("receipt_rejection", tag)
    this.name = "ReceiptRejectionError"
    this._tag = tag
    this.receiptTag = tag
  }
}

export class UnauthenticatedActorError extends ReceiptRejectionError {
  constructor() {
    super("UnauthenticatedActor")
    this.name = "UnauthenticatedActorError"
  }
}

export class InactiveActorError extends ReceiptRejectionError {
  constructor() {
    super("InactiveActor")
    this.name = "InactiveActorError"
  }
}

export class ReceiptOwnerDeniedError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptOwnerDenied")
    this.name = "ReceiptOwnerDeniedError"
  }
}

export class ReceiptDecodeSdkError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptDecodeError")
    this.name = "ReceiptDecodeSdkError"
  }
}

export class ReceiptAlreadyExistsError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptAlreadyExists")
    this.name = "ReceiptAlreadyExistsError"
  }
}

export class DuplicateReceiptCommandConflictError extends ReceiptRejectionError {
  constructor() {
    super("DuplicateReceiptCommandConflict")
    this.name = "DuplicateReceiptCommandConflictError"
  }
}

export class ReceiptPersistenceSdkError extends ReceiptRejectionError {
  constructor() {
    super("ReceiptPersistenceError")
    this.name = "ReceiptPersistenceSdkError"
  }
}

// --- Internal Effect TaggedErrors ---

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
) {}

export class Validation extends Schema.TaggedError<Validation>()(
  "Validation",
  {
    message: Schema.String,
    fields: Schema.Record(Schema.String, Schema.String),
  },
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
) {}

export class Network extends Schema.TaggedError<Network>()(
  "Network",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { message: Schema.String },
) {}

export class Configuration extends Schema.TaggedError<Configuration>()(
  "Configuration",
  { message: Schema.String },
) {}

export class UnauthenticatedActor extends Schema.TaggedError<UnauthenticatedActor>()(
  "UnauthenticatedActor",
  {},
) {}

export class InactiveActor extends Schema.TaggedError<InactiveActor>()(
  "InactiveActor",
  {},
) {}

export class ReceiptOwnerDenied extends Schema.TaggedError<ReceiptOwnerDenied>()(
  "ReceiptOwnerDenied",
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

export class ReceiptPersistenceError extends Schema.TaggedError<ReceiptPersistenceError>()(
  "ReceiptPersistenceError",
  {},
) {}

export type ReceiptFailure =
  | UnauthenticatedActor
  | InactiveActor
  | ReceiptOwnerDenied
  | ReceiptDecodeError
  | ReceiptAlreadyExists
  | DuplicateReceiptCommandConflict
  | ReceiptPersistenceError

export type ReceiptSdkError = ReceiptFailure

export type InternalSdkError =
  | Unauthorized
  | NotFound
  | Validation
  | Conflict
  | Network
  | RateLimited
  | Configuration
  | ReceiptFailure


/**
 * Maps an internal Effect TaggedError to a public SdkError subclass.
 * Used at the Effect.runPromise boundary.
 */
export function toSdkError(error: InternalSdkError): SdkError {
  switch (error._tag) {
    case "Unauthorized":
      return new UnauthorizedError(error.message)
    case "NotFound":
      return new NotFoundError(error.message)
    case "Validation":
      return new ValidationError(error.message, error.fields as Record<string, string>)
    case "Conflict":
      return new ConflictError(error.message)
    case "Network":
      return new NetworkError(error.message, error.cause)
    case "RateLimited":
      return new RateLimitedError(error.message)
    case "Configuration":
      return new ConfigurationError(error.message)
    case "UnauthenticatedActor":
      return new UnauthenticatedActorError()
    case "InactiveActor":
      return new InactiveActorError()
    case "ReceiptOwnerDenied":
      return new ReceiptOwnerDeniedError()
    case "ReceiptDecodeError":
      return new ReceiptDecodeSdkError()
    case "ReceiptAlreadyExists":
      return new ReceiptAlreadyExistsError()
    case "DuplicateReceiptCommandConflict":
      return new DuplicateReceiptCommandConflictError()
    case "ReceiptPersistenceError":
      return new ReceiptPersistenceSdkError()
  }
}
