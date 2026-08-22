import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import {
  ReceiptFileEffectConflict,
  ReceiptFileIdentityConflict,
  ReceiptFileNotStaged,
  ReceiptFileService,
  type ReceiptFile,
  type ReceiptFileRequest,
  type ReceiptFileServiceShape,
} from "@vektorprogrammet/domain/receipt";

export interface ReceiptFileStoreConfig {
  readonly stagingRoot: string;
  readonly committedRoot: string;
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
  contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpeg";

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

const digestPath = async (filePath: string): Promise<FileDigest> => {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  return { byteLength, sha256: hash.digest("hex") };
};

const inspectFile = async (filePath: string, file: ReceiptFile): Promise<ExistingFile> => {
  try {
    const digest = await digestPath(filePath);
    return digest.byteLength === file.byteLength && digest.sha256 === file.sha256
      ? "matching"
      : "different";
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return "missing";
    }
    throw cause;
  }
};

const removeIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
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
  readonly service: ReceiptFileServiceShape;
  readonly layer: Layer.Layer<ReceiptFileService>;
  readonly stageBytes: (
    file: File,
    commandId: string,
    contentType: ReceiptFile["contentType"],
    maxFileBytes: number,
  ) => Promise<StagedReceiptFile>;
  readonly cleanupStage: (file: ReceiptFile) => Promise<void>;
}

export const makeReceiptFileStore = (config: ReceiptFileStoreConfig): ReceiptFileStore => {
  const applied = new Map<string, string>();

  const stageBytes = async (
    file: File,
    commandId: string,
    contentType: ReceiptFile["contentType"],
    maxFileBytes: number,
  ): Promise<StagedReceiptFile> => {
    await mkdir(config.stagingRoot, { recursive: true });
    const temporaryPath = join(config.stagingRoot, `.incoming-${randomUUID()}.part`);
    const handle = await open(temporaryPath, "wx");
    const hash = createHash("sha256");
    let byteLength = 0;
    try {
      const reader = file.stream().getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          byteLength += chunk.value.byteLength;
          if (byteLength > maxFileBytes) throw new Error("receipt file exceeds configured limit");
          hash.update(chunk.value);
          await handle.write(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      await handle.sync();
      await handle.close();
      const identity = fileIdentity(commandId, contentType, {
        byteLength,
        sha256: hash.digest("hex"),
      });
      const targetPath = pathFor(config.stagingRoot, identity.fileRef);
      await mkdir(dirname(targetPath), { recursive: true });
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

  const service: ReceiptFileServiceShape = {
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
          const requestDigest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
          const previous = applied.get(request.effectId);
          if (previous !== undefined) {
            if (previous !== requestDigest) throw new ReceiptFileEffectConflict({ effectId: request.effectId });
            return;
          }

          const stagingPath = pathFor(config.stagingRoot, request.file.fileRef);
          const committedPath = pathFor(config.committedRoot, request.file.objectKey);
          if (request._tag === "PromoteReceiptFile") {
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
              await mkdir(dirname(committedPath), { recursive: true });
              try {
                await rename(stagingPath, committedPath);
              } catch (cause) {
                if (!(cause !== null && typeof cause === "object" && "code" in cause && cause.code === "EXDEV")) {
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
          applied.set(request.effectId, requestDigest);
        },
        catch: (cause) => {
          if (
            cause instanceof ReceiptFileEffectConflict ||
            cause instanceof ReceiptFileIdentityConflict ||
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
    layer: Layer.succeed(ReceiptFileService)(service),
    stageBytes,
    cleanupStage,
  };
};
