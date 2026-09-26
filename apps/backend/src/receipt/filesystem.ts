import { createHash, randomUUID } from "node:crypto";
import {
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Match,
  Path,
  PlatformError,
  Predicate,
  Stream,
} from "effect";
import {
  ReceiptDecodeError,
  receiptEvidenceDigest,
  ReceiptFileEffectConflict,
  ReceiptFileIdentityConflict,
  ReceiptFileInjectedFailure,
  ReceiptFileNotStaged,
  ReceiptFileService,
  type ReceiptFile,
  type ReceiptFileRequest,
  type ReceiptFileServiceOperations,
} from "@vektorprogrammet/domain/receipt";

export interface ReceiptFileStoreConfig {
  readonly stagingRoot: string;
  readonly committedRoot: string;
  readonly failNextPromotionEffectId?: string;
}

export interface StagedReceiptFile {
  readonly file: ReceiptFile;
  readonly created: boolean;
}

/** A private file operation that did not complete; each caller maps it to its own outcome. */
export class ReceiptFileStoreError extends Data.TaggedError("ReceiptFileStoreError")<{
  readonly operation: "readCommitted" | "stageBytes" | "cleanupStage";
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface FileDigest {
  readonly byteLength: number;
  readonly sha256: string;
}

type ExistingFile = "missing" | "matching" | "different";

const encoder = new TextEncoder();

const mediaKey = (contentType: ReceiptFile["contentType"]): string =>
  Match.value(contentType).pipe(
    Match.when("application/pdf", () => "pdf" as const),
    Match.when("image/png", () => "png" as const),
    Match.orElse(() => "jpeg" as const),
  );

const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const fileIdentity = (
  commandId: string,
  contentType: ReceiptFile["contentType"],
  digest: FileDigest,
): ReceiptFile => {
  const suffix = `${sha256Hex(commandId).slice(0, 32)}-${digest.sha256}-${mediaKey(contentType)}`;

  return {
    fileRef: `staging/${suffix}`,
    objectKey: `committed/${suffix}`,
    contentType,
    byteLength: digest.byteLength,
    sha256: digest.sha256,
  };
};

const fileFailure = (effectId: string, fileRef: string): ReceiptFileNotStaged =>
  new ReceiptFileNotStaged({ effectId, fileRef });

const failedOperation =
  (operation: ReceiptFileStoreError["operation"]) => (cause: PlatformError.PlatformError) =>
    Effect.fail(
      new ReceiptFileStoreError({
        operation,
        message: "private file system operation failed",
        cause,
      }),
    );

export interface ReceiptFileStore {
  readonly service: ReceiptFileServiceOperations;
  readonly readCommitted: (
    file: ReceiptFile,
    maxFileBytes: number,
  ) => Effect.Effect<Uint8Array, ReceiptFileStoreError>;
  readonly layer: Layer.Layer<ReceiptFileService>;
  readonly stageBytes: (
    file: File,
    commandId: string,
    contentType: ReceiptFile["contentType"],
    maxFileBytes: number,
  ) => Effect.Effect<StagedReceiptFile, ReceiptDecodeError | ReceiptFileStoreError>;
  readonly cleanupStage: (file: ReceiptFile) => Effect.Effect<void, ReceiptFileStoreError>;
}

export class ReceiptFileStoreResource extends Context.Service<
  ReceiptFileStoreResource,
  ReceiptFileStore
>()("@vektorprogrammet/backend/ReceiptFileStore") {}

/** Private receipt files under two local roots, through the platform FileSystem and Path. */
export const makeReceiptFileStore = (config: ReceiptFileStoreConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let failNextPromotionEffectId = config.failNextPromotionEffectId;

    const pathFor = (root: string, key: string) => {
      const segments = key.split("/");

      return segments.length < 2 ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ? Effect.fail(
            PlatformError.badArgument({
              module: "ReceiptFileStore",
              method: "pathFor",
              description: "unsafe receipt file identity",
            }),
          )
        : Effect.succeed(path.join(root, ...segments));
    };

    // Reads at most one byte past the expected length: a longer file is already different.
    const inspectFile = (filePath: string, file: ReceiptFile) =>
      fs.stream(filePath, { bytesToRead: file.byteLength + 1 }).pipe(
        Stream.runFold(
          () => ({ hash: createHash("sha256"), byteLength: 0 }),
          (digest, chunk) => ({
            hash: digest.hash.update(chunk),
            byteLength: digest.byteLength + chunk.byteLength,
          }),
        ),
        Effect.map(
          ({ hash, byteLength }): ExistingFile =>
            byteLength === file.byteLength && hash.digest("hex") === file.sha256
              ? "matching"
              : "different",
        ),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed<ExistingFile>("missing"),
        ),
      );

    // `force` ignores only a missing path.
    const removeIfPresent = (filePath: string) => fs.remove(filePath, { force: true });

