/**
 * Receipts: submission, revision, approval, settlement, and receipt files.
 *
 * The RPC tags keep the operation IDs of the HTTP contract they replace, and each command's
 * receipt keeps the old route path as its normalized target. A receipt file travels as bytes in
 * the payload or the success; the JSON serialization carries them as base64 text.
 *
 * @since 0.3.0
 */
import {
  CapabilityExpressionSchema,
  CapabilityTypeId,
  ConcealmentPolicySchema,
  CredentialMechanismSchema,
  INTERNAL_RECEIPT_EVIDENCE_ACCESS,
  RECEIPT_APPROVAL_QUEUE_ACCESS,
  makeAccessSpec,
} from "@vektorprogrammet/domain/authz";
import {
  RECEIPT_PAGE_SIZE,
  Receipt,
  ReceiptCursor,
  ReceiptId,
  ReceiptSettlementEvidenceSchema,
  ReceiptStatusSchema,
} from "@vektorprogrammet/domain/receipt";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential, PersonOrServiceCredential, SessionCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";
import {
  ReceiptResource,
  ReceiptSettlementEvidenceResource,
  RecordReceiptSettlementRequest,
} from "./v2-schemas.js";

export { ReceiptCursor, ReceiptId };

const settlementAccess = (
  canonicalScopeResolver: "receipts.settlement-queue" | "receipts.by-id",
  decisionTime: "SnapshotRead" | "Transaction",
) =>
  makeAccessSpec({
    exposure: "External",
    acceptedCredentials: [
      CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
      CredentialMechanismSchema.cases.OAuthUserBearer.make({}),
    ],
    principalKinds: ["Person"],
    capabilities: CapabilityExpressionSchema.cases.One.make({
      capability: { type: CapabilityTypeId.make("settleReceipt") },
    }),
    requirements: [],
    canonicalScopeResolver,
    concealment: ConcealmentPolicySchema.cases.NotFound.make({
      conceal: ["Capability", "Scope"],
    }),
    decisionTime,
  });

/** The media types of a receipt file. */
export const ReceiptFileMediaType = Schema.Literals(["image/jpeg", "image/png", "application/pdf"]);

export type ReceiptFileMediaType = typeof ReceiptFileMediaType.Type;

/**
 * One uploaded receipt file. The handler checks its media type and its byte bound, and answers
 * validation.failed for a file outside them, as the multipart reader did.
 */
export const ReceiptFileUpload = Schema.Struct({
  contentType: Schema.String,
  bytes: Schema.Uint8Array,
}).annotate({ identifier: "ReceiptFileUpload" });

export type ReceiptFileUpload = typeof ReceiptFileUpload.Type;

/**
 * A new receipt. The handler checks each field as the multipart reader did: a description of 1 to
 * 5 000 characters, a positive safe integer amount in øre, and a calendar date `YYYY-MM-DD`.
 */
export const SubmitReceiptRequest = Schema.Struct({
  description: Schema.String,
  amountOre: Schema.Finite,
  receiptDate: Schema.String,
  file: ReceiptFileUpload,
}).annotate({ identifier: "SubmitReceiptRequest" });

export type SubmitReceiptRequest = typeof SubmitReceiptRequest.Type;

/** A revision of a pending receipt: the fields that it changes, at least one. */
export const ReviseReceiptRequest = Schema.Struct({
  description: Schema.optional(Schema.String),
  amountOre: Schema.optional(Schema.Finite),
  receiptDate: Schema.optional(Schema.String),
  file: Schema.optional(ReceiptFileUpload),
}).annotate({ identifier: "ReviseReceiptRequest" });

export type ReviseReceiptRequest = typeof ReviseReceiptRequest.Type;

/** The verified private bytes of one receipt file, with their stored media type. */
export const ReceiptFileContent = Schema.Struct({
  contentType: ReceiptFileMediaType,
  bytes: Schema.Uint8Array,
}).annotate({ identifier: "ReceiptFileContent" });

export type ReceiptFileContent = typeof ReceiptFileContent.Type;

/** Owner receipt projection. */
export const ReceiptListItem = Schema.Struct({
  receiptId: Schema.String,
  visualId: Schema.String,
  ownerPersonId: Schema.String,
  departmentId: Schema.String,
  amountOre: Schema.Int,
  currency: Schema.Literals(["NOK"]),
  description: Schema.String,
  receiptDate: Schema.String,
  status: ReceiptStatusSchema,
  revision: Schema.Int,
  approvedAt: Receipt.json.fields.approvedAt,
  settlement: Schema.NullOr(ReceiptSettlementEvidenceSchema),
  etag: StrongETag,
}).annotate({
  identifier: "ReceiptListItem",
  description: "Owner receipt projection.",
});

