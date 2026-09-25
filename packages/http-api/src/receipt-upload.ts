/** Count actual transfer bytes before a multipart parser can materialize them. */
export const readBoundedReceiptForm = async (request: Request, maxFileBytes: number): Promise<FormData> => {
  const maxBytes = maxFileBytes + 131_072;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new TypeError("Invalid receipt body length");
  }
  if (length !== null && Number(length) > maxBytes) throw new RangeError("Receipt body is too large");
  if (!request.body) throw new TypeError("Receipt body is required");
  let size = 0;
  const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new RangeError("Receipt body is too large");
      controller.enqueue(chunk);
    },
  }));
  return new Response(bounded, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
};
