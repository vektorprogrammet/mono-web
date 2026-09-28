/** Receipt representations: entity tags, resources, command capsules, and file contents. */
import {
  ReceiptPersistenceError,
  type OwnedReceiptProjectionItem,
  type Receipt,
  type ReceiptFile,
  type ReceiptSettlementEvidence,
} from "@vektorprogrammet/domain/receipt";
import {
  ReceiptSettlementEvidenceResource,
  type ReceiptFileContent,
  type ReceiptListItem,
  ReceiptResource,
} from "@vektorprogrammet/rpc";
import { Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Schema } from "effect";
import { deriveStrongETag, jsonBodyBytes } from "../http-semantics.js";
import type { NativeHttpResponseCapsule } from "../rpc/receipt-transaction.js";
import type { ReceiptFileStore } from "./filesystem.js";

/**
 * Projects stored rows onto response items. A stored value outside the response contract is the
 * receipt store failing; any other throw is a defect.
 */
export const projected = <A>(project: () => A): Effect.Effect<A, ReceiptPersistenceError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(project());
    } catch (cause) {
      return Schema.is(ReceiptPersistenceError)(cause) ? Effect.fail(cause) : Effect.die(cause);
    }
  });

/** The strong entity tag of one receipt revision, which its commands take as `ifMatch`. */
export const receiptEtag = (receipt: { readonly receiptId: string; readonly revision: number }) =>
  deriveStrongETag({
    representationKind: "ReceiptResource",
    resourceIdentity: receipt.receiptId,
    version: receipt.revision,
  });

export const receiptSettlementEvidenceResource = (
  settlement: ReceiptSettlementEvidence,
): typeof ReceiptSettlementEvidenceResource.Type => {
  const amountOre = Number(settlement.amountOre);

  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw ReceiptPersistenceError.make({
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
    throw ReceiptPersistenceError.make({
      operation: "decode receipt settlement evidence",
      message: "invalid settlement evidence",
    });
  }
};

const receiptResource = (receipt: Receipt): typeof ReceiptResource.Type => {
  const amountOre = Number(receipt.amountOre);

  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw ReceiptPersistenceError.make({
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
    etag: receiptEtag(receipt),
  };
};

export const ownedReceiptResource = (receipt: OwnedReceiptProjectionItem): ReceiptListItem => {
  const amountOre = Number(receipt.amountOre);

  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw ReceiptPersistenceError.make({
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
    etag: receiptEtag(receipt),
  };
};

/** A created receipt names its location; an updated one does not. */
export type ReceiptMutationStatus =
  | { readonly status: 200 }
  | { readonly status: 201; readonly location: string };

/**
 * The replayable receipt of one receipt mutation: the HTTP capsule byte for byte, so a retry that
 * straddles the cutover replays its first answer. Its body is the `ReceiptResource`, which
 * `commandOutcome(ReceiptResource)` decodes.
 */
export const receiptMutationCapsule = ({
  receipt,
  response,
}: {
  readonly receipt: Receipt;
  readonly response: ReceiptMutationStatus;
}): Effect.Effect<NativeHttpResponseCapsule, ReceiptPersistenceError> =>
  projected(() => receiptResource(receipt)).pipe(
    Effect.map(
      (resource): NativeHttpResponseCapsule => ({
        status: response.status,
        mediaType: "application/json",
        bodyBytes: jsonBodyBytes(resource),
        headers:
          response.status === 201
            ? {
                "content-type": "application/json",
                etag: resource.etag,
                location: response.location,
              }
            : { "content-type": "application/json", etag: resource.etag },
      }),
    ),
  );

/** The replayable receipt of a settlement: the evidence, under the settled receipt's tag. */
export const settlementMutationCapsule = ({
  settlement,
  receipt,
}: {
  readonly settlement: ReceiptSettlementEvidence;
  readonly receipt: Receipt;
}): Effect.Effect<NativeHttpResponseCapsule, ReceiptPersistenceError> =>
  projected(() => receiptSettlementEvidenceResource(settlement)).pipe(
    Effect.map((evidence) => ({
      status: 200,
      mediaType: "application/json",
      bodyBytes: jsonBodyBytes(evidence),
      headers: {
        "content-type": "application/json",
        etag: receiptEtag(receipt),
      },
    })),
  );

/** Reads verified private bytes; unreadable bytes are the receipt store failing. */
export const readPrivateReceiptFile = ({
  file,
  fileStore,
  maxFileBytes,
}: {
  readonly file: ReceiptFile;
  readonly fileStore: ReceiptFileStore;
  readonly maxFileBytes: number;
}): Effect.Effect<ReceiptFileContent, Problem<"receipts.unavailable">> =>
  fileStore.readCommitted(file, maxFileBytes).pipe(
    Effect.mapError(() => Problem.make("receipts.unavailable")),
    Effect.map((bytes) => ({ contentType: file.contentType, bytes })),
  );