export type ReceiptListItem = typeof ReceiptListItem.Type;

/** One bounded page of the caller's own receipts, and its continuation. */
export const ReceiptListResponse = Schema.Struct({
  items: Schema.Array(ReceiptListItem).pipe(Schema.check(Schema.isMaxLength(RECEIPT_PAGE_SIZE))),
  nextCursor: Schema.optional(ReceiptCursor),
}).annotate({
  identifier: "ReceiptListResponse",
  description: "One bounded receipt page and optional continuation.",
});

export const ReceiptApprovalQueueItem = Schema.Struct({
  receiptId: Schema.String,
  visualId: Schema.String,
  ownerPersonId: Schema.String,
  departmentId: Schema.String,
  amountOre: Schema.Int,
  currency: Schema.Literals(["NOK"]),
  description: Schema.String,
  receiptDate: Schema.String,
  status: ReceiptStatusSchema,
  revision: Schema.Int,
  etag: StrongETag,
  approvedAt: Receipt.json.fields.approvedAt,
}).annotate({
  identifier: "ReceiptApprovalQueueItem",
  description: "One receipt visible in the current approver queue.",
});

export type ReceiptApprovalQueueItem = typeof ReceiptApprovalQueueItem.Type;

export const ReceiptApprovalQueueResponse = Schema.Struct({
  items: Schema.Array(ReceiptApprovalQueueItem).pipe(
    Schema.check(Schema.isMaxLength(RECEIPT_PAGE_SIZE)),
  ),
  nextCursor: Schema.optional(ReceiptCursor),
}).annotate({
  identifier: "ReceiptApprovalQueueResponse",
  description: "One bounded page of receipts in the current approver queue.",
});

export const ReceiptSettlementQueueItem = Schema.Struct({
  receiptId: Schema.String,
  visualId: Schema.String,
  ownerPersonId: Schema.String,
  departmentId: Schema.String,
  amountOre: Schema.Int,
  currency: Schema.Literal("NOK"),
  description: Schema.String,
  receiptDate: Schema.String,
  status: Schema.Literal("Approved"),
  approvedAt: Schema.String,
  revision: Schema.Int,
  etag: StrongETag,
}).annotate({
  identifier: "ReceiptSettlementQueueItem",
  description: "One approved, unsettled receipt visible in the current settlement scope.",
});

export type ReceiptSettlementQueueItem = typeof ReceiptSettlementQueueItem.Type;

export const ReceiptSettlementQueueResponse = Schema.Struct({
  items: Schema.Array(ReceiptSettlementQueueItem).pipe(
    Schema.check(Schema.isMaxLength(RECEIPT_PAGE_SIZE)),
  ),
  nextCursor: Schema.optional(ReceiptCursor),
}).annotate({
  identifier: "ReceiptSettlementQueueResponse",
  description: "One bounded page of approved, unsettled receipts in the current settlement scope.",
});

/** Internal receipt file, outbox, and audit lifecycle evidence. */
export const ReceiptLifecycleEvidenceResponse = Schema.Struct({
  receiptId: Schema.String,
  file: Schema.Struct({
    fileRef: Schema.String,
    objectKey: Schema.String,
    contentType: Schema.String,
    byteLength: Schema.Int,
    sha256: Schema.String,
  }),
  settlement: Schema.NullOr(ReceiptSettlementEvidenceSchema),
  outbox: Schema.Array(
    Schema.Struct({
      effectId: Schema.String,
      effectType: Schema.String,
      commandId: Schema.String,
      receiptId: Schema.String,
      ordinal: Schema.Int,
      status: Schema.String,
      attempts: Schema.Int,
      lastFailureTag: Schema.NullOr(Schema.String),
    }),
  ),
  audit: Schema.Array(
    Schema.Struct({
      commandId: Schema.String,
      receiptId: Schema.String,
      action: Schema.String,
      receiptRevision: Schema.Int,
    }),
  ),
}).annotate({
  identifier: "ReceiptLifecycleEvidenceResponse",
  description: "E2E-only receipt file, outbox, and audit evidence.",
});

/**
 * The payload of a command on one existing receipt whose HTTP body was the exact empty object.
 * Its request digest still covers that empty body, so a replay across the cutover matches.
 */
