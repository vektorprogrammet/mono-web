import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeReceiptOutboxRequest, type ReceiptOutboxRequest } from "./effects.js";
import { makeReceiptFileRecording, ReceiptFileService } from "./file-service.js";
import type { ReceiptFile } from "./schema.js";

const original: ReceiptFile = {
  fileRef: "staged/original",
  objectKey: "receipts/original",
  contentType: "application/pdf",
  byteLength: 128,
  sha256: "a".repeat(64),
};

const replacement: ReceiptFile = {
  fileRef: "staged/replacement",
  objectKey: "receipts/replacement",
  contentType: "image/png",
  byteLength: 256,
  sha256: "b".repeat(64),
};

const fileRequest = (
  commandId: string,
  effectType: "PromoteReceiptFile" | "DeleteReceiptFile",
  file: ReceiptFile,
) =>
  makeReceiptOutboxRequest(commandId, "receipt-1", effectType, file) as Extract<
    ReceiptOutboxRequest,
    { readonly _tag: "PromoteReceiptFile" | "DeleteReceiptFile" }
  >;

it.effect("promotes before exact deletion and replays file effects idempotently", () => {
  const recording = makeReceiptFileRecording();
  return Effect.gen(function* () {
    const service = yield* ReceiptFileService;
    yield* service.stage(original);
    yield* service.stage(replacement);

    const promoteOriginal = fileRequest("submit", "PromoteReceiptFile", original);
    yield* service.apply(promoteOriginal);
    yield* service.apply(promoteOriginal);

    const promoteReplacement = fileRequest("revise", "PromoteReceiptFile", replacement);
    yield* recording.failNext(promoteReplacement.effectId);
    const injected = yield* Effect.exit(service.apply(promoteReplacement));
    expect(injected._tag).toBe("Failure");
    expect((yield* recording.snapshot).current).toEqual([original]);

    yield* service.apply(promoteReplacement);
    const deleteOriginal = fileRequest("revise", "DeleteReceiptFile", original);
    yield* service.apply(deleteOriginal);
    yield* service.apply(deleteOriginal);

    const snapshot = yield* recording.snapshot;
    expect(snapshot.current).toEqual([replacement]);
    expect(snapshot.deleted).toEqual([original]);
    expect(snapshot.events.map((event) => event.action)).toEqual([
      "Promoted",
      "Promoted",
      "Deleted",
    ]);
  }).pipe(Effect.provide(recording.layer));
});

it.effect("fails closed when one effect id names different file identities", () => {
  const recording = makeReceiptFileRecording();
  return Effect.gen(function* () {
    const service = yield* ReceiptFileService;
    yield* service.stage(original);
    yield* service.stage(replacement);
    yield* service.apply(fileRequest("same-command", "PromoteReceiptFile", original));

    const conflict = yield* Effect.exit(
      service.apply(fileRequest("same-command", "PromoteReceiptFile", replacement)),
    );
    expect(conflict._tag).toBe("Failure");
    expect((yield* recording.snapshot).current).toEqual([original]);
  }).pipe(Effect.provide(recording.layer));
});
