/** Native HttpApi composition for receipt endpoints. */
import { ExternalNativeApi, InternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
import { receiptE2ETransactionBarrierFor } from "./e2e-support.js";
import { ReceiptFileStoreResource } from "./filesystem.js";
import {
  approvalCommand,
  reviseReceipt,
  settleReceipt,
  submitReceipt,
  withdrawReceipt,
} from "./http-commands.js";
import type { ReceiptApiHttpOptions } from "./http-context.js";
import { internalReceiptErrorResponse, publicReceiptErrorResponse } from "./http-problem.js";
import {
  listOwnedReceipts,
  listReceiptsForApproval,
  listReceiptsForSettlement,
  readApprovalReceiptFile,
  readOwnerReceiptFile,
  readReceiptLifecycleEvidence,
  readSettlementForFinance,
} from "./http-reads.js";

const toPrivateFileHttpApiResponse = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  handle: (request: Request) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap(handle),
    Effect.catch((cause) =>
      Effect.succeed(HttpServerResponse.fromWeb(publicReceiptErrorResponse(cause))),
    ),
  );

/** Native HttpApi implementations for receipt lifecycle endpoints. */
export const ReceiptApiHandlers = <E, R>(input: ReceiptApiHttpOptions<E, R>) =>
  HttpApiBuilder.group(ExternalNativeApi, "receipts", (handlers) =>
    Effect.gen(function* () {
      const fileStore = yield* ReceiptFileStoreResource;

      const barrier = yield* receiptE2ETransactionBarrierFor(input.config);

      return handlers
        .handleRaw("readReceiptFile", ({ request, params }) =>
          toPrivateFileHttpApiResponse(request, (webRequest) =>
            readOwnerReceiptFile(webRequest, params.receiptId, input, fileStore),
          ),
        )
        .handleRaw("readReceiptFileForApproval", ({ request, params }) =>
          toPrivateFileHttpApiResponse(request, (webRequest) =>
            readApprovalReceiptFile(webRequest, params.receiptId, input, fileStore, barrier),
          ),
        )
        .handleRaw("submitReceipt", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => submitReceipt(webRequest, input, fileStore),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("reviseReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseReceipt(webRequest, params.receiptId, input, fileStore),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("withdrawReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => withdrawReceipt(webRequest, params.receiptId, input, fileStore),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("listReceipts", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listOwnedReceipts(webRequest, input),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("listReceiptsForApproval", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listReceiptsForApproval(webRequest, input),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("listReceiptsForSettlement", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listReceiptsForSettlement(webRequest, input),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("readReceiptSettlementForFinance", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readSettlementForFinance(webRequest, params.receiptId, input),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("settleReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => settleReceipt(webRequest, params.receiptId, input, fileStore),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("approveReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              approvalCommand(
                webRequest,
                { action: "approve", receiptId: params.receiptId },
                input,
                fileStore,
                barrier,
              ),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("rejectReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              approvalCommand(
                webRequest,
                { action: "reject", receiptId: params.receiptId },
                input,
                fileStore,
                barrier,
              ),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("reopenReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              approvalCommand(
                webRequest,
                { action: "reopen", receiptId: params.receiptId },
                input,
                fileStore,
                barrier,
              ),
            publicReceiptErrorResponse,
          ),
        );
    }),
  );

/** Native HttpApi implementation for the internal receipt evidence endpoint. */
export const InternalReceiptApiHandlers = <E, R>(input: ReceiptApiHttpOptions<E, R>) =>
  HttpApiBuilder.group(InternalNativeApi, "internal", (handlers) =>
    Effect.succeed(
      handlers.handleRaw("readReceiptEvidence", ({ request, params }) =>
        toHttpApiResponse(
          request,
          (webRequest) => readReceiptLifecycleEvidence(webRequest, params.receiptId, input),
          internalReceiptErrorResponse,
        ),
      ),
    ),
  );
