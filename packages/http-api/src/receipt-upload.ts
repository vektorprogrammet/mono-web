import { Effect, Stream } from "effect";
import * as Multipart from "effect/unstable/http/Multipart";

/** Bound the transfer before parsing; preserve opaque binary bytes on Bun and Node. */
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

  if (!request.body) throw new TypeError("Receipt body is required");
  const contentType = request.headers.get("content-type") ?? "";
  let size = 0;

  const bounded = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;

        if (size > maxBytes) throw new RangeError("Receipt body is too large");
        controller.enqueue(chunk);
      },
    }),
  );

  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return new Response(bounded, { headers: { "content-type": contentType } }).formData();
  }

  const form = new FormData();
  await Effect.runPromise(
    Stream.fromReadableStream({
      evaluate: () => bounded,
      onError: (cause) => new TypeError("Receipt transfer failed", { cause }),
    }).pipe(
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
  );

  return form;
};
