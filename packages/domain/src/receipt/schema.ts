import { Schema } from "effect";
import { Model } from "effect/unstable/schema";

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
export const ReceiptId = NonEmpty.pipe(Schema.brand("ReceiptId"));
export type ReceiptId = typeof ReceiptId.Type;

export const ReceiptVisualId = NonEmpty.pipe(Schema.brand("ReceiptVisualId"));
export type ReceiptVisualId = typeof ReceiptVisualId.Type;

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
  byteLength: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ),
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
};

const ReceiptFileSelectionSchema = Schema.Union([
  ReceiptFileSchema,
  Schema.TaggedUnion({
    KeepCurrentFile: {},
  }),
]);

export type ReceiptFileSelection = typeof ReceiptFileSelectionSchema.Type;

export const ReceiptCommandSchema = Schema.TaggedUnion({
  SubmitReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    departmentId: NonEmpty,
    paymentAccountCiphertext: NonEmpty,
    ...ReceiptPayloadFields,
    file: ReceiptFileSchema,
  },
  RevisePendingReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    receiptId: ReceiptId,
    expectedRevision: Revision,
    ...ReceiptPayloadFields,
    file: ReceiptFileSelectionSchema,
  },
  WithdrawPendingReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    receiptId: ReceiptId,
    expectedRevision: Revision,
  },
  RefundReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    receiptId: ReceiptId,
    expectedRevision: Revision,
  },
  RejectReceipt: {
    commandId: NonEmpty,
    actor: ReceiptActorSchema,
    receiptId: ReceiptId,
    expectedRevision: Revision,
  },
});
export type ReceiptCommand = typeof ReceiptCommandSchema.Type;

export class Receipt extends Model.Class<Receipt>("Receipt")({
  receiptId: Model.Field({
    select: ReceiptId,
    insert: ReceiptId,
    json: ReceiptId,
  }),
  visualId: Model.Field({
    select: ReceiptVisualId,
    insert: ReceiptVisualId,
    json: ReceiptVisualId,
  }),
  ownerPersonId: Model.Field({
    select: NonEmpty,
    insert: NonEmpty,
    json: NonEmpty,
  }),
  departmentId: Model.Field({
    select: NonEmpty,
    insert: NonEmpty,
    json: NonEmpty,
  }),
  amountOre: PositiveOre,
  currency: Model.Field({
    select: Schema.Literal("NOK"),
    insert: Schema.Literal("NOK"),
    json: Schema.Literal("NOK"),
  }),
  description: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5000))),
  receiptDate: IsoDate,
  submittedAt: Model.Field({
    select: IsoInstant,
    insert: IsoInstant,
    json: IsoInstant,
  }),
  status: Model.Field({
    select: ReceiptStatusSchema,
    insert: ReceiptStatusSchema,
    update: ReceiptStatusSchema,
    json: ReceiptStatusSchema,
  }),
  refundDate: Model.Field({
    select: Schema.NullOr(IsoInstant),
    insert: Schema.NullOr(IsoInstant),
    update: Schema.NullOr(IsoInstant),
    json: Schema.NullOr(IsoInstant),
  }),
  paymentAccountCiphertext: Model.Field({
    select: NonEmpty,
    insert: NonEmpty,
  }),
  file: Model.Sensitive(ReceiptFileSchema),
  revision: Model.Field({
    select: Revision,
    insert: Revision,
    update: Revision,
    json: Revision,
  }),
}) {}

export const ReceiptObservationSchema = Schema.Struct({
  commandId: NonEmpty,
  receiptId: ReceiptId,
  visualId: ReceiptVisualId,
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