export const ReceiptTransitionPayload = Schema.Struct({
  receiptId: ReceiptId,
  idempotencyKey: IdempotencyKey,
  ifMatch: StrongETag,
}).annotate({ identifier: "ReceiptTransitionPayload" });

const ReceiptById = Schema.Struct({ receiptId: ReceiptId });

const receiptListQuery = {
  cursor: Schema.optional(ReceiptCursor),
  status: Schema.optional(ReceiptStatusSchema),
};

const transitionProblems = [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "precondition.failed",
  "internal.error",
  "dependency.unavailable",
  "receipts.unavailable",
  "idempotency.unavailable",
  "transaction.conflict",
  "receipt.not-found",
  "receipt.invalid-transition",
] as const;

const readProblems = [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "receipts.unavailable",
] as const;

export const SubmitReceiptProblem = problemUnion("SubmitReceiptProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "validation.failed",
  "internal.error",
  "dependency.unavailable",
  "receipts.unavailable",
  "idempotency.unavailable",
  "transaction.conflict",
  "receipt.already-exists",
  "receipt.file-not-staged",
]);

export const ReviseReceiptProblem = problemUnion("ReviseReceiptProblem", [
  ...transitionProblems,
  "validation.failed",
  "receipt.file-not-staged",
]);

export const ReceiptTransitionProblem = problemUnion("ReceiptTransitionProblem", [
  ...transitionProblems,
]);

export const SettleReceiptProblem = problemUnion("SettleReceiptProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "validation.failed",
  "settlement.after-recorded-at",
  "precondition.failed",
  "receipt.already-settled",
  "receipt.invalid-transition",
  "settlement.external-reference-conflict",
  "receipt.not-found",
  "internal.error",
  "dependency.unavailable",
  "receipts.unavailable",
  "idempotency.unavailable",
  "transaction.conflict",
]);

export const ListReceiptsProblem = problemUnion("ListReceiptsProblem", [...readProblems]);

export const ReadReceiptSettlementProblem = problemUnion("ReadReceiptSettlementProblem", [
  ...readProblems,
  "receipt.not-found",
]);

export const ReadReceiptFileProblem = problemUnion("ReadReceiptFileProblem", [
  ...readProblems,
  "resource.not-found",
]);

export const ReadReceiptEvidenceProblem = problemUnion("ReadReceiptEvidenceProblem", [
  ...readProblems,
  "receipt.not-found",
]);

/** Stages a receipt file and submits the receipt, or replays it by its idempotency key. */
export const SubmitReceipt = Rpc.make("receipts.submitReceipt", {
  payload: Schema.Struct({
    idempotencyKey: IdempotencyKey,
    departmentId: Schema.optional(Schema.String),
    request: SubmitReceiptRequest,
  }),
  success: ReceiptResource,
  error: rpcProblems(SubmitReceiptProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "submitReceipt",
        canonicalScopeResolver: "receipts.create",
        decisionTime: "Transaction",
      }),
    ),
  );

