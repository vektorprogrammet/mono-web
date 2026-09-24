import { Match, Schema } from "effect";
import { ReceiptFileSchema, type ReceiptFile } from "./schema.js";

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const EffectBase = {
  effectId: NonEmpty,
  receiptId: NonEmpty,
  commandId: NonEmpty,
};

export const ReceiptOutboxRequestSchema = Schema.TaggedUnion({
  PromoteReceiptFile: {
    ...EffectBase,
    file: ReceiptFileSchema,
  },
  DeleteReceiptFile: {
    ...EffectBase,
    file: ReceiptFileSchema,
  },
  NotifyEconomyReceiptSubmitted: EffectBase,
  NotifyReceiptApproved: EffectBase,
  NotifyReceiptRejected: EffectBase,
  NotifyReceiptSettled: EffectBase,
  WriteReceiptAudit: EffectBase,
});

export type ReceiptOutboxRequest = typeof ReceiptOutboxRequestSchema.Type;

export type ReceiptOutboxEffectType = ReceiptOutboxRequest["_tag"];

export const receiptOutboxRequest = (
  commandId: string,
  receiptId: string,
  effectType: ReceiptOutboxEffectType,
  file?: ReceiptFile,
): ReceiptOutboxRequest => {
  const base = { effectId: `${commandId}:${effectType}`, receiptId, commandId };

  return Match.value(effectType).pipe(
    Match.whenOr("PromoteReceiptFile", "DeleteReceiptFile", (type) => {
      if (file === undefined) throw new Error(`${type} requires a file identity`);

      return ReceiptOutboxRequestSchema.cases[type].make({ ...base, file });
    }),
    Match.orElse((type) => ReceiptOutboxRequestSchema.cases[type].make(base)),
  );
};

export const sameReceiptFile = (left: ReceiptFile, right: ReceiptFile): boolean =>
  left.fileRef === right.fileRef &&
  left.objectKey === right.objectKey &&
  left.contentType === right.contentType &&
  left.byteLength === right.byteLength &&
  left.sha256 === right.sha256;
