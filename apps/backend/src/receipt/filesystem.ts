import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, unlink, realpath, link } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { Context, Match, Predicate, Effect, Layer } from "effect";
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

interface FileDigest {
  readonly byteLength: number;
  readonly sha256: string;
}

type ExistingFile = "missing" | "matching" | "different";

const mediaKey = (contentType: ReceiptFile["contentType"]): string =>
  Match.value(contentType).pipe(
    Match.when("application/pdf", () => "pdf" as const),
    Match.when("image/png", () => "png" as const),
    Match.orElse(() => "jpeg" as const),
  );

const commandKey = (commandId: string): string => {
  const hash = createHash("sha256");
  hash.update(commandId);

  return hash.digest("hex").slice(0, 32);
};

const pathFor = (root: string, key: string): string => {
  const segments = key.split("/");

  if (
    segments.length < 2 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("unsafe receipt file identity");
  }

  return join(root, ...segments);
};

const digestPath = async (filePath: string, maxBytes: number): Promise<FileDigest> => {
  const hash = createHash("sha256");
  let byteLength = 0;

  for await (const chunk of createReadStream(filePath)) {
    const bytes = Predicate.isString(chunk) ? Buffer.from(chunk) : chunk;
    byteLength += bytes.byteLength;

    if (byteLength > maxBytes) break;
    hash.update(bytes);
  }

  return { byteLength, sha256: hash.digest("hex") };
};

const inspectFile = async (filePath: string, file: ReceiptFile): Promise<ExistingFile> => {
  try {
    const digest = await digestPath(filePath, file.byteLength);

    return digest.byteLength === file.byteLength && digest.sha256 === file.sha256
      ? "matching"
      : "different";
  } catch (cause) {
    if (
      cause !== null &&
      (cause === null || Predicate.isObjectOrArray(cause)) &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return "missing";
    }

    throw cause;
  }
};

const removeIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (cause) {
    if (
      cause !== null &&
      (cause === null || Predicate.isObjectOrArray(cause)) &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return;
    }

    throw cause;
  }
};

