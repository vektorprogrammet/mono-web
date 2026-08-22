import { Schema } from "effect";

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

export const isIsoDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
};

export const isIsoInstant = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  !Number.isNaN(Date.parse(value));

const IsoDate = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isIsoDate, { message: "a valid YYYY-MM-DD date" })),
);
const IsoInstant = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isIsoInstant, { message: "an ISO-8601 instant with offset" })),
);
const PositiveOre = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
);
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const ReceiptStatusSchema = Schema.Literals([
  "Pending",
  "Refunded",
  "Rejected",
  "Withdrawn",
]);
export type ReceiptStatus = typeof ReceiptStatusSchema.Type;

export const ApprovalScopeSchema = Schema.TaggedUnion({
  None: {},
  Department: { departmentId: NonEmpty },
  Global: {},
});
export type ApprovalScope = typeof ApprovalScopeSchema.Type;

export const ReceiptActorSchema = Schema.Struct({
  personId: NonEmpty,
  departmentId: NonEmpty,
  active: Schema.Boolean,
  approvalScope: ApprovalScopeSchema,
});
export type ReceiptActor = typeof ReceiptActorSchema.Type;

export const ReceiptFileSchema = Schema.Struct({
  fileRef: NonEmpty,
  objectKey: NonEmpty,
  contentType: Schema.Literals(["image/jpeg", "image/png", "application/pdf"]),
  byteLength: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
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
);
export type ReceiptFile = typeof ReceiptFileSchema.Type;

const ReceiptPayloadFields = {
  description: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5000))),
  amountOre: PositiveOre,
  receiptDate: IsoDate,
  file: ReceiptFileSchema,
};

export const ReceiptCommandSchema = Schema.TaggedUnion({
  SubmitReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    departmentId: NonEmpty,
    paymentAccountCiphertext: NonEmpty,
    ...ReceiptPayloadFields,
  },
  RevisePendingReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    receiptId: NonEmpty,
    expectedRevision: Revision,
    ...ReceiptPayloadFields,
  },
  WithdrawPendingReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    receiptId: NonEmpty,
    expectedRevision: Revision,
  },
  RefundReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    receiptId: NonEmpty,
    expectedRevision: Revision,
  },
  RejectReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    receiptId: NonEmpty,
    expectedRevision: Revision,
  },
});
export type ReceiptCommand = typeof ReceiptCommandSchema.Type;

export const ReceiptSchema = Schema.Struct({
  receiptId: NonEmpty,
  visualId: NonEmpty,
  ownerPersonId: NonEmpty,
  departmentId: NonEmpty,
  amountOre: PositiveOre,
  currency: Schema.Literal("NOK"),
  description: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5000))),
  receiptDate: IsoDate,
  submittedAt: IsoInstant,
  status: ReceiptStatusSchema,
  refundDate: Schema.NullOr(IsoInstant),
  paymentAccountCiphertext: NonEmpty,
  file: ReceiptFileSchema,
  revision: Revision,
});
export type Receipt = typeof ReceiptSchema.Type;

export const ReceiptObservationSchema = Schema.Struct({
  commandId: NonEmpty,
  receiptId: NonEmpty,
  visualId: NonEmpty,
  status: ReceiptStatusSchema,
  revision: Revision,
  replayed: Schema.Boolean,
});
export type ReceiptObservation = typeof ReceiptObservationSchema.Type;

export const LegacyReceiptFileSchema = Schema.Struct({
  fileRef: Schema.String,
  objectKey: Schema.String,
  contentType: Schema.String,
  byteLength: Schema.Number,
  sha256: Schema.String,
});

export const LegacyReceiptRowSchema = Schema.Struct({
  sourcePrimaryKey: NonEmpty,
  ownerPersonId: Schema.NullOr(NonEmpty),
  departmentId: Schema.NullOr(NonEmpty),
  visualId: Schema.NullOr(NonEmpty),
  amountDecimal: NonEmpty,
  description: NonEmpty,
  receiptDate: NonEmpty,
  submittedAt: NonEmpty,
  status: NonEmpty,
  refundDate: Schema.NullOr(NonEmpty),
  paymentAccountCiphertext: Schema.NullOr(NonEmpty),
  file: Schema.NullOr(LegacyReceiptFileSchema),
});
export type LegacyReceiptRow = typeof LegacyReceiptRowSchema.Type;
