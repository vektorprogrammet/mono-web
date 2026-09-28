import { Predicate, Schema } from "effect";
import { dual } from "effect/Function";
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

type ReceiptFileEffectType = "PromoteReceiptFile" | "DeleteReceiptFile";

type ReceiptNoticeEffectType = Exclude<ReceiptOutboxEffectType, ReceiptFileEffectType>;

/** A file effect names its file; every other effect names none. */
/** The outbox request of one effect type. */
type ReceiptOutboxRequestFor<Tag extends ReceiptOutboxRequest["_tag"]> = Extract<
  ReceiptOutboxRequest,
  { readonly _tag: Tag }
>;

export const receiptOutboxRequest: {
  <Tag extends ReceiptFileEffectType>(
    commandId: string,
    receiptId: string,
    effectType: Tag,
    file: ReceiptFile,
  ): ReceiptOutboxRequestFor<Tag>;
  <Tag extends ReceiptNoticeEffectType>(
    commandId: string,
    receiptId: string,
    effectType: Tag,
  ): ReceiptOutboxRequestFor<Tag>;
  <Tag extends ReceiptFileEffectType>(
    receiptId: string,
    effectType: Tag,
    file: ReceiptFile,
  ): (commandId: string) => ReceiptOutboxRequestFor<Tag>;
  <Tag extends ReceiptNoticeEffectType>(
    receiptId: string,
    effectType: Tag,
  ): (commandId: string) => ReceiptOutboxRequestFor<Tag>;
} = dual(
  // A data-first call names the command, the receipt, and the effect; its third argument is a string.
  (args) => args.length >= 4 || (args.length === 3 && Predicate.isString(args[2])),
  (
    commandId: string,
    receiptId: string,
    ...request: [effectType: ReceiptFileEffectType, file: ReceiptFile] | [ReceiptNoticeEffectType]
  ): ReceiptOutboxRequest => {
    const base = { effectId: `${commandId}:${request[0]}`, receiptId, commandId };

    return request.length === 2
      ? ReceiptOutboxRequestSchema.cases[request[0]].make({ ...base, file: request[1] })
      : ReceiptOutboxRequestSchema.cases[request[0]].make(base);
  },
);

export const sameReceiptFile: {
  (right: ReceiptFile): (left: ReceiptFile) => boolean;
  (left: ReceiptFile, right: ReceiptFile): boolean;
} = dual(
  2,
  (left: ReceiptFile, right: ReceiptFile): boolean =>
    left.fileRef === right.fileRef &&
    left.objectKey === right.objectKey &&
    left.contentType === right.contentType &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256,
);
