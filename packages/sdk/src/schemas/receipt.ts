import { Schema } from "effect"

export class Receipt extends Schema.Class<Receipt>("Receipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: Schema.String,
  submitDate: Schema.String,
  status: Schema.Literal("pending", "refunded", "rejected"),
  refundDate: Schema.NullOr(Schema.String),
}) {
  get isPending() { return this.status === "pending" }
  get formattedAmount() { return `${this.sum} kr` }
}

export class AdminReceipt extends Schema.Class<AdminReceipt>("AdminReceipt")({
  id: Schema.Number,
  visualId: Schema.String,
  description: Schema.String,
  sum: Schema.Number,
  receiptDate: Schema.String,
  submitDate: Schema.String,
  status: Schema.Literal("pending", "refunded", "rejected"),
  refundDate: Schema.NullOr(Schema.String),
  userName: Schema.String,
}) {}

export class ReceiptInput extends Schema.Class<ReceiptInput>("ReceiptInput")({
  description: Schema.String.pipe(Schema.nonEmptyString(), Schema.maxLength(5000)),
  sum: Schema.Number.pipe(Schema.positive()),
  receiptDate: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
}) {}

export class ReceiptCreateResponse extends Schema.Class<ReceiptCreateResponse>("ReceiptCreateResponse")({
  id: Schema.Number,
}) {}
