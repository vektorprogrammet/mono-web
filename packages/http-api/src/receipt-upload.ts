import { Effect, Stream } from "effect";
import * as Multipart from "effect/unstable/http/Multipart";

/** Bound transfer bytes before parsing and cancel the source with its request. */
export const readBoundedReceiptForm = async (
  request: Request,
  maxFileBytes: number,
): Promise<FormData> => {
  const maxBytes = maxFileBytes + 131_072;
  const length = request.headers.get("content-length");

  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new TypeError("Invalid receipt body length");
  }

  if (length !== null && Number(length) > maxBytes)
    throw new RangeError("Receipt body is too large");

  const body = request.body;

  if (!body) throw new TypeError("Receipt body is required");
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  let size = 0;

  const source = Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => new TypeError("Receipt transfer failed", { cause }),
  }).pipe(
    Stream.map((chunk) => {
      size += chunk.byteLength;

      if (size > maxBytes) throw new RangeError("Receipt body is too large");

      return chunk;
    }),
  );

  const form = new FormData();

  if (mediaType === "application/x-www-form-urlencoded") {
    const encoded = await Effect.runPromise(source.pipe(Stream.decodeText(), Stream.mkString), {
      signal: request.signal,
    });

    for (const [key, value] of new URLSearchParams(encoded)) form.append(key, value);

    return form;
  }

  if (mediaType !== "multipart/form-data") throw new TypeError("Unsupported receipt content type");

  await Effect.runPromise(
    source.pipe(
      Stream.pipeThroughChannel(Multipart.makeChannel({ "content-type": contentType })),
      Stream.runForEach(
        Effect.fnUntraced(function* (part) {
          if (Multipart.isField(part)) {
            form.append(part.key, part.value);
          } else {
            const chunks: Array<Uint8Array<ArrayBuffer>> = [];
            let fileBytes = 0;
            yield* Stream.runForEach(part.content, (chunk) =>
              Effect.sync(() => {
                fileBytes += chunk.byteLength;

                if (fileBytes > maxFileBytes) throw new RangeError("Receipt file is too large");

                if (!(chunk.buffer instanceof ArrayBuffer))
                  throw new TypeError("Invalid receipt byte buffer");
                chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
              }),
            );
            form.append(part.key, new File(chunks, part.name, { type: part.contentType }));
          }
        }),
      ),
      Effect.provideContext(
        Multipart.limitsServices({
          maxParts: 8,
          maxFieldSize: 65_536,
          maxFileSize: maxBytes,
          maxTotalSize: maxBytes,
          fieldMimeTypes: [],
        }),
      ),
    ),
    { signal: request.signal },
  );

  return form;
};
