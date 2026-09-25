/** Native HttpApi composition for receipt endpoints. */
import { ExternalNativeApi, InternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { webHandler } from "../http-api/problem.js";
import { receiptE2ETransactionBarrierFor } from "./e2e-support.js";
import { ReceiptFileStoreResource } from "./filesystem.js";
import {
  approvalCommand,
  reviseReceipt,
  settleReceipt,
  submitReceipt,
  withdrawReceipt,
} from "./http-commands.js";
import type { ReceiptApiHttpOptions, ReceiptIdentityFailure } from "./http-context.js";
import {
  listOwnedReceipts,
  listReceiptsForApproval,
  listReceiptsForSettlement,
  readApprovalReceiptFile,
  readOwnerReceiptFile,
  readReceiptLifecycleEvidence,
  readSettlementForFinance,
} from "./http-reads.js";

/** Native HttpApi implementations for receipt lifecycle endpoints. */
export const ReceiptApiHandlers = <E extends ReceiptIdentityFailure, R>(
  input: ReceiptApiHttpOptions<E, R>,
) =>
  HttpApiBuilder.group(ExternalNativeApi, "receipts", (handlers) =>
    Effect.gen(function* () {
      const fileStore = yield* ReceiptFileStoreResource;

      const barrier = yield* receiptE2ETransactionBarrierFor(input.config);

      return handlers
        .handleRaw("readReceiptFile", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            readOwnerReceiptFile(webRequest, params.receiptId, input, fileStore),
          ),
        )
        .handleRaw("readReceiptFileForApproval", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            readApprovalReceiptFile(webRequest, params.receiptId, input, fileStore, barrier),
          ),
        )
        .handleRaw("submitReceipt", ({ request }) =>
          webHandler(request, (webRequest) => submitReceipt(webRequest, input, fileStore)),
        )
        .handleRaw("reviseReceipt", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            reviseReceipt(webRequest, params.receiptId, input, fileStore),
          ),
        )
        .handleRaw("withdrawReceipt", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            withdrawReceipt(webRequest, params.receiptId, input, fileStore),
          ),
        )
        .handleRaw("listReceipts", ({ request }) =>
          webHandler(request, (webRequest) => listOwnedReceipts(webRequest, input)),
        )
        .handleRaw("listReceiptsForApproval", ({ request }) =>
          webHandler(request, (webRequest) => listReceiptsForApproval(webRequest, input)),
        )
        .handleRaw("listReceiptsForSettlement", ({ request }) =>
          webHandler(request, (webRequest) => listReceiptsForSettlement(webRequest, input)),
        )
        .handleRaw("readReceiptSettlementForFinance", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            readSettlementForFinance(webRequest, params.receiptId, input),
          ),
        )
        .handleRaw("settleReceipt", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            settleReceipt(webRequest, params.receiptId, input, fileStore),
          ),
        )
        .handleRaw("approveReceipt", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            approvalCommand(
              webRequest,
              { action: "approve", receiptId: params.receiptId },
              input,
              fileStore,
              barrier,
            ),
          ),
        )
        .handleRaw("rejectReceipt", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            approvalCommand(
              webRequest,
              { action: "reject", receiptId: params.receiptId },
              input,
              fileStore,
              barrier,
            ),
          ),
        )
        .handleRaw("reopenReceipt", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            approvalCommand(
              webRequest,
              { action: "reopen", receiptId: params.receiptId },
              input,
              fileStore,
              barrier,
            ),
          ),
        );
    }),
  );

/** Native HttpApi implementation for the internal receipt evidence endpoint. */
export const InternalReceiptApiHandlers = <E extends ReceiptIdentityFailure, R>(
  input: ReceiptApiHttpOptions<E, R>,
) =>
  HttpApiBuilder.group(InternalNativeApi, "internal", (handlers) =>
    Effect.succeed(
      handlers.handleRaw("readReceiptEvidence", ({ request, params }) =>
        webHandler(request, (webRequest) =>
          readReceiptLifecycleEvidence(webRequest, params.receiptId, input),
        ),
      ),
    ),
  );
