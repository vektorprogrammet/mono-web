import { Context, Effect, Layer, Schema } from "effect";
import { canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import type { ReceiptOutboxRequest } from "./effects.js";

export type ReceiptAuxiliaryRequest = Exclude<
  ReceiptOutboxRequest,
  { readonly _tag: "PromoteReceiptFile" | "DeleteReceiptFile" }
>;

export class ReceiptAuxiliaryEffectConflict extends Schema.TaggedError<ReceiptAuxiliaryEffectConflict>()(
  "ReceiptAuxiliaryEffectConflict",
  { effectId: Schema.String },
) {}

export interface ReceiptAuxiliaryEffectsShape {
  readonly apply: (
    request: ReceiptAuxiliaryRequest,
  ) => Effect.Effect<void, ReceiptAuxiliaryEffectConflict>;
}

export class ReceiptAuxiliaryEffects extends Context.Service<
  ReceiptAuxiliaryEffects,
  ReceiptAuxiliaryEffectsShape
>()("@vektorprogrammet/domain/ReceiptAuxiliaryEffects") {}

export interface ReceiptAuxiliaryRecordingControl {
  readonly layer: Layer.Layer<ReceiptAuxiliaryEffects>;
  readonly appliedEffectIds: Effect.Effect<ReadonlyArray<string>>;
}

export const makeReceiptAuxiliaryRecording = (): ReceiptAuxiliaryRecordingControl => {
  const applied = new Map<string, string>();
  return {
    layer: Layer.succeed(ReceiptAuxiliaryEffects)({
      apply: (request) => {
        const digest = sha256Hex(canonicalJsonBytes(request));
        const previous = applied.get(request.effectId);
        if (previous !== undefined && previous !== digest) {
          return Effect.fail(new ReceiptAuxiliaryEffectConflict({ effectId: request.effectId }));
        }
        return Effect.sync(() => void applied.set(request.effectId, digest));
      },
    }),
    appliedEffectIds: Effect.sync(() => [...applied.keys()].toSorted()),
  };
};
