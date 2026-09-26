import { ReceiptFileStoreError, ReceiptFileStoreResource } from "./filesystem.js";
import { jsonText } from "../http-api/problem.js";
import { Data, Match, Effect, Layer, Predicate } from "effect";
import {
  ReceiptDecodeError,
  ReceiptFileEffectConflict,
  ReceiptFileIdentityConflict,
  ReceiptFileNotStaged,
  ReceiptFileService,
  type ReceiptFile,
  type ReceiptFileRequest,
  type ReceiptFileServiceOperations,
} from "@vektorprogrammet/domain/receipt";
import type { ReceiptFileStore } from "./filesystem.js";

export interface R2Object {
  readonly size: number;
  readonly etag?: string;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface R2PutOptions {
  readonly httpMetadata?: { readonly contentType?: string };
  readonly onlyIf?: Headers | { readonly etagDoesNotMatch: string };
}

/** The subset of the Workers R2 binding used by the private receipt store. */
export interface R2Bucket {
  readonly get: (key: string) => Promise<R2Object | null>;
  readonly put: (
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: R2PutOptions,
  ) => Promise<R2Object | null>;
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

/** A bucket or Web Crypto call that rejected; each store operation maps it to its own outcome. */
class R2CallFailure extends Data.TaggedError("R2CallFailure")<{ readonly cause: unknown }> {}

const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new R2CallFailure({ cause }) });

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const extensionFor = (contentType: ReceiptFile["contentType"]): string =>
  Match.value(contentType).pipe(
    Match.when("application/pdf", () => "pdf" as const),
    Match.when("image/png", () => "png" as const),
    Match.orElse(() => "jpeg" as const),
  );

const hexDigest = (bytes: Uint8Array) =>
  call(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const digestBytes = (bytes: Uint8Array) =>
  Effect.map(hexDigest(bytes), (sha256): Digest => ({ byteLength: bytes.byteLength, sha256 }));

const keyIsSafe = (key: string): boolean =>
  key.length > 0 &&
  key.length <= 512 &&
  !key.includes("\\") &&
  key.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

const receiptFileIdentity = (
  commandId: string,
  contentType: ReceiptFile["contentType"],
  digest: Digest,
) =>
  Effect.map(hexDigest(encoder.encode(commandId)), (commandDigest): ReceiptFile => {
    const suffix = `${commandDigest.slice(0, 32)}-${digest.sha256}-${extensionFor(contentType)}`;

    return {
      fileRef: `staging/${suffix}`,
      objectKey: `committed/${suffix}`,
      contentType,
      byteLength: digest.byteLength,
      sha256: digest.sha256,
    };
  });

const notStaged = (effectId: string, fileRef: string): ReceiptFileNotStaged =>
  new ReceiptFileNotStaged({ effectId, fileRef });

const readMatching = (bucket: R2Bucket, key: string, file: ReceiptFile) =>
  Effect.gen(function* () {
    const object = yield* call(() => bucket.get(key));

    if (object === null) return "missing" satisfies Existing;

    if (object.size !== file.byteLength || object.httpMetadata?.contentType !== file.contentType)
      return "different" satisfies Existing;

    const digest = yield* call(() => object.arrayBuffer()).pipe(
      Effect.flatMap((buffer) => digestBytes(new Uint8Array(buffer))),
    );

    return digest.byteLength === file.byteLength && digest.sha256 === file.sha256
      ? ("matching" satisfies Existing)
      : ("different" satisfies Existing);
  });

const markerRequest = (bucket: R2Bucket, key: string) =>
  call(() => bucket.get(key)).pipe(
    Effect.flatMap((marker) =>
      marker === null
        ? Effect.succeed(null)
        : Effect.map(
            call(() => marker.arrayBuffer()),
            (buffer) => decoder.decode(buffer),
          ),
    ),
  );

const claimEffect = (bucket: R2Bucket, markerKey: string, request: ReceiptFileRequest) =>
  Effect.gen(function* () {
    const requestJson = yield* jsonText(request);
    const existing = yield* markerRequest(bucket, markerKey);

    if (existing !== null) {
      if (existing !== requestJson)
        return yield* new ReceiptFileEffectConflict({ effectId: request.effectId });

      return;
    }

    const claimed = yield* call(() =>
      bucket.put(markerKey, requestJson, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: new Headers({ "if-none-match": "*" }),
      }),
    );

    if (claimed !== null) return;
    const winner = yield* markerRequest(bucket, markerKey);

    if (winner !== requestJson)
      return yield* new ReceiptFileEffectConflict({ effectId: request.effectId });
  });

