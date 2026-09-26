/** Receipt HTTP representations: ETags, JSON resources, command capsules, and file bodies. */
import {
  ReceiptPersistenceError,
  type OwnedReceiptProjectionItem,
  type Receipt,
  type ReceiptFile,
  type ReceiptSettlementEvidence,
} from "@vektorprogrammet/domain/receipt";
import {
  ReceiptSettlementEvidenceResource,
  type ReceiptListItem,
  type ReceiptResource,
} from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Schema } from "effect";
import type { NativeHttpResponseCapsule } from "../http-api/receipt-transaction.js";
import { deriveStrongETag } from "../http-semantics.js";
import type { ReceiptFileStore } from "./filesystem.js";

/**
 * A JSON body under the receipt cache policy the caller names.
 */
export const jsonResponse = (
  body: Schema.Json,
  status = 200,
  cacheControl: "no-store" | "private, no-store" = "no-store",
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
    },
  });

/**
 * A JSON body private to the caller, varying by Origin.
 */
export const privateJsonResponse = (body: Schema.Json, status = 200): Response => {
  const response = jsonResponse(body, status, "private, no-store");
  response.headers.set("vary", "Origin");

  return response;
};

/**
 * Projects stored rows onto response items. A stored value outside the
 * response contract is the receipt store failing; any other throw is a defect.
 */
export const projected = <A>(project: () => A): Effect.Effect<A, ReceiptPersistenceError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(project());
    } catch (cause) {
      return Schema.is(ReceiptPersistenceError)(cause) ? Effect.fail(cause) : Effect.die(cause);
    }
  });

export const receiptEtag = (receiptId: string, revision: number) =>
  deriveStrongETag({
    representationKind: "ReceiptResource",
    resourceIdentity: receiptId,
    version: revision,
  });

export const receiptSettlementEvidenceResource = (
  settlement: ReceiptSettlementEvidence,
): typeof ReceiptSettlementEvidenceResource.Type => {
  const amountOre = Number(settlement.amountOre);

  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new ReceiptPersistenceError({
      operation: "decode receipt settlement evidence",
      message: "invalid amount",
    });
  }

  try {
    return Schema.decodeSync(ReceiptSettlementEvidenceResource)({
      ...settlement,
      amountOre,
    });
  } catch {
    throw new ReceiptPersistenceError({
      operation: "decode receipt settlement evidence",
      message: "invalid settlement evidence",
    });
  }
};

const receiptResource = (receipt: Receipt): typeof ReceiptResource.Type => {
  const amountOre = Number(receipt.amountOre);

  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new ReceiptPersistenceError({
      operation: "decode receipt resource",
      message: "invalid amount",
    });
  }

  return {
    receiptId: receipt.receiptId,
    visualId: receipt.visualId,
    ownerPersonId: receipt.ownerPersonId,
    departmentId: receipt.departmentId,
    description: receipt.description,
    amountOre,
    currency: receipt.currency,
    receiptDate: receipt.receiptDate,
    status: receipt.status,
    submittedAt: receipt.submittedAt,
    approvedAt: receipt.approvedAt,
    revision: receipt.revision,
    etag: receiptEtag(receipt.receiptId, receipt.revision),
  };
};

export const ownedReceiptResource = (
  receipt: OwnedReceiptProjectionItem,
): typeof ReceiptListItem.Type => {
  const amountOre = Number(receipt.amountOre);

  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new ReceiptPersistenceError({
      operation: "decode owned receipt projection",
      message: "invalid amount",
    });
  }

  return {
    receiptId: receipt.receiptId,
    visualId: receipt.visualId,
    ownerPersonId: receipt.ownerPersonId,
    departmentId: receipt.departmentId,
    description: receipt.description,
    amountOre,
    currency: receipt.currency,
    receiptDate: receipt.receiptDate,
    status: receipt.status,
    approvedAt: receipt.approvedAt,
    settlement:
      receipt.settlement === null ? null : receiptSettlementEvidenceResource(receipt.settlement),
    revision: receipt.revision,
    etag: receiptEtag(receipt.receiptId, receipt.revision),
  };
};

/** A created receipt names its location; an updated one does not. */
export type ReceiptMutationStatus =
  | { readonly status: 200 }
  | { readonly status: 201; readonly location: string };

/**
 * The replayable response of one receipt mutation.
 */
export const receiptMutationCapsule = (
  receipt: Receipt,
  response: ReceiptMutationStatus,
): NativeHttpResponseCapsule => ({
  status: response.status,
  mediaType: "application/json",
  bodyBytes: new TextEncoder().encode(JSON.stringify(receiptResource(receipt))),
  headers:
    response.status === 201
      ? {
          "content-type": "application/json",
          etag: receiptEtag(receipt.receiptId, receipt.revision),
          location: response.location,
        }
      : {
          "content-type": "application/json",
          etag: receiptEtag(receipt.receiptId, receipt.revision),
        },
});

export const settlementMutationCapsule = (
  settlement: ReceiptSettlementEvidence,
  receipt: Receipt,
): NativeHttpResponseCapsule => ({
  status: 200,
  mediaType: "application/json",
  bodyBytes: new TextEncoder().encode(
    JSON.stringify(receiptSettlementEvidenceResource(settlement)),
  ),
  headers: {
    "content-type": "application/json",
    etag: receiptEtag(receipt.receiptId, receipt.revision),
  },
});

const receiptFileName = (contentType: ReceiptFile["contentType"]): string => {
  switch (contentType) {
    case "image/jpeg":
      return "receipt.jpg";
    case "image/png":
      return "receipt.png";
    case "application/pdf":
      return "receipt.pdf";
  }
};

/**
 * Answers verified private bytes with their exact headers; unreadable bytes are the receipt
 * store failing.
 */
export const readPrivateReceiptFile = (
  file: ReceiptFile,
  fileStore: ReceiptFileStore,
  maxFileBytes: number,
  extraHeaders: Readonly<Record<string, string>> = {},
) =>
  fileStore.readCommitted(file, maxFileBytes).pipe(
    Effect.mapError(() => Problem.make("receipts.unavailable")),
    Effect.map(
      (bytes) =>
        new Response(bytes, {
          headers: {
            ...extraHeaders,
            "content-type": file.contentType,
            "content-length": String(bytes.byteLength),
            "content-disposition": `inline; filename="${receiptFileName(file.contentType)}"`,
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
            vary: "Origin",
          },
        }),
    ),
  );
