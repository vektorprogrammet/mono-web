import { HttpSemanticFailure, parseJsonWithoutDuplicateMembers } from "../http-semantics.js";
/** Bound bytes while reading, including requests without Content-Length. */
export const readBoundedJson = async (request: Request, maxBytes: number): Promise<unknown> => {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared))))
    throw new HttpSemanticFailure("request.malformed", 400);
  if (declared !== null && Number(declared) > maxBytes)
    throw new HttpSemanticFailure("request.too-large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new HttpSemanticFailure("request.malformed", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpSemanticFailure("request.too-large", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseJsonWithoutDuplicateMembers(bytes);
};
