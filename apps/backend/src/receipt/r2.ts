import { Effect, Layer, Predicate } from "effect";
import {
  ReceiptDecodeError,
  ReceiptFileEffectConflict,
  ReceiptFileIdentityConflict,
  ReceiptFileNotStaged,
  ReceiptFileService,
  type ReceiptFile,
  type ReceiptFileRequest,
  type ReceiptFileServiceShape,
} from "@vektorprogrammet/domain/receipt";
import type { ReceiptFileStore, StagedReceiptFile } from "./filesystem.js";

export interface R2Object {
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

/** The subset of the Workers R2 binding used by the private receipt store. */
export interface R2Bucket {
  readonly get: (key: string) => Promise<R2Object | null>;
  readonly put: (
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { readonly httpMetadata?: { readonly contentType?: string } },
  ) => Promise<unknown>;
  readonly delete: (key: string) => Promise<void>;
}

export interface R2ReceiptFileStoreConfig {
  readonly bucket: R2Bucket;
  readonly failNextPromotionEffectId?: string;
}

interface Digest {
  readonly byteLength: number;
  readonly sha256: string;
}

type Existing = "missing" | "matching" | "different";

const encoder = new TextEncoder();
const extensionFor = (contentType: ReceiptFile["contentType"]): string =>
  contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpeg";

const hexDigest = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const digestBytes = async (bytes: Uint8Array): Promise<Digest> => ({
  byteLength: bytes.byteLength,
  sha256: await hexDigest(bytes),
});

const keyIsSafe = (key: string): boolean =>
  key.length > 0 &&
  key.length <= 512 &&
  !key.includes("\\") &&
  key.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

const receiptFileIdentity = async (
  commandId: string,
  contentType: ReceiptFile["contentType"],
  digest: Digest,
): Promise<ReceiptFile> => {
  const commandDigest = await hexDigest(encoder.encode(commandId));
  const suffix = `${commandDigest.slice(0, 32)}-${digest.sha256}-${extensionFor(contentType)}`;
  return {
    fileRef: `staging/${suffix}`,
    objectKey: `committed/${suffix}`,
    contentType,
    byteLength: digest.byteLength,
    sha256: digest.sha256,
  };
};

const notStaged = (effectId: string, fileRef: string): ReceiptFileNotStaged =>
  new ReceiptFileNotStaged({ effectId, fileRef });

const readMatching = async (
  bucket: R2Bucket,
  key: string,
  file: ReceiptFile,
): Promise<Existing> => {
  const object = await bucket.get(key);
  if (object === null) return "missing";
  if (object.size !== file.byteLength || object.httpMetadata?.contentType !== file.contentType)
    return "different";
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = await digestBytes(bytes);
  return digest.byteLength === file.byteLength && digest.sha256 === file.sha256
    ? "matching"
    : "different";
};

const encodedRequest = (request: ReceiptFileRequest): string => JSON.stringify(request);
const markerKeyFor = async (effectId: string): Promise<string> =>
  `effects/${await hexDigest(encoder.encode(effectId))}`;

const ensureFileIdentity = (file: ReceiptFile): void => {
  if (!keyIsSafe(file.fileRef) || !keyIsSafe(file.objectKey)) {
    throw new ReceiptFileIdentityConflict({ effectId: "identity", objectKey: file.objectKey });
  }
};

export const makeR2ReceiptFileStore = (config: R2ReceiptFileStoreConfig): ReceiptFileStore => {
  if (
    !Predicate.isObject(config.bucket) ||
    typeof config.bucket.get !== "function" ||
    typeof config.bucket.put !== "function" ||
    typeof config.bucket.delete !== "function"
  ) {
    throw new TypeError("R2 receipt bucket binding is required");
  }
  let failNextPromotionEffectId = config.failNextPromotionEffectId;

  const stageBytes = async (
    file: File,
    commandId: string,
    contentType: ReceiptFile["contentType"],
    maxFileBytes: number,
  ): Promise<StagedReceiptFile> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > maxFileBytes) {
      throw new ReceiptDecodeError({ message: "receipt file exceeds configured limit" });
    }
    const identity = await receiptFileIdentity(commandId, contentType, await digestBytes(bytes));
    const existing = await readMatching(config.bucket, identity.fileRef, identity);
    if (existing === "matching") return { file: identity, created: false };
    if (existing === "different") throw new Error("receipt staging identity conflict");
    await config.bucket.put(identity.fileRef, bytes, { httpMetadata: { contentType } });
    return { file: identity, created: true };
  };

  const cleanupStage = async (file: ReceiptFile): Promise<void> => {
    ensureFileIdentity(file);
    await config.bucket.delete(file.fileRef);
  };

  const service: ReceiptFileServiceShape = {
    stage: (file) =>
      Effect.tryPromise({
        try: async () => {
          ensureFileIdentity(file);
          const staged = await readMatching(config.bucket, file.fileRef, file);
          if (staged === "matching") return;
          if (staged === "different") {
            throw new ReceiptFileIdentityConflict({ effectId: "stage", objectKey: file.objectKey });
          }
          const committed = await readMatching(config.bucket, file.objectKey, file);
          if (committed === "matching") return;
          if (committed === "different") {
            throw new ReceiptFileIdentityConflict({ effectId: "stage", objectKey: file.objectKey });
          }
          throw notStaged("stage", file.fileRef);
        },
        catch: (cause) =>
          cause instanceof ReceiptFileIdentityConflict ? cause : notStaged("stage", file.fileRef),
      }),
    apply: (request) =>
      Effect.tryPromise({
        try: async () => {
          ensureFileIdentity(request.file);
          const markerKey = await markerKeyFor(request.effectId);
          const marker = await config.bucket.get(markerKey);
          const requestJson = encodedRequest(request);
          if (marker !== null) {
            const previous = new TextDecoder().decode(await marker.arrayBuffer());
            if (previous !== requestJson)
              throw new ReceiptFileEffectConflict({ effectId: request.effectId });
            return;
          }
          if (request._tag === "PromoteReceiptFile") {
            if (failNextPromotionEffectId === request.effectId) {
              failNextPromotionEffectId = undefined;
              throw notStaged(request.effectId, request.file.fileRef);
            }
            const committed = await readMatching(
              config.bucket,
              request.file.objectKey,
              request.file,
            );
            if (committed === "different") {
              throw new ReceiptFileIdentityConflict({
                effectId: request.effectId,
                objectKey: request.file.objectKey,
              });
            }
            if (committed === "missing") {
              const staged = await config.bucket.get(request.file.fileRef);
              if (staged === null) throw notStaged(request.effectId, request.file.fileRef);
              const bytes = new Uint8Array(await staged.arrayBuffer());
              const digest = await digestBytes(bytes);
              if (
                digest.byteLength !== request.file.byteLength ||
                digest.sha256 !== request.file.sha256 ||
                staged.httpMetadata?.contentType !== request.file.contentType
              ) {
                throw notStaged(request.effectId, request.file.fileRef);
              }
              await config.bucket.put(request.file.objectKey, bytes, {
                httpMetadata: { contentType: request.file.contentType },
              });
            }
            await config.bucket.delete(request.file.fileRef);
          } else {
            const committed = await readMatching(
              config.bucket,
              request.file.objectKey,
              request.file,
            );
            if (committed === "different") {
              throw new ReceiptFileIdentityConflict({
                effectId: request.effectId,
                objectKey: request.file.objectKey,
              });
            }
            if (committed === "matching") await config.bucket.delete(request.file.objectKey);
          }
          await config.bucket.put(markerKey, requestJson, {
            httpMetadata: { contentType: "application/json" },
          });
        },
        catch: (cause) => {
          if (
            cause instanceof ReceiptFileEffectConflict ||
            cause instanceof ReceiptFileIdentityConflict ||
            cause instanceof ReceiptFileNotStaged
          ) {
            return cause;
          }
          return notStaged(request.effectId, request.file.fileRef);
        },
      }),
  };

  return {
    service,
    readCommitted: async (file, maxFileBytes) => {
      ensureFileIdentity(file);
      if (file.byteLength > maxFileBytes) throw new Error("receipt file exceeds configured limit");
      const object = await config.bucket.get(file.objectKey);
      if (object === null || object.size !== file.byteLength || object.size > maxFileBytes) {
        throw new Error("receipt file mismatch");
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      const digest = await digestBytes(bytes);
      if (
        digest.byteLength !== file.byteLength ||
        digest.sha256 !== file.sha256 ||
        object.httpMetadata?.contentType !== file.contentType
      ) {
        throw new Error("receipt file mismatch");
      }
      return bytes;
    },
    layer: Layer.succeed(ReceiptFileService)(service),
    stageBytes,
    cleanupStage,
  };
};
