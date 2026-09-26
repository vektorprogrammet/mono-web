import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Schema } from "effect";
import { parseJsonWithoutDuplicateMembers } from "../http-semantics.js";

type ReadJsonProblem =
  | Problem<"request.malformed">
  | Problem<"request.too-large">
  | Problem<"internal.error">;

/**
 * Bound bytes while reading, including requests without Content-Length. A
 * body that cannot be read at all is an internal error; everything else the
 * client sent wrong is request.malformed or request.too-large.
 */
export const readBoundedJson = (
  request: Request,
  maxBytes: number,
): Effect.Effect<Schema.Json, ReadJsonProblem> => {
  const declared = request.headers.get("content-length");

  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared))))
    return Effect.fail(Problem.make("request.malformed"));

  if (declared !== null && Number(declared) > maxBytes)
    return Effect.fail(Problem.make("request.too-large"));
  const reader = request.body?.getReader();

  if (!reader) return Effect.fail(Problem.make("request.malformed"));

  return Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: () => Problem.make("internal.error"),
      });

      if (next.done) break;
      size += next.value.byteLength;

      if (size > maxBytes) {
        yield* Effect.tryPromise({
          try: () => reader.cancel(),
          catch: () => Problem.make("internal.error"),
        });

        return yield* Problem.make("request.too-large");
      }

      chunks.push(next.value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // The parser throws only request.malformed problems.
    return yield* Effect.try({
      try: () => parseJsonWithoutDuplicateMembers(bytes),
      catch: () => Problem.make("request.malformed"),
    });
  }).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock())));
};