const ensureFileIdentity = (file: ReceiptFile) =>
  keyIsSafe(file.fileRef) && keyIsSafe(file.objectKey)
    ? Effect.void
    : Effect.fail(
        new ReceiptFileIdentityConflict({ effectId: "identity", objectKey: file.objectKey }),
      );

export const makeR2ReceiptFileStore = (config: R2ReceiptFileStoreConfig): ReceiptFileStore => {
  if (
    !Predicate.isObject(config.bucket) ||
    !Predicate.isFunction(config.bucket.get) ||
    !Predicate.isFunction(config.bucket.put) ||
    !Predicate.isFunction(config.bucket.delete)
  ) {
    throw new TypeError("R2 receipt bucket binding is required");
  }

  const bucket = config.bucket;
  let failNextPromotionEffectId = config.failNextPromotionEffectId;

  const storeFailure =
    (operation: ReceiptFileStoreError["operation"], message: string) =>
    (cause: ReceiptFileIdentityConflict | R2CallFailure) =>
      Effect.fail(new ReceiptFileStoreError({ operation, message, cause }));

  const stageBytes = (
    file: File,
    commandId: string,
    contentType: ReceiptFile["contentType"],
    maxFileBytes: number,
  ) =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(yield* call(() => file.arrayBuffer()));

      if (bytes.byteLength > maxFileBytes) {
        return yield* new ReceiptDecodeError({ message: "receipt file exceeds configured limit" });
      }

      const identity = yield* receiptFileIdentity(
        commandId,
        contentType,
        yield* digestBytes(bytes),
      );

      const existing = yield* readMatching(bucket, identity.fileRef, identity);

      if (existing === "matching") return { file: identity, created: false };

      if (existing === "different") {
        return yield* new ReceiptFileStoreError({
          operation: "stageBytes",
          message: "receipt staging identity conflict",
        });
      }

      yield* call(() => bucket.put(identity.fileRef, bytes, { httpMetadata: { contentType } }));

      return { file: identity, created: true };
    }).pipe(Effect.catchTag("R2CallFailure", storeFailure("stageBytes", "R2 staging failed")));

  const cleanupStage = (file: ReceiptFile) =>
    ensureFileIdentity(file).pipe(
      Effect.andThen(call(() => bucket.delete(file.fileRef))),
      Effect.catchTags({
        ReceiptFileIdentityConflict: storeFailure("cleanupStage", "unsafe receipt file identity"),
        R2CallFailure: storeFailure("cleanupStage", "R2 cleanup failed"),
      }),
    );

  // The staged bytes of a promotion, verified against the recorded file identity.
  const verifiedStage = (request: ReceiptFileRequest) =>
    Effect.gen(function* () {
      const staged = yield* call(() => bucket.get(request.file.fileRef));

      if (staged === null) return yield* notStaged(request.effectId, request.file.fileRef);
      const bytes = new Uint8Array(yield* call(() => staged.arrayBuffer()));
      const digest = yield* digestBytes(bytes);

      if (
        digest.byteLength !== request.file.byteLength ||
        digest.sha256 !== request.file.sha256 ||
        staged.httpMetadata?.contentType !== request.file.contentType
      ) {
        return yield* notStaged(request.effectId, request.file.fileRef);
      }

      return bytes;
    });

  const service: ReceiptFileServiceOperations = {
    stage: (file) =>
      Effect.gen(function* () {
        yield* ensureFileIdentity(file);
        const staged = yield* readMatching(bucket, file.fileRef, file);

        if (staged === "matching") return;

        if (staged === "different") {
          return yield* new ReceiptFileIdentityConflict({
            effectId: "stage",
            objectKey: file.objectKey,
          });
        }

        const committed = yield* readMatching(bucket, file.objectKey, file);

        if (committed === "matching") return;

        if (committed === "different") {
          return yield* new ReceiptFileIdentityConflict({
            effectId: "stage",
            objectKey: file.objectKey,
          });
        }

        return yield* notStaged("stage", file.fileRef);
      }).pipe(
        Effect.catchTag("R2CallFailure", () => Effect.fail(notStaged("stage", file.fileRef))),
      ),
    apply: (request) =>
      Effect.gen(function* () {
        yield* ensureFileIdentity(request.file);
        const markerKey = `effects/${yield* hexDigest(encoder.encode(request.effectId))}`;

        if (Predicate.isTagged(request, "PromoteReceiptFile")) {
          if (failNextPromotionEffectId === request.effectId) {
            failNextPromotionEffectId = undefined;

            return yield* notStaged(request.effectId, request.file.fileRef);
          }

          const committed = yield* readMatching(bucket, request.file.objectKey, request.file);

          if (committed === "different") {
            return yield* new ReceiptFileIdentityConflict({
              effectId: request.effectId,
              objectKey: request.file.objectKey,
            });
          }

          const bytes = committed === "missing" ? yield* verifiedStage(request) : undefined;
          yield* claimEffect(bucket, markerKey, request);

          if (bytes !== undefined) {
            yield* call(() =>
              bucket.put(request.file.objectKey, bytes, {
                httpMetadata: { contentType: request.file.contentType },
              }),
            );
          }

          return yield* call(() => bucket.delete(request.file.fileRef));
        }

        const committed = yield* readMatching(bucket, request.file.objectKey, request.file);

        if (committed === "different") {
          return yield* new ReceiptFileIdentityConflict({
            effectId: request.effectId,
            objectKey: request.file.objectKey,
          });
        }

        yield* claimEffect(bucket, markerKey, request);

        if (committed === "matching") yield* call(() => bucket.delete(request.file.objectKey));
      }).pipe(
        Effect.catchTag("R2CallFailure", () =>
          Effect.fail(notStaged(request.effectId, request.file.fileRef)),
        ),
      ),
  };

  const readCommitted = (file: ReceiptFile, maxFileBytes: number) =>
    Effect.gen(function* () {
      const mismatch = new ReceiptFileStoreError({
        operation: "readCommitted",
        message: "receipt file mismatch",
      });

      yield* ensureFileIdentity(file);

      if (file.byteLength > maxFileBytes) {
        return yield* new ReceiptFileStoreError({
          operation: "readCommitted",
          message: "receipt file exceeds configured limit",
        });
      }

      const object = yield* call(() => bucket.get(file.objectKey));

      if (object === null || object.size !== file.byteLength || object.size > maxFileBytes) {
        return yield* mismatch;
      }

      const bytes = new Uint8Array(yield* call(() => object.arrayBuffer()));
      const digest = yield* digestBytes(bytes);

      if (
        digest.byteLength !== file.byteLength ||
        digest.sha256 !== file.sha256 ||
        object.httpMetadata?.contentType !== file.contentType
      ) {
        return yield* mismatch;
      }

      return bytes;
    }).pipe(
      Effect.catchTags({
        ReceiptFileIdentityConflict: storeFailure("readCommitted", "unsafe receipt file identity"),
        R2CallFailure: storeFailure("readCommitted", "R2 read failed"),
      }),
    );

  return {
    service,
    readCommitted,
    layer: Layer.succeed(ReceiptFileService)(service),
    stageBytes,
    cleanupStage,
  };
};

export const R2ReceiptFileStoreLive = (config: R2ReceiptFileStoreConfig) =>
  Layer.sync(ReceiptFileStoreResource, () => makeR2ReceiptFileStore(config));
