/**
 * Public and internal HTTP contracts for receipt lifecycle operations.
 *
 * @since 0.1.0
 */
import {
  INTERNAL_RECEIPT_EVIDENCE_ACCESS,
  RECEIPT_APPROVAL_QUEUE_ACCESS,
} from "@vektorprogrammet/domain/authz";
import { ReceiptId, ReceiptStatusSchema } from "@vektorprogrammet/domain/receipt";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, personNativeAccess } from "./access.js";
import {
  operationAnnotations,
  PersonOrServiceSecurity,
  PersonSecurity,
  SessionSecurity,
} from "./common.js";
import {
  InternalReadReceiptEvidenceProblem,
  ReceiptsListReceiptsForApprovalProblem,
  ReceiptsListReceiptsProblem,
  ReceiptsRefundReceiptProblem,
  ReceiptsRejectReceiptProblem,
  ReceiptsReviseReceiptProblem,
  ReceiptsSubmitReceiptProblem,
  ReceiptsWithdrawReceiptProblem,
} from "./endpoint-problems.js";
import {
  createdMutationResponse,
  endpointProblemResponses,
  entityMutationResponse,
  IdempotencyHeaders,
  IdempotencyIfMatchHeaders,
  internalNoStoreResponse,
  privateReadResponse,
  StrongETag,
} from "./http-semantics.js";
import {
  ReceiptResource,
  RefundReceiptRequest,
  RejectReceiptRequest,
  ReviseReceiptMultipartV2,
  SubmitReceiptMultipartV2,
  WithdrawReceiptRequest,
} from "./v2-schemas.js";