const fileIdentity = (
  commandId: string,
  contentType: ReceiptFile["contentType"],
  digest: FileDigest,
): ReceiptFile => {
  const suffix = `${commandKey(commandId)}-${digest.sha256}-${mediaKey(contentType)}`;

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

export interface ReceiptFileStore {
  readonly service: ReceiptFileServiceOperations;
  readonly readCommitted: (file: ReceiptFile, maxFileBytes: number) => Promise<Uint8Array>;
  readonly layer: Layer.Layer<ReceiptFileService>;
  readonly stageBytes: (
    file: File,
    commandId: string,
    contentType: ReceiptFile["contentType"],
    maxFileBytes: number,
  ) => Promise<StagedReceiptFile>;
  readonly cleanupStage: (file: ReceiptFile) => Promise<void>;
}

export class ReceiptFileStoreResource extends Context.Service<
  ReceiptFileStoreResource,
  ReceiptFileStore
>()("@vektorprogrammet/backend/ReceiptFileStore") {}

export const ReceiptFileStoreLive = (config: ReceiptFileStoreConfig) =>
  Layer.unwrap(
    Effect.sync(() => {
      const store = makeReceiptFileStore(config);

      return Layer.merge(Layer.succeed(ReceiptFileStoreResource, store), store.layer);
    }),
  );

export const makeReceiptFileStore = (config: ReceiptFileStoreConfig): ReceiptFileStore => {
  let failNextPromotionEffectId = config.failNextPromotionEffectId;

  const reserveEffect = async (effectId: string, digest: string): Promise<void> => {
    const directory = join(config.committedRoot, ".effects");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(effectId).digest("hex");
    const target = join(directory, key);
    const temporary = join(directory, `.incoming-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);

    try {
      await handle.writeFile(digest);
      await handle.sync();
      await handle.close();

      try {
        await link(temporary, target);
      } catch (cause) {
        if (!(Predicate.isObject(cause) && "code" in cause && cause.code === "EEXIST")) throw cause;
      }

      const marker = await open(target, "r");

      try {
        const bytes = Buffer.alloc(65);
        const { bytesRead } = await marker.read(bytes, 0, bytes.length, 0);

        if (bytesRead !== 64 || bytes.subarray(0, bytesRead).toString("ascii") !== digest)
          throw new ReceiptFileEffectConflict({ effectId });
      } finally {
        await marker.close();
      }
    } finally {
      await handle.close();
      await removeIfPresent(temporary);
    }
  };

  const stageBytes = async (
    file: File,
    commandId: string,
    contentType: ReceiptFile["contentType"],
    maxFileBytes: number,
  ): Promise<StagedReceiptFile> => {
    await mkdir(config.stagingRoot, { recursive: true, mode: 0o700 });
    const temporaryPath = join(config.stagingRoot, `.incoming-${randomUUID()}.part`);
    const handle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;

    try {
      const reader = file.stream().getReader();

      try {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) break;
          byteLength += chunk.value.byteLength;

          if (byteLength > maxFileBytes) {
            throw new ReceiptDecodeError({ message: "receipt file exceeds configured limit" });
          }

          hash.update(chunk.value);
          await handle.writeFile(chunk.value);
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }

      await handle.sync();
      await handle.close();

      const identity = fileIdentity(commandId, contentType, {
        byteLength,
        sha256: hash.digest("hex"),
      });

      const targetPath = pathFor(config.stagingRoot, identity.fileRef);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      const existing = await inspectFile(targetPath, identity);

      if (existing === "matching") {
        await removeIfPresent(temporaryPath);

        return { file: identity, created: false };
      }

      if (existing === "different") {
        await removeIfPresent(temporaryPath);
        throw new Error("receipt staging identity conflict");
      }

      await rename(temporaryPath, targetPath);

      return { file: identity, created: true };
    } catch (cause) {
      await handle.close().catch(() => undefined);
      await removeIfPresent(temporaryPath).catch(() => undefined);
      throw cause;
    }
  };

  const cleanupStage = async (file: ReceiptFile): Promise<void> => {
    await removeIfPresent(pathFor(config.stagingRoot, file.fileRef));
  };

  const service: ReceiptFileServiceOperations = {
    stage: (file) =>
      Effect.tryPromise({
        try: async () => {
          const stagingPath = pathFor(config.stagingRoot, file.fileRef);
          const committedPath = pathFor(config.committedRoot, file.objectKey);
          const staged = await inspectFile(stagingPath, file);

          if (staged === "matching") return;

          if (staged === "different") {
            throw new ReceiptFileIdentityConflict({ effectId: "stage", objectKey: file.objectKey });
          }

          const committed = await inspectFile(committedPath, file);

          if (committed === "matching") return;

          if (committed === "different") {
            throw new ReceiptFileIdentityConflict({ effectId: "stage", objectKey: file.objectKey });
          }

          throw fileFailure("stage", file.fileRef);
        },
        catch: (cause) =>
          cause instanceof ReceiptFileIdentityConflict
            ? cause
            : new ReceiptFileNotStaged({ effectId: "stage", fileRef: file.fileRef }),
      }),
    apply: (request: ReceiptFileRequest) =>
      Effect.tryPromise({
        try: async () => {
          const requestDigest = receiptEvidenceDigest(request);
          await reserveEffect(request.effectId, requestDigest);

          if (
            Predicate.isTagged(request, "PromoteReceiptFile") &&
            failNextPromotionEffectId === request.effectId
          ) {
            failNextPromotionEffectId = undefined;
            throw new ReceiptFileInjectedFailure({ effectId: request.effectId });
          }

          const stagingPath = pathFor(config.stagingRoot, request.file.fileRef);
          const committedPath = pathFor(config.committedRoot, request.file.objectKey);

          if (Predicate.isTagged(request, "PromoteReceiptFile")) {
            const committed = await inspectFile(committedPath, request.file);

            if (committed === "different") {
              throw new ReceiptFileIdentityConflict({
                effectId: request.effectId,
                objectKey: request.file.objectKey,
              });
            }

            if (committed === "matching") {
              await removeIfPresent(stagingPath);
            } else {
              const staged = await inspectFile(stagingPath, request.file);

              if (staged !== "matching") throw fileFailure(request.effectId, request.file.fileRef);
              await mkdir(dirname(committedPath), { recursive: true, mode: 0o700 });

              try {
                await rename(stagingPath, committedPath);
              } catch (cause) {
                if (
                  !(
                    cause !== null &&
                    (cause === null || Predicate.isObjectOrArray(cause)) &&
                    "code" in cause &&
                    cause.code === "EXDEV"
                  )
                ) {
                  throw cause;
                }

                await copyFile(stagingPath, committedPath);
                await removeIfPresent(stagingPath);
              }
            }
          } else {
            const committed = await inspectFile(committedPath, request.file);

            if (committed === "different") {
              throw new ReceiptFileIdentityConflict({
                effectId: request.effectId,
                objectKey: request.file.objectKey,
              });
            }

            if (committed === "matching") await removeIfPresent(committedPath);
          }
        },
        catch: (cause) => {
          if (
            cause instanceof ReceiptFileEffectConflict ||
            cause instanceof ReceiptFileIdentityConflict ||
            cause instanceof ReceiptFileInjectedFailure ||
            cause instanceof ReceiptFileNotStaged
          ) {
            return cause;
          }

          return new ReceiptFileNotStaged({
            effectId: request.effectId,
            fileRef: request.file.fileRef,
          });
        },
      }),
  };

  return {
    service,
    readCommitted: async (file, maxFileBytes) => {
      if (file.byteLength > maxFileBytes) throw new Error("receipt file exceeds configured limit");
      const root = await realpath(config.committedRoot);
      const path = await realpath(pathFor(root, file.objectKey));
      const inside = relative(root, path);

      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        throw new Error("unsafe receipt file identity");
      const handle = await open(path, "r");

      try {
        const stat = await handle.stat();

        if (!stat.isFile() || stat.size !== file.byteLength || stat.size > maxFileBytes)
          throw new Error("receipt file mismatch");
        const bytes = Buffer.alloc(file.byteLength);
        let offset = 0;

        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);

          if (bytesRead === 0) break;
          offset += bytesRead;
        }

        if (
          offset !== file.byteLength ||
          (await handle.stat()).size !== file.byteLength ||
          createHash("sha256").update(bytes).digest("hex") !== file.sha256
        )
          throw new Error("receipt file mismatch");

        return bytes;
      } finally {
        await handle.close();
      }
    },
    layer: Layer.succeed(ReceiptFileService)(service),
    stageBytes,
    cleanupStage,
  };
};
