import { Effect, Stream } from "effect";
import * as Multipart from "effect/unstable/http/Multipart";

export { RECEIPT_FILE_MAX_BYTES } from "@vektorprogrammet/domain/receipt";

/**
 * A receipt file part exceeded its byte limit. This is an input error in a readable form:
 * `fields` holds the parts read before the file, so a form can answer in place with the
 * draft and command identity it submitted.
 */
export class ReceiptFileTooLarge extends RangeError {
  readonly fields: FormData;

  constructor(fields: FormData) {
    super("Receipt file is too large");
    this.name = "ReceiptFileTooLarge";
    this.fields = fields;
  }
}

/** Bytes beyond a file's limit that the transfer bound admits for the other form parts. */
const transferMargin = 131_072;

/** The most bytes that a receipt form with a file of at most `maxFileBytes` may transfer. */
export const receiptTransferMaxBytes = (maxFileBytes: number): number =>
  maxFileBytes + transferMargin;

/**
 * Transport chunks are split to at most half the margin and parsed one per pull, so the
 * parser sees a file cross its limit before the transfer count can cross the body bound.
 */
const transferSlice = transferMargin / 2;

const slices = function* (chunk: Uint8Array) {
  for (let offset = 0; offset < chunk.byteLength; offset += transferSlice) {
    yield chunk.subarray(offset, offset + transferSlice);
  }
};

/**
 * Bound transfer bytes while parsing and cancel the source with its request.
 *
 * The byte counters, not the declared length, enforce the bounds: a body whose file is
 * too large stops after that file's limit, so the fields before it stay readable.
 */
export const readBoundedReceiptForm = async (
  request: Request,
  maxFileBytes: number,
): Promise<FormData> => {
  const maxBytes = receiptTransferMaxBytes(maxFileBytes);
  const length = request.headers.get("content-length");

  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new TypeError("Invalid receipt body length");
  }

  const body = request.body;

  if (!body) throw new TypeError("Receipt body is required");
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  let size = 0;

  const source = Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => new TypeError("Receipt transfer failed", { cause }),
  }).pipe(
    Stream.map(slices),
    Stream.flattenIterable,
    Stream.rechunk(1),
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

                if (fileBytes > maxFileBytes) throw new ReceiptFileTooLarge(form);

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