/**
 * Receipt list projection item.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ReceiptListItemExample = {
  receiptId: "receipt-list",
  visualId: "LIST-1",
  ownerPersonId: "owner-list",
  departmentId: "1",
  amountOre: 1250,
  currency: "NOK",
  description: "list row",
  receiptDate: "2026-08-24",
  status: "Pending",
  revision: 2,
  etag: StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'),
} as const;

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
  etag: StrongETag,
}).annotate({
  identifier: "ReceiptListItem",
  description: "Owner or approver receipt projection.",
  examples: [
    {
      receiptId: "receipt-list",
      visualId: "LIST-1",
      ownerPersonId: "owner-list",
      departmentId: "1",
      amountOre: 1250,
      currency: "NOK",
      description: "list row",
      receiptDate: "2026-08-24",
      status: "Pending",
      revision: 2,
      etag: StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'),
    },
  ],
});

/**
 * Receipt list envelope.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ReceiptListResponse = Schema.Struct({
  items: Schema.Array(ReceiptListItem),
  totalItems: Schema.Int,
}).annotate({
  identifier: "ReceiptListResponse",
  description: "Receipts and matching total count.",
  examples: [
    {
      items: [ReceiptListItemExample],
      totalItems: 1,
    },
  ],
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
}).annotate({
  identifier: "ReceiptApprovalQueueItem",
  description: "One receipt visible in the current approver queue.",
});

export const ReceiptApprovalQueueResponse = Schema.Struct({
  items: Schema.Array(ReceiptApprovalQueueItem),
  totalItems: Schema.Int,
}).annotate({
  identifier: "ReceiptApprovalQueueResponse",
  description: "Receipts in the current approver queue and their count.",
});

/**
 * Internal receipt file/outbox/audit lifecycle evidence.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ReceiptLifecycleEvidenceResponse = Schema.Struct({
  receiptId: Schema.String,
  file: Schema.Struct({
    fileRef: Schema.String,
    objectKey: Schema.String,
    contentType: Schema.String,
    byteLength: Schema.Int,
    sha256: Schema.String,
  }),
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

const ReceiptStatusQuery = {
  status: Schema.optional(ReceiptStatusSchema),
};
const OwnerReceiptStatusQuery = {
  status: Schema.optional(Schema.Union([ReceiptStatusSchema, Schema.Array(ReceiptStatusSchema)])),
};
const ReceiptParams = { receiptId: ReceiptId };

/** @since 0.1.0 @category Endpoints */
export const SubmitReceiptEndpoint = HttpApiEndpoint.post("submitReceipt", "/api/receipts", {
  query: { departmentId: Schema.optional(Schema.String) },
  headers: IdempotencyHeaders,
  payload: SubmitReceiptMultipartV2,
  success: createdMutationResponse(ReceiptResource.pipe(HttpApiSchema.status(201))),
  error: endpointProblemResponses(ReceiptsSubmitReceiptProblem),
})
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "submitReceipt",
        canonicalScopeResolver: "receipts.create",
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Submit receipt",
      "Stages a receipt file and submits an idempotent command.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ReviseReceiptEndpoint = HttpApiEndpoint.patch(
  "reviseReceipt",
  "/api/receipts/:receiptId",
  {
    params: ReceiptParams,
    headers: IdempotencyIfMatchHeaders,
    payload: ReviseReceiptMultipartV2,
    success: entityMutationResponse(ReceiptResource),
    error: endpointProblemResponses(ReceiptsReviseReceiptProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "receipts.manage-owned",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.owner", "receipts.pending"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("Revise receipt", "Revises a pending owned receipt and optional file."),
  );

/** @since 0.1.0 @category Endpoints */
export const WithdrawReceiptEndpoint = HttpApiEndpoint.post(
  "withdrawReceipt",
  "/api/receipts/:receiptId([^:]+)::withdraw",
  {
    params: ReceiptParams,
    headers: IdempotencyIfMatchHeaders,
    payload: WithdrawReceiptRequest,
    success: entityMutationResponse(ReceiptResource),
    error: endpointProblemResponses(ReceiptsWithdrawReceiptProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "receipts.manage-owned",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.owner", "receipts.pending"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Withdraw receipt",
      "Withdraws a pending receipt owned by the current person.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ListReceiptsEndpoint = HttpApiEndpoint.get("listReceipts", "/api/receipts", {
  query: OwnerReceiptStatusQuery,
  success: privateReadResponse(ReceiptListResponse),
  error: endpointProblemResponses(ReceiptsListReceiptsProblem),
})
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "receipts.read-owned",
        canonicalScopeResolver: "receipts.owned",
        requirements: ["receipts.owner"],
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("List owned receipts", "Lists receipts owned by the current person."),
  );

/** @since 0.1.0 @category Endpoints */
export const ListReceiptsForApprovalEndpoint = HttpApiEndpoint.get(
  "listReceiptsForApproval",
  "/api/receipt-approval-queue",
  {
    query: ReceiptStatusQuery,
    success: privateReadResponse(ReceiptApprovalQueueResponse),
    error: endpointProblemResponses(ReceiptsListReceiptsForApprovalProblem),
  },
)
  .middleware(PersonOrServiceSecurity)
  .pipe((endpoint) => annotateAccessSpec(endpoint, RECEIPT_APPROVAL_QUEUE_ACCESS))
  .annotateMerge(
    operationAnnotations(
      "List receipts for approval",
      "Lists receipts in the caller's approval scope.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const RefundReceiptEndpoint = HttpApiEndpoint.post(
  "refundReceipt",
  "/api/receipts/:receiptId([^:]+)::refund",
  {
    params: ReceiptParams,
    headers: IdempotencyIfMatchHeaders,
    payload: RefundReceiptRequest,
    success: entityMutationResponse(ReceiptResource),
    error: endpointProblemResponses(ReceiptsRefundReceiptProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "approveReceipt",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.pending", "receipts.approver-relationship"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(operationAnnotations("Refund receipt", "Approves a pending receipt for refund."));

/** @since 0.1.0 @category Endpoints */
export const RejectReceiptEndpoint = HttpApiEndpoint.post(
  "rejectReceipt",
  "/api/receipts/:receiptId([^:]+)::reject",
  {
    params: ReceiptParams,
    headers: IdempotencyIfMatchHeaders,
    payload: RejectReceiptRequest,
    success: entityMutationResponse(ReceiptResource),
    error: endpointProblemResponses(ReceiptsRejectReceiptProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "approveReceipt",
        canonicalScopeResolver: "receipts.by-id",
        requirements: ["receipts.pending", "receipts.approver-relationship"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(operationAnnotations("Reject receipt", "Rejects a pending receipt."));

/**
 * Owner and approver receipt API.
 *
 * @since 0.1.0
 * @category Groups
 */
export class ReceiptsApi extends HttpApiGroup.make("receipts")
  .add(
    SubmitReceiptEndpoint,
    ReviseReceiptEndpoint,
    WithdrawReceiptEndpoint,
    ListReceiptsEndpoint,
    ListReceiptsForApprovalEndpoint,
    RefundReceiptEndpoint,
    RejectReceiptEndpoint,
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Receipts",
      description: "Receipt owner lifecycle and scoped approval operations.",
    }),
  ) {}

/** @since 0.1.0 @category Endpoints */
export const ReadReceiptEvidenceEndpoint = annotateAccessSpec(
  HttpApiEndpoint.get("readReceiptEvidence", "/api/receipt-lifecycle-evidence-records/:receiptId", {
    params: ReceiptParams,
    success: internalNoStoreResponse(ReceiptLifecycleEvidenceResponse),
    error: endpointProblemResponses(InternalReadReceiptEvidenceProblem, { cors: false }),
  })
    .middleware(SessionSecurity)
    .annotateMerge(
      operationAnnotations("Read receipt evidence", "Reads E2E-only receipt lifecycle evidence."),
    ),
  INTERNAL_RECEIPT_EVIDENCE_ACCESS,
);

/**
 * Internal evidence routes exist only in `InternalNativeApi`.
 * @since 0.1.0
 * @category Groups
 */
export class InternalReceiptsApi extends HttpApiGroup.make("internal")
  .add(ReadReceiptEvidenceEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Internal evidence",
      description: "E2E-only evidence operations.",
      exclude: true,
    }),
  ) {}
