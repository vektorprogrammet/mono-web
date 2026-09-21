import { Effect } from "effect";
import { HttpSemanticFailure, parseJsonWithoutDuplicateMembers } from "../http-semantics.js";

/** Bound bytes while reading, including requests without Content-Length. */
export const readBoundedJson = (request: Request, maxBytes: number) => {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared))))
    return Effect.fail(new HttpSemanticFailure("request.malformed", 400));
  if (declared !== null && Number(declared) > maxBytes)
    return Effect.fail(new HttpSemanticFailure("request.too-large", 413));
  const reader = request.body?.getReader();
  if (!reader) return Effect.fail(new HttpSemanticFailure("request.malformed", 400));

  return Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (cause) =>
          cause instanceof HttpSemanticFailure
            ? cause
            : new HttpSemanticFailure("internal.error", 500),
      });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        yield* Effect.tryPromise({
          try: () => reader.cancel(),
          catch: (cause) =>
            cause instanceof HttpSemanticFailure
              ? cause
              : new HttpSemanticFailure("internal.error", 500),
        });
        return yield* Effect.fail(new HttpSemanticFailure("request.too-large", 413));
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return yield* Effect.try({
      try: () => parseJsonWithoutDuplicateMembers(bytes),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure
          ? cause
          : new HttpSemanticFailure("request.malformed", 400),
    });
  }).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock())));
};
