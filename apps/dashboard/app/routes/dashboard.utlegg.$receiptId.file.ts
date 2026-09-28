import { Schema, flow } from "effect";
import { ReceiptId, type ReceiptFileContent } from "@vektorprogrammet/rpc";

import { callNative } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { nativeFailureFrom } from "../lib/native-problem";
import type { Route } from "./+types/dashboard.utlegg.$receiptId.file";

const privateErrorHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
} as const;

const fileExtensionByContentType = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
} as const;

type ReceiptFileFailureStatus = 401 | 403 | 404 | 503;

function privateFailure(status: ReceiptFileFailureStatus): Response {
  return new Response(null, { status, headers: privateErrorHeaders });
}

const receiptFileFailureStatus = flow(nativeFailureFrom, (error): ReceiptFileFailureStatus => {
  switch ((error instanceof Error || error instanceof Response ? undefined : error?.code)) {
    case "credential.missing":
    case "credential.invalid":
      return 401;
    case "authority.denied":
    case "origin.denied":
      return 403;
    case "receipt.not-found":
    case "resource.not-found":
      return 404;
    case "receipts.unavailable":
    case "dependency.unavailable":
    case "internal.error":
      return 503;
    default:
      if (error instanceof Response) {
        switch (error.status) {
          case 401:
            return 401;
          case 403:
            return 403;
          case 404:
            return 404;
        }
      }

      return 503;
  }
});

const authenticatedFailureStatus = flow(nativeFailureFrom, (error): 401 | 503 => {
  if (receiptFileFailureStatus(error) === 401) return 401;

  if (
    error instanceof Response &&
    (error.status === 401 || (error.status >= 300 && error.status < 400))
  ) {
    return 401;
  }

  return 503;
});

/**
 * The private headers of one receipt file, derived from its stored media type: the browser gets
 * the same answer that the backend's HTTP route gave, at the same dashboard URL.
 */
function receiptFileResponseHeaders(file: ReceiptFileContent): Headers | undefined {
  if (file.bytes.byteLength === 0) return undefined;

  return new Headers({
    "cache-control": "private, no-store",
    "content-disposition": `inline; filename="receipt.${fileExtensionByContentType[file.contentType]}"`,
    "content-length": String(file.bytes.byteLength),
    "content-type": file.contentType,
    vary: "Origin",
    "x-content-type-options": "nosniff",
  });
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  let cookie: string;

  try {
    cookie = await requireAuth(request);
  } catch (error) {
    return privateFailure(authenticatedFailureStatus(error));
  }

  let receiptId: ReceiptId;

  try {
    receiptId = Schema.decodeSync(ReceiptId)(params.receiptId);
  } catch {
    return privateFailure(404);
  }

  try {
    const result = await callNative(cookie, request, (client) =>
      client["receipts.readReceiptFileForApproval"]({ receiptId }),
    );

    const headers = receiptFileResponseHeaders(result);

    if (headers === undefined) return privateFailure(503);

    const responseBytes =
      result.bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength)
        : Uint8Array.from(result.bytes);

    return new Response(responseBytes, { headers });
  } catch (error) {
    return privateFailure(receiptFileFailureStatus(error));
  }
}
