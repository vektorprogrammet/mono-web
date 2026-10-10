import { expect, layer } from "@effect/vitest";
import { Crypto, Effect, FileSystem, Path, PlatformError, Result } from "effect";
import {
  receiptOutboxRequest,
  ReceiptFileEffectConflict,
  ReceiptFileInjectedFailure,
} from "@vektorprogrammet/domain/receipt";
import { TestPlatform } from "../test/platform.js";
import { makeReceiptFileStore, ReceiptFileStoreError } from "./filesystem.js";

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

const abcDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const digestFailure = PlatformError.badArgument({
  module: "Crypto",
  method: "digest",
  description: "injected digest failure",
});

// Fixed entropy names the temporary files; the digest delegates to the platform unless it fails.
const fixedCrypto = (digestFails: boolean) =>
  Effect.gen(function* () {
    const platform = yield* Crypto.Crypto;

    return Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill(7),
      digest: (algorithm, data) =>
        digestFails ? Effect.fail(digestFailure) : platform.digest(algorithm, data),
    });
  });

layer(TestPlatform, { excludeTestServices: true })("receipt file custody crypto", (it) => {
  it.effect("pins the SHA-256 identity of staged bytes and of the command", () =>
    Effect.gen(function* () {
      const config = yield* privateRoots("receipt-custody-digest-");
      const store = yield* makeReceiptFileStore(config);

      const staged = yield* store.stageBytes(
        new File([new TextEncoder().encode("abc")], "receipt.png"),
        "abc",
        "image/png",
        1024,
      );

      // sha256("abc") is the FIPS 180-4 known answer; the first 32 digits name the command.
      expect(staged.file.sha256).toBe(abcDigest);
      expect(staged.file.fileRef).toBe(`staging/${abcDigest.slice(0, 32)}-${abcDigest}-png`);
    }),
  );

  it.effect("names temporary files from the captured Crypto service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* privateRoots("receipt-custody-entropy-");
      const crypto = yield* fixedCrypto(false);

      const store = yield* makeReceiptFileStore(config).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );

      const uuid = "07070707-0707-4707-8707-070707070707";
      // Hold the temporary name, so a staging attempt under this entropy cannot create it.
      yield* fs.makeDirectory(config.stagingRoot, { recursive: true });
      yield* fs.writeFileString(path.join(config.stagingRoot, `.incoming-${uuid}.part`), "taken");

      const failure = yield* Effect.flip(
        store.stageBytes(
          new File([new Uint8Array([1])], "receipt.png"),
          "named",
          "image/png",
          1024,
        ),
      );

      expect(failure).toBeInstanceOf(ReceiptFileStoreError);
    }),
  );

  it.effect("fails a staging digest as a typed store error and leaves no staged file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* privateRoots("receipt-custody-digest-failure-");
      const crypto = yield* fixedCrypto(true);

      const store = yield* makeReceiptFileStore(config).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );

      const failure = yield* Effect.flip(
        store.stageBytes(
          new File([new Uint8Array([1])], "receipt.png"),
          "failing",
          "image/png",
          1024,
        ),
      );

      expect(failure).toBeInstanceOf(ReceiptFileStoreError);
      expect(failure).toMatchObject({ operation: "stageBytes" });
      // The command digest comes first: a failing platform digest creates nothing at all.
      expect(yield* fs.exists(config.stagingRoot)).toBe(false);
    }),
  );

  it.effect("reports a committed read whose digest fails as a typed store error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* privateRoots("receipt-custody-read-");
      const platformStore = yield* makeReceiptFileStore(config);

      const staged = yield* platformStore.stageBytes(
        new File([new Uint8Array([4, 5])], "receipt.png"),
        "readable",
        "image/png",
        1024,
      );

      yield* fs.makeDirectory(
        path.dirname(path.join(config.committedRoot, staged.file.objectKey)),
        {
          recursive: true,
        },
      );

      yield* fs.copyFile(
        path.join(config.stagingRoot, staged.file.fileRef),
        path.join(config.committedRoot, staged.file.objectKey),
      );

      const crypto = yield* fixedCrypto(true);

      const failing = yield* makeReceiptFileStore(config).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );

      expect(yield* platformStore.readCommitted(staged.file, 1024)).toEqual(Buffer.from([4, 5]));
      const failure = yield* Effect.flip(failing.readCommitted(staged.file, 1024));

      expect(failure).toBeInstanceOf(ReceiptFileStoreError);
      expect(failure).toMatchObject({ operation: "readCommitted" });
    }),
  );
});