/** Revises a pending owned receipt, and optionally replaces its file. */
export const ReviseReceipt = Rpc.make("receipts.reviseReceipt", {
  payload: Schema.Struct({
    receiptId: ReceiptId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: ReviseReceiptRequest,
  }),
  success: ReceiptResource,
  error: rpcProblems(ReviseReceiptProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "receipts.manage-owned",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.owner", "receipts.pending"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Withdraws a pending receipt that the caller owns. */
export const WithdrawReceipt = Rpc.make("receipts.withdrawReceipt", {
  payload: ReceiptTransitionPayload,
  success: ReceiptResource,
  error: rpcProblems(ReceiptTransitionProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "receipts.manage-owned",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.owner", "receipts.pending"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Lists the receipts that the caller owns. */
export const ListReceipts = Rpc.make("receipts.listReceipts", {
  payload: Schema.Struct(receiptListQuery),
  success: ReceiptListResponse,
  error: rpcProblems(ListReceiptsProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "receipts.read-owned",
        canonicalScopeResolver: "receipts.owned",
        requirements: ["receipts.owner"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** The verified private bytes of a receipt file, for its canonical owner only. */
export const ReadReceiptFile = Rpc.make("receipts.readReceiptFile", {
  payload: ReceiptById,
  success: ReceiptFileContent,
  error: rpcProblems(ReadReceiptFileProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "receipts.read-owned",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.owner"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * The verified private bytes of a receipt file, for the current scoped approver. A terminal
 * receipt's file stays readable while the rule-aware approver relationship stays active.
 */
export const ReadReceiptFileForApproval = Rpc.make("receipts.readReceiptFileForApproval", {
  payload: ReceiptById,
  success: ReceiptFileContent,
  error: rpcProblems(ReadReceiptFileProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "approveReceipt",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.approver-relationship"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Lists the receipts in the caller's approval scope. */
export const ListReceiptsForApproval = Rpc.make("receipts.listReceiptsForApproval", {
  payload: Schema.Struct(receiptListQuery),
  success: ReceiptApprovalQueueResponse,
  error: rpcProblems(ListReceiptsProblem),
})
  .middleware(PersonOrServiceCredential)
  .pipe(withAccessSpec(RECEIPT_APPROVAL_QUEUE_ACCESS));

/** Lists the approved, unsettled receipts visible to the caller's settlement grant. */
export const ListReceiptsForSettlement = Rpc.make("receipts.listReceiptsForSettlement", {
  payload: Schema.Struct({ cursor: Schema.optional(ReceiptCursor) }),
  success: ReceiptSettlementQueueResponse,
  error: rpcProblems(ListReceiptsProblem),
})
  .middleware(PersonCredential)
  .pipe(withAccessSpec(settlementAccess("receipts.settlement-queue", "SnapshotRead")));

/** Reads the immutable settlement evidence visible to the caller's settlement grant. */
export const ReadReceiptSettlementForFinance = Rpc.make(
  "receipts.readReceiptSettlementForFinance",
  {
    payload: ReceiptById,
    success: ReceiptSettlementEvidenceResource,
    error: rpcProblems(ReadReceiptSettlementProblem),
  },
)
  .middleware(PersonCredential)
  .pipe(withAccessSpec(settlementAccess("receipts.by-id", "SnapshotRead")));

/** Records immutable evidence of an externally settled approved receipt. */
export const SettleReceipt = Rpc.make("receipts.settleReceipt", {
  payload: Schema.Struct({
    receiptId: ReceiptId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: RecordReceiptSettlementRequest,
  }),
  success: ReceiptSettlementEvidenceResource,
  error: rpcProblems(SettleReceiptProblem),
})
  .middleware(PersonCredential)
  .pipe(withAccessSpec(settlementAccess("receipts.by-id", "Transaction")));

/** Approves a pending receipt. */
export const ApproveReceipt = Rpc.make("receipts.approveReceipt", {
  payload: ReceiptTransitionPayload,
  success: ReceiptResource,
  error: rpcProblems(ReceiptTransitionProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "approveReceipt",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.pending", "receipts.approver-relationship"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Rejects a pending receipt. */
export const RejectReceipt = Rpc.make("receipts.rejectReceipt", {
  payload: ReceiptTransitionPayload,
  success: ReceiptResource,
  error: rpcProblems(ReceiptTransitionProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "approveReceipt",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.pending", "receipts.approver-relationship"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Reopens a rejected receipt for the owner's correction. */
export const ReopenReceipt = Rpc.make("receipts.reopenReceipt", {
  payload: ReceiptTransitionPayload,
  success: ReceiptResource,
  error: rpcProblems(ReceiptTransitionProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "approveReceipt",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.rejected", "receipts.approver-relationship"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Reads E2E-only receipt lifecycle evidence. Only the internal ingress serves it. */
export const ReadReceiptEvidence = Rpc.make("receipts.readReceiptEvidence", {
  payload: ReceiptById,
  success: ReceiptLifecycleEvidenceResponse,
  error: rpcProblems(ReadReceiptEvidenceProblem),
})
  .middleware(SessionCredential)
  .pipe(withAccessSpec(INTERNAL_RECEIPT_EVIDENCE_ACCESS));

export class ReceiptsRpcs extends RpcGroup.make(
  ReadReceiptFile,
  ReadReceiptFileForApproval,
  SubmitReceipt,
  ReviseReceipt,
  WithdrawReceipt,
  ListReceipts,
  ListReceiptsForApproval,
  ApproveReceipt,
  ListReceiptsForSettlement,
  ReadReceiptSettlementForFinance,
  SettleReceipt,
  RejectReceipt,
  ReopenReceipt,
) {}

/** Internal receipt operations, served only on the internal ingress. */
export class InternalReceiptsRpcs extends RpcGroup.make(ReadReceiptEvidence) {}
