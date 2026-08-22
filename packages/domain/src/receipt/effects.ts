import { Schema } from "effect";
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
  NotifyReceiptRefunded: EffectBase,
  NotifyReceiptRejected: EffectBase,
  WriteReceiptAudit: EffectBase,
});
export type ReceiptOutboxRequest = typeof ReceiptOutboxRequestSchema.Type;
export type ReceiptOutboxEffectType = ReceiptOutboxRequest["_tag"];

const fileEffectTypes = new Set<ReceiptOutboxEffectType>([
  "PromoteReceiptFile",
  "DeleteReceiptFile",
]);

export const makeReceiptOutboxRequest = (
  commandId: string,
  receiptId: string,
  effectType: ReceiptOutboxEffectType,
  file?: ReceiptFile,
): ReceiptOutboxRequest => {
  const base = {
    _tag: effectType,
    effectId: `${commandId}:${effectType}`,
    receiptId,
    commandId,
  } as const;

  if (fileEffectTypes.has(effectType)) {
    if (file === undefined) throw new Error(`${effectType} requires a file identity`);
    return { ...base, file } as ReceiptOutboxRequest;
  }
  return base as ReceiptOutboxRequest;
};

export const sameReceiptFile = (left: ReceiptFile, right: ReceiptFile): boolean =>
  left.fileRef === right.fileRef &&
  left.objectKey === right.objectKey &&
  left.contentType === right.contentType &&
  left.byteLength === right.byteLength &&
  left.sha256 === right.sha256;
