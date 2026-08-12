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
