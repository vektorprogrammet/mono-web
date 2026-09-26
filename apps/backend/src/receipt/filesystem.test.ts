import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Result } from "effect";
import {
  receiptOutboxRequest,
  ReceiptFileEffectConflict,
  ReceiptFileInjectedFailure,
} from "@vektorprogrammet/domain/receipt";
import { TestPlatform } from "../test/platform.js";
import { makeReceiptFileStore } from "./filesystem.js";

const privateRoots = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix });

    return { stagingRoot: path.join(root, "staging"), committedRoot: path.join(root, "private") };
  });

const permissions = (target: string) =>
  FileSystem.FileSystem.use((fs) => fs.stat(target)).pipe(Effect.map(({ mode }) => mode & 0o777));

layer(TestPlatform, { excludeTestServices: true })("private receipt file custody", (it) => {
  it.effect(
    "preserves file-effect identity across restart and retries an interrupted reservation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* privateRoots("receipt-custody-");
        const commandId = "restart-command";
        const effectId = commandId + ":PromoteReceiptFile";

        const first = yield* makeReceiptFileStore({
          ...config,
          failNextPromotionEffectId: effectId,
        });

        const bytes = new Uint8Array([0, 255, 1, 17]);

        const staged = yield* first.stageBytes(
          new File([bytes], "receipt.png"),
          commandId,
          "image/png",
          1024,
        );

        expect(yield* permissions(config.stagingRoot)).toBe(0o700);
        expect(yield* permissions(path.join(config.stagingRoot, staged.file.fileRef))).toBe(0o600);

        const request = receiptOutboxRequest(
          commandId,
          "receipt-one",
          "PromoteReceiptFile",
          staged.file,
        );

        expect(yield* Effect.flip(first.service.apply(request))).toBeInstanceOf(
          ReceiptFileInjectedFailure,
        );

        const restarted = yield* makeReceiptFileStore(config);
        yield* restarted.service.apply(request);
        // SAFETY: reversing entries preserves every key and value of the validated request.
        const reordered = Object.fromEntries(Object.entries(request).reverse()) as typeof request;
        yield* restarted.service.apply(reordered);
        expect(yield* restarted.readCommitted(staged.file, 1024)).toEqual(Buffer.from(bytes));
        expect(yield* permissions(config.committedRoot)).toBe(0o700);

        expect(yield* permissions(path.join(config.committedRoot, staged.file.objectKey))).toBe(
          0o600,
        );

        const conflicting = yield* makeReceiptFileStore(config);

        expect(
          yield* Effect.flip(
            conflicting.service.apply({ ...request, receiptId: "different-receipt" }),
          ),
        ).toBeInstanceOf(ReceiptFileEffectConflict);

        const markers = yield* fs.readDirectory(path.join(config.committedRoot, ".effects"));
        expect(markers).toHaveLength(1);

        expect(yield* permissions(path.join(config.committedRoot, ".effects", markers[0]!))).toBe(
          0o600,
        );
      }),
  );

  it.effect("reserves one identity when conflicting callers overlap", () =>
    Effect.gen(function* () {
      const config = yield* privateRoots("receipt-custody-race-");
      const store = yield* makeReceiptFileStore(config);
      const other = yield* makeReceiptFileStore(config);

      const staged = yield* store.stageBytes(
        new File([new Uint8Array([1])], "receipt.png"),
        "race",
        "image/png",
        1024,
      );

      const request = receiptOutboxRequest("race", "receipt-a", "PromoteReceiptFile", staged.file);

      const results = yield* Effect.all(
        [
          Effect.result(store.service.apply(request)),
          Effect.result(other.service.apply({ ...request, receiptId: "receipt-b" })),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(results.find(Result.isFailure)?.failure).toBeInstanceOf(ReceiptFileEffectConflict);
    }),
  );
});
