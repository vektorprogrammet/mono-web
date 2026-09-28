/**
 * The ReceiptsRpcs and InternalReceiptsRpcs handlers.
 *
 * Reads resolve the caller at one instant, as the HTTP handlers did; the file reads resolve the
 * credential and evaluate owner or approver authority in one repeatable-read snapshot. Commands
 * resolve the credential and authorize the mutation inside the serializable transaction that
 * commits them (`commands.ts`). The receipt file store is composed here, from the options, as the
 * HTTP composition did.
 */
import { InternalReceiptsRpcs, ReceiptsRpcs } from "@vektorprogrammet/rpc";
import { Effect, Layer } from "effect";
import type { NativeRpcOptions } from "../rpc/options.js";
import { unreachable } from "../rpc/problem.js";
import {
  approvalCommand,
  reviseReceipt,
  settleReceipt,
  submitReceipt,
  withdrawReceipt,
} from "./commands.js";
import { receiptE2ETransactionBarrierFor } from "./e2e-support.js";
import { ReceiptFileStoreLive, ReceiptFileStoreResource } from "./filesystem.js";
import {
  listOwnedReceipts,
  listReceiptsForApproval,
  listReceiptsForSettlement,
  readApprovalReceiptFile,
  readOwnerReceiptFile,
  readReceiptLifecycleEvidence,
  readSettlementForFinance,
} from "./reads.js";

/** The composition-owned private receipt store, or the filesystem store of the receipt config. */
const receiptFileStoreLayer = (options: NativeRpcOptions) => {
  const config = options.config.receipt;

  return options.receiptFileStore === undefined
    ? ReceiptFileStoreLive({
        stagingRoot: config.stagingRoot,
        committedRoot: config.committedRoot,
        failNextPromotionEffectId: config.e2e?.failNextPromotionEffectId,
      })
    : Layer.succeed(ReceiptFileStoreResource, options.receiptFileStore);
};

/** The ReceiptsRpcs handlers. */
export const ReceiptsRpcHandlers = (options: NativeRpcOptions) =>
  ReceiptsRpcs.toLayer(
    Effect.gen(function* () {
      const fileStore = yield* ReceiptFileStoreResource;
      const barrier = yield* receiptE2ETransactionBarrierFor(options.config.receipt);

      return ReceiptsRpcs.of({
        "receipts.readReceiptFile": ({ receiptId }, { headers }) =>
          readOwnerReceiptFile({ context: { headers, options, fileStore }, receiptId }),

        "receipts.readReceiptFileForApproval": ({ receiptId }, { headers }) =>
          readApprovalReceiptFile({
            context: { headers, options, fileStore },
            receiptId,
            barrier,
          }).pipe(
            // A barrier probe that names another lane or receipt is a defect of the test driver.
            unreachable("request.malformed"),
          ),

        "receipts.submitReceipt": (payload, { headers }) =>
          submitReceipt({ context: { headers, options, fileStore }, payload }),

        "receipts.reviseReceipt": (payload, { headers }) =>
          reviseReceipt({ context: { headers, options, fileStore }, payload }),

        "receipts.withdrawReceipt": (payload, { headers }) =>
          withdrawReceipt({ context: { headers, options, fileStore }, payload }),

        "receipts.listReceipts": (query, { headers }) =>
          listOwnedReceipts({ caller: { headers, options }, query }),

        "receipts.listReceiptsForApproval": (query, { headers }) =>
          listReceiptsForApproval({ caller: { headers, options }, query }),

        "receipts.approveReceipt": (payload, { headers }) =>
          approvalCommand({
            context: { headers, options, fileStore },
            action: "approve",
            payload,
            barrier,
          }),

        "receipts.listReceiptsForSettlement": ({ cursor }, { headers }) =>
          listReceiptsForSettlement({ caller: { headers, options }, cursor }),

        "receipts.readReceiptSettlementForFinance": ({ receiptId }, { headers }) =>
          readSettlementForFinance({ caller: { headers, options }, receiptId }),

        "receipts.settleReceipt": (payload, { headers }) =>
          settleReceipt({ context: { headers, options, fileStore }, payload }),

        "receipts.rejectReceipt": (payload, { headers }) =>
          approvalCommand({
            context: { headers, options, fileStore },
            action: "reject",
            payload,
            barrier,
          }),

        "receipts.reopenReceipt": (payload, { headers }) =>
          approvalCommand({
            context: { headers, options, fileStore },
            action: "reopen",
            payload,
            barrier,
          }),
      });
    }),
  ).pipe(Layer.provide(receiptFileStoreLayer(options)));

/** The InternalReceiptsRpcs handlers, which only the internal ingress serves. */
export const InternalReceiptsRpcHandlers = (options: NativeRpcOptions) =>
  InternalReceiptsRpcs.toLayer({
    "receipts.readReceiptEvidence": ({ receiptId }, { headers }) =>
      readReceiptLifecycleEvidence({ caller: { headers, options }, receiptId }),
  });
