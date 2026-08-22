import { Schema } from "effect"
import { DateFromIso, NullableDateFromIso } from "../adapter/dates.js"

export class Receipt extends Schema.Class<Receipt>("Receipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: DateFromIso,
  submitDate: DateFromIso,
  status: Schema.Literals(["pending", "refunded", "rejected"]),
  refundDate: NullableDateFromIso,
}) {
  get isPending() { return this.status === "pending" }
  get formattedAmount() { return `${this.sum} kr` }
}

export class AdminReceipt extends Schema.Class<AdminReceipt>("AdminReceipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: DateFromIso,
  submitDate: DateFromIso,
  status: Schema.Literals(["pending", "refunded", "rejected"]),
  refundDate: NullableDateFromIso,
  userName: Schema.String,
}) {}

export class ReceiptInput extends Schema.Class<ReceiptInput>("ReceiptInput")({
  description: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
  ),
  sum: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0))),
  receiptDate: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter(
        (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value),
        { message: "a YYYY-MM-DD date string" },
      ),
    ),
  ),
}) {}

export class ReceiptCreateResponse extends Schema.Class<ReceiptCreateResponse>("ReceiptCreateResponse")({
  id: Schema.Number,
}) {}
/**
 * Canonical owner-submission schemas.
 *
 * These schemas intentionally live beside the legacy Receipt CRUD schemas above.
 * The native owner capability uses stable string identifiers, integer øre, and
 * PascalCase statuses; the legacy API keeps its existing numeric and lowercase
 * representations until its own cut-over specification.
 */

const canonicalIdentifier = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => value.length > 0, {
      message: "a non-empty stable string identifier",
    }),
  ),
)

const canonicalSafeInteger = Schema.Int.pipe(
  Schema.check(
    Schema.makeFilter((value: number) => Number.isSafeInteger(value), {
      message: "a safe integer",
    }),
  ),
)

const canonicalPositiveOre = canonicalSafeInteger.pipe(
  Schema.check(Schema.isGreaterThan(0)),
)

const canonicalReceiptDate = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
        const date = new Date(`${value}T00:00:00.000Z`)
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
      },
      { message: "a valid YYYY-MM-DD calendar date" },
    ),
  ),
)

export const ReceiptId = canonicalIdentifier
export type ReceiptId = typeof ReceiptId.Type

export const CommandId = canonicalIdentifier
export type CommandId = typeof CommandId.Type

export const ReceiptStatus = Schema.Literals([
  "Pending",
  "Refunded",
  "Rejected",
  "Withdrawn",
])
export type ReceiptStatus = typeof ReceiptStatus.Type

/**
 * Immutable private-file identity returned by the native file boundary.
 * The browser submission itself carries a File and never accepts this object.
 */
export const ReceiptFile = Schema.Struct({
  fileRef: canonicalIdentifier,
  objectKey: canonicalIdentifier,
  contentType: Schema.Literals(["image/jpeg", "image/png", "application/pdf"]),
  byteLength: canonicalPositiveOre,
  sha256: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value: string) => /^[a-f0-9]{64}$/.test(value), {
        message: "a lowercase SHA-256 digest",
      }),
    ),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((file) => file.fileRef !== file.objectKey, {
      message: "different staging and committed object identities",
    }),
  ),
)
export type ReceiptFile = typeof ReceiptFile.Type

export const ReceiptIdSchema = ReceiptId
export const CommandIdSchema = CommandId
export const ReceiptStatusSchema = ReceiptStatus
export const ReceiptFileSchema = ReceiptFile

export class ReceiptSubmitInput extends Schema.Class<ReceiptSubmitInput>("ReceiptSubmitInput")({
  commandId: CommandId,
  description: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
  ),
  amountOre: canonicalPositiveOre,
  receiptDate: canonicalReceiptDate,
}) {}

export class ReceiptCommandObservation extends Schema.Class<ReceiptCommandObservation>("ReceiptCommandObservation")({
  commandId: CommandId,
  receiptId: ReceiptId,
  visualId: canonicalIdentifier,
  status: ReceiptStatus,
  revision: canonicalSafeInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  replayed: Schema.Boolean,
}) {}

/**
 * Owner projection item. Actor and department identifiers are returned only
 * as stable strings; payment authority and private file bytes never cross it.
 */
export class ReceiptProjection extends Schema.Class<ReceiptProjection>("ReceiptProjection")({
  receiptId: ReceiptId,
  visualId: canonicalIdentifier,
  ownerPersonId: canonicalIdentifier,
  departmentId: canonicalIdentifier,
  amountOre: canonicalPositiveOre,
  currency: Schema.Literal("NOK"),
  description: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
  ),
  receiptDate: canonicalReceiptDate,
  status: ReceiptStatus,
  revision: canonicalSafeInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

export class ReceiptPage extends Schema.Class<ReceiptPage>("ReceiptPage")({
  items: Schema.Array(ReceiptProjection),
  totalItems: canonicalSafeInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

export class ReceiptOwnerFilter extends Schema.Class<ReceiptOwnerFilter>("ReceiptOwnerFilter")({
  status: Schema.optional(ReceiptStatus),
  page: Schema.optional(canonicalPositiveOre),
  pageSize: Schema.optional(canonicalPositiveOre),
}) {}

// Explicit schema aliases make the wire boundary discoverable without
// introducing a second representation of any canonical type.
export const ReceiptSubmitInputSchema = ReceiptSubmitInput
export const ReceiptCommandObservationSchema = ReceiptCommandObservation
export const ReceiptProjectionSchema = ReceiptProjection
export const ReceiptPageSchema = ReceiptPage
export const ReceiptOwnerFilterSchema = ReceiptOwnerFilter
