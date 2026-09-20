import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import { Schema } from "effect";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { nativeProblemFrom } from "../lib/native-problem";
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

type ReceiptFileHeaders = {
  readonly "cache-control"?: unknown;
  readonly "content-disposition"?: unknown;
  readonly "content-length"?: unknown;
  readonly "content-type"?: unknown;
  readonly "x-content-type-options"?: unknown;
  readonly vary?: unknown;
};

type ReceiptFileFailureStatus = 401 | 403 | 404 | 503;

function privateFailure(status: ReceiptFileFailureStatus): Response {
  return new Response(null, { status, headers: privateErrorHeaders });
}

function receiptFileFailureStatus(error: unknown): ReceiptFileFailureStatus {
  switch (nativeProblemFrom(error)?.code) {
    case "credential.missing":
    case "credential.invalid":
      return 401;
    case "authority.denied":
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
}

function authenticatedFailureStatus(error: unknown): 401 | 503 {
  if (receiptFileFailureStatus(error) === 401) return 401;
  if (
    error instanceof Response &&
    (error.status === 401 || (error.status >= 300 && error.status < 400))
  ) {
    return 401;
  }
  return 503;
}

function receiptFileResponseHeaders(headers: ReceiptFileHeaders, bytes: Uint8Array): Headers | undefined {
  const contentType = headers["content-type"];
  const contentLength = headers["content-length"];
  const contentDisposition = headers["content-disposition"];
  const contentTypeOptions = headers["x-content-type-options"];
  const cacheControl = headers["cache-control"];
  const vary = headers.vary;

  if (
    typeof contentType !== "string" ||
    (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "application/pdf") ||
    typeof contentLength !== "string" ||
    typeof contentDisposition !== "string" ||
    typeof contentTypeOptions !== "string" ||
    typeof cacheControl !== "string" ||
    typeof vary !== "string"
  ) {
    return undefined;
  }

  const extension = fileExtensionByContentType[contentType];
  if (
    !/^(?:0|[1-9]\d*)$/u.test(contentLength) ||
    Number(contentLength) !== bytes.byteLength ||
    contentDisposition !== `inline; filename="receipt.${extension}"` ||
    contentTypeOptions !== "nosniff" ||
    cacheControl !== "private, no-store" ||
    vary !== "Origin"
  ) {
    return undefined;
  }

  return new Headers({
    "cache-control": cacheControl,
    "content-disposition": contentDisposition,
    "content-length": contentLength,
    "content-type": contentType,
    vary,
    "x-content-type-options": contentTypeOptions,
  });
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  let cookie: string;
  try {
    cookie = await requireAuth(request);
  } catch (error) {
    return privateFailure(authenticatedFailureStatus(error));
  }

  let receiptId: typeof ReceiptId.Type;
  try {
    receiptId = Schema.decodeUnknownSync(ReceiptId)(params.receiptId);
  } catch {
    return privateFailure(404);
  }

  try {
    const result = await createAuthenticatedClient(cookie, request).receipts.readReceiptFileForApproval({
      params: { receiptId },
    });
    const headers = receiptFileResponseHeaders(result.headers, result.body);
    return headers === undefined ? privateFailure(503) : new Response(result.body, { headers });
  } catch (error) {
    return privateFailure(receiptFileFailureStatus(error));
  }
}
