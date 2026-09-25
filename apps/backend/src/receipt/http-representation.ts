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
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { NativeHttpResponseCapsule } from "../http-api/receipt-transaction.js";
import { HttpSemanticFailure, deriveStrongETag } from "../http-semantics.js";
import type { ReceiptFileStore } from "./filesystem.js";

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
    return Schema.decodeUnknownSync(ReceiptSettlementEvidenceResource)({
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

export const receiptMutationCapsule = (
  receipt: Receipt,
  status: 200 | 201,
  location?: string,
): NativeHttpResponseCapsule => {
  const headers: NativeHttpResponseCapsule["headers"] = {
    "content-type": "application/json",
    etag: receiptEtag(receipt.receiptId, receipt.revision),
  };

  if (status === 201) {
    if (location === undefined) throw new HttpSemanticFailure("internal.error", 500);
    Object.assign(headers, { location });
  }

  return {
    status,
    mediaType: "application/json",
    bodyBytes: new TextEncoder().encode(JSON.stringify(receiptResource(receipt))),
    headers,
  };
};

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

export const readPrivateReceiptFile = (
  file: ReceiptFile,
  fileStore: ReceiptFileStore,
  maxFileBytes: number,
  extraHeaders: Readonly<Record<string, string>> = {},
) =>
  Effect.tryPromise({
    try: () => fileStore.readCommitted(file, maxFileBytes),
    catch: () => new HttpSemanticFailure("receipts.unavailable", 503),
  }).pipe(
    Effect.map((bytes) =>
      HttpServerResponse.uint8Array(bytes, {
        contentType: file.contentType,
        headers: {
          ...extraHeaders,
          "content-disposition": `inline; filename="${receiptFileName(file.contentType)}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
          vary: "Origin",
        },
      }),
    ),
  );
