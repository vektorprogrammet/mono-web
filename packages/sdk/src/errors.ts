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
    fields: Schema.Record({ key: Schema.String, value: Schema.String }),
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

export type InternalSdkError =
  | Unauthorized
  | NotFound
  | Validation
  | Conflict
  | Network
  | RateLimited

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
  }
}