    const readMarker = (target: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* fs.open(target, { flag: "r" });
          const bytes = Buffer.alloc(65);
          const bytesRead = yield* marker.read(bytes);

          return bytesRead === 64 ? bytes.subarray(0, bytesRead).toString("ascii") : undefined;
        }),
      );

    // One durable marker per effect id: the first writer's digest wins, a replay of the same
    // request passes, and a different request under the same id conflicts.
    const reserveEffect = (effectId: string, digest: string) =>
      Effect.gen(function* () {
        const directory = path.join(config.committedRoot, ".effects");
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const target = path.join(directory, sha256Hex(effectId));
        const temporary = path.join(directory, `.incoming-${randomUUID()}`);

        const recorded = yield* Effect.scoped(
          Effect.acquireUseRelease(
            fs.open(temporary, { flag: "wx", mode: 0o600 }),
            (handle) =>
              Effect.gen(function* () {
                yield* handle.writeAll(encoder.encode(digest));
                yield* handle.sync;
                yield* fs
                  .link(temporary, target)
                  .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));

                return yield* readMarker(target);
              }),
            () => removeIfPresent(temporary),
          ),
        );

        if (recorded !== digest) return yield* new ReceiptFileEffectConflict({ effectId });
      });

    // Streams the upload into the open temporary file; bytes past the limit fail validation.
    const writeUpload = (handle: FileSystem.File, upload: File, maxFileBytes: number) =>
      Effect.acquireUseRelease(
        Effect.sync(() => upload.stream().getReader()),
        (reader) =>
          Effect.gen(function* () {
            const hash = createHash("sha256");
            let byteLength = 0;

            for (;;) {
              const chunk = yield* Effect.tryPromise({
                try: () => reader.read(),
                catch: (cause) =>
                  new ReceiptFileStoreError({
                    operation: "stageBytes",
                    message: "receipt upload unreadable",
                    cause,
                  }),
              });

              if (chunk.done) break;
              byteLength += chunk.value.byteLength;

              if (byteLength > maxFileBytes) {
                return yield* new ReceiptDecodeError({
                  message: "receipt file exceeds configured limit",
                });
              }

              hash.update(chunk.value);
              yield* handle.writeAll(chunk.value);
            }

            return { byteLength, sha256: hash.digest("hex") };
          }),
        (reader) =>
          Effect.tryPromise({
            try: () => reader.cancel(),
            catch: (cause) =>
              new ReceiptFileStoreError({
                operation: "stageBytes",
                message: "receipt upload unreadable",
                cause,
              }),
          }).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock()))),
      );

    const placeStagedFile = (temporaryPath: string, identity: ReceiptFile) =>
      Effect.gen(function* () {
        const targetPath = yield* pathFor(config.stagingRoot, identity.fileRef);
        yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        const existing = yield* inspectFile(targetPath, identity);

        if (existing === "matching") {
          yield* removeIfPresent(temporaryPath);

          return { file: identity, created: false };
        }

        if (existing === "different") {
          yield* removeIfPresent(temporaryPath);

          return yield* new ReceiptFileStoreError({
            operation: "stageBytes",
            message: "receipt staging identity conflict",
          });
        }

        yield* fs.rename(temporaryPath, targetPath);

        return { file: identity, created: true };
      });

    const stageBytes = (
      upload: File,
      commandId: string,
      contentType: ReceiptFile["contentType"],
      maxFileBytes: number,
    ) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(config.stagingRoot, { recursive: true, mode: 0o700 });
        const temporaryPath = path.join(config.stagingRoot, `.incoming-${randomUUID()}.part`);
        const removeTemporary = removeIfPresent(temporaryPath).pipe(Effect.ignore);

        // The handle closes after the fsync, before the file is placed.
        const digest = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });

            return yield* writeUpload(handle, upload, maxFileBytes).pipe(
              Effect.tap(() => handle.sync),
              Effect.onError(() => removeTemporary),
            );
          }),
        );

        return yield* placeStagedFile(
          temporaryPath,
          fileIdentity(commandId, contentType, digest),
        ).pipe(Effect.onError(() => removeTemporary));
      }).pipe(Effect.catchTag("PlatformError", failedOperation("stageBytes")));

    // A rename across devices falls back to a copy and removal of the staged file.
    const promote = (stagingPath: string, committedPath: string) =>
      fs
        .rename(stagingPath, committedPath)
        .pipe(
          Effect.catchReason("PlatformError", "Unknown", (reason, error) =>
            Predicate.hasProperty(reason.cause, "code") && reason.cause.code === "EXDEV"
              ? fs
                  .copyFile(stagingPath, committedPath)
                  .pipe(Effect.andThen(removeIfPresent(stagingPath)))
              : Effect.fail(error),
          ),
        );

    const service: ReceiptFileServiceOperations = {
      stage: (file) =>
        Effect.gen(function* () {
          const stagingPath = yield* pathFor(config.stagingRoot, file.fileRef);
          const committedPath = yield* pathFor(config.committedRoot, file.objectKey);
          const staged = yield* inspectFile(stagingPath, file);

          if (staged === "matching") return;

          if (staged === "different") {
            return yield* new ReceiptFileIdentityConflict({
              effectId: "stage",
              objectKey: file.objectKey,
            });
          }

          const committed = yield* inspectFile(committedPath, file);

          if (committed === "matching") return;

          if (committed === "different") {
            return yield* new ReceiptFileIdentityConflict({
              effectId: "stage",
              objectKey: file.objectKey,
            });
          }

          return yield* fileFailure("stage", file.fileRef);
        }).pipe(
          Effect.catchTag("PlatformError", () => Effect.fail(fileFailure("stage", file.fileRef))),
        ),
      apply: (request: ReceiptFileRequest) =>
        Effect.gen(function* () {
          yield* reserveEffect(request.effectId, receiptEvidenceDigest(request));
          const promotion = Predicate.isTagged(request, "PromoteReceiptFile");

          if (promotion && failNextPromotionEffectId === request.effectId) {
            failNextPromotionEffectId = undefined;

            return yield* new ReceiptFileInjectedFailure({ effectId: request.effectId });
          }

          const stagingPath = yield* pathFor(config.stagingRoot, request.file.fileRef);
          const committedPath = yield* pathFor(config.committedRoot, request.file.objectKey);
          const committed = yield* inspectFile(committedPath, request.file);

          if (committed === "different") {
            return yield* new ReceiptFileIdentityConflict({
              effectId: request.effectId,
              objectKey: request.file.objectKey,
            });
          }

          if (!promotion) {
            if (committed === "matching") yield* removeIfPresent(committedPath);

            return;
          }

          if (committed === "matching") return yield* removeIfPresent(stagingPath);
          const staged = yield* inspectFile(stagingPath, request.file);

          if (staged !== "matching") {
            return yield* fileFailure(request.effectId, request.file.fileRef);
          }

          yield* fs.makeDirectory(path.dirname(committedPath), { recursive: true, mode: 0o700 });
          yield* promote(stagingPath, committedPath);
        }).pipe(
          Effect.catchTag("PlatformError", () =>
            Effect.fail(fileFailure(request.effectId, request.file.fileRef)),
          ),
        ),
    };

    const readCommitted = (file: ReceiptFile, maxFileBytes: number) =>
      Effect.gen(function* () {
        const mismatch = new ReceiptFileStoreError({
          operation: "readCommitted",
          message: "receipt file mismatch",
        });

        if (file.byteLength > maxFileBytes) {
          return yield* new ReceiptFileStoreError({
            operation: "readCommitted",
            message: "receipt file exceeds configured limit",
          });
        }

        const root = yield* fs.realPath(config.committedRoot);
        const resolved = yield* fs.realPath(yield* pathFor(root, file.objectKey));
        const inside = path.relative(root, resolved);

        if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
          return yield* new ReceiptFileStoreError({
            operation: "readCommitted",
            message: "unsafe receipt file identity",
          });
        }

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs.open(resolved, { flag: "r" });
            const before = yield* handle.stat;

            if (
              before.type !== "File" ||
              before.size !== BigInt(file.byteLength) ||
              before.size > BigInt(maxFileBytes)
            )
              return yield* mismatch;
            const bytes = Buffer.alloc(file.byteLength);
            let offset = 0;

            while (offset < bytes.length) {
              const bytesRead = yield* handle.read(bytes.subarray(offset));

              if (bytesRead === 0) break;
              offset += bytesRead;
            }

            const after = yield* handle.stat;

            if (
              offset !== file.byteLength ||
              after.size !== BigInt(file.byteLength) ||
              sha256Hex(bytes) !== file.sha256
            )
              return yield* mismatch;

            return bytes;
          }),
        );
      }).pipe(Effect.catchTag("PlatformError", failedOperation("readCommitted")));

    const cleanupStage = (file: ReceiptFile) =>
      pathFor(config.stagingRoot, file.fileRef).pipe(
        Effect.flatMap(removeIfPresent),
        Effect.catchTag("PlatformError", failedOperation("cleanupStage")),
      );

    const store: ReceiptFileStore = {
      service,
      readCommitted,
      layer: Layer.succeed(ReceiptFileService)(service),
      stageBytes,
      cleanupStage,
    };

    return store;
  });

export const ReceiptFileStoreLive = (config: ReceiptFileStoreConfig) =>
  Layer.unwrap(
    Effect.map(makeReceiptFileStore(config), (store) =>
      Layer.merge(Layer.succeed(ReceiptFileStoreResource, store), store.layer),
    ),
  );
