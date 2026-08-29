import { Schema } from "effect";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { Rfc3339InstantSchema } from "../time.js";

export class ReceiptDecodeError extends Schema.TaggedError<ReceiptDecodeError>()(
  "ReceiptDecodeError",
  { message: Schema.String },
) {}

export class UnauthenticatedActor extends Schema.TaggedError<UnauthenticatedActor>()(
  "UnauthenticatedActor",
  { message: Schema.String },
) {}

export class InactiveActor extends Schema.TaggedError<InactiveActor>()("InactiveActor", {
  personId: Schema.String,
}) {}

export class ReceiptNotFound extends Schema.TaggedError<ReceiptNotFound>()("ReceiptNotFound", {
  receiptId: Schema.String,
}) {}

export class ReceiptAlreadyExists extends Schema.TaggedError<ReceiptAlreadyExists>()(
  "ReceiptAlreadyExists",
  { receiptId: Schema.String },
) {}

export class ReceiptScopeDenied extends Schema.TaggedError<ReceiptScopeDenied>()(
  "ReceiptScopeDenied",
  { receiptId: Schema.String, departmentId: Schema.String },
) {}

export class ReceiptOwnerDenied extends Schema.TaggedError<ReceiptOwnerDenied>()(
  "ReceiptOwnerDenied",
  { receiptId: Schema.String, personId: Schema.String },
) {}

export class StaleReceiptRevision extends Schema.TaggedError<StaleReceiptRevision>()(
  "StaleReceiptRevision",
  { receiptId: Schema.String, expected: Schema.Number, actual: Schema.Number },
) {}

export class InvalidReceiptTransition extends Schema.TaggedError<InvalidReceiptTransition>()(
  "InvalidReceiptTransition",
  { receiptId: Schema.String, status: Schema.String, command: Schema.String },
) {}

export class DuplicateReceiptCommandConflict extends Schema.TaggedError<DuplicateReceiptCommandConflict>()(
  "DuplicateReceiptCommandConflict",
  { commandId: Schema.String },
) {}

export class ReceiptPersistenceError extends Schema.TaggedError<ReceiptPersistenceError>()(
  "ReceiptPersistenceError",
  { operation: Schema.String, message: Schema.String },
) {}
export const ReceiptAuthorityOperationSchema = Schema.Literals([
  "Submission",
  "DepartmentApproval",
  "GlobalApproval",
  "Owner",
]);
export type ReceiptAuthorityOperation = typeof ReceiptAuthorityOperationSchema.Type;

export class ReceiptAuthorityDenied extends Schema.TaggedError<ReceiptAuthorityDenied>()(
  "ReceiptAuthorityDenied",
  {
    personId: PersonId,
    operation: ReceiptAuthorityOperationSchema,
    departmentId: Schema.NullOr(DepartmentId),
  },
) {}

export class AmbiguousReceiptPaymentAuthority extends Schema.TaggedError<AmbiguousReceiptPaymentAuthority>()(
  "AmbiguousReceiptPaymentAuthority",
  {
    personId: PersonId,
    departmentIds: Schema.Array(DepartmentId),
  },
) {}

/** The request must select one department when several active payment
 *  authorities apply; Economy never picks a primary department. */
export class AmbiguousPaymentSelection extends Schema.TaggedError<AmbiguousPaymentSelection>()(
  "AmbiguousPaymentSelection",
  { personId: PersonId, departmentIds: Schema.Array(DepartmentId) },
) {}

export class ReceiptAuthorityProjectionMismatch extends Schema.TaggedError<ReceiptAuthorityProjectionMismatch>()(
  "ReceiptAuthorityProjectionMismatch",
  {
    personId: PersonId,
    authorizationInstant: Rfc3339InstantSchema,
    organizationPersonId: PersonId,
    organizationEvaluatedAt: Rfc3339InstantSchema,
  },
) {}

export type ReceiptAuthorityMappingError =
  | ReceiptAuthorityDenied
  | AmbiguousReceiptPaymentAuthority;

export type ReceiptAuthorityResolutionError =
  | ReceiptDecodeError
  | ReceiptPersistenceError
  | ReceiptAuthorityProjectionMismatch;

export type ReceiptFailure =
  | ReceiptDecodeError
  | UnauthenticatedActor
  | InactiveActor
  | ReceiptNotFound
  | ReceiptAlreadyExists
  | ReceiptScopeDenied
  | ReceiptOwnerDenied
  | StaleReceiptRevision
  | InvalidReceiptTransition
  | DuplicateReceiptCommandConflict
  | ReceiptAuthorityDenied
  | AmbiguousPaymentSelection
  | ReceiptPersistenceError;
