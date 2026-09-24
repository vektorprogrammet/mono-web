import { Database } from "../service.js";
import { Effect, Layer } from "effect";
import {
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "./outbox.js";
import {
  authorizeReceiptMutation,
  executeAuthorizedReceiptCommand,
  executeReceiptCommand,
  listReceiptsForApproval as listReceiptsForApprovalPostgres,
  readReceiptFileForApproval as readReceiptFileForApprovalPostgres,
} from "./postgres.js";
import {
  readReceiptSettlementRevision,
  listReceiptsForSettlement,
  readReceiptSettlementForFinance,
  recordReceiptSettlement,
} from "./settlement.js";
import {
  listOwnedReceiptProjection,
  readReceiptLifecycleEvidence,
  receiptStatusTotals,
} from "./projections.js";
import { Economy } from "@vektorprogrammet/domain/receipt";

export const EconomyLive = Layer.effect(
  Economy,
  Effect.gen(function* () {
    const database = yield* Database;

    return Economy.of({
      executeReceipt: (input, principal, allocation) =>
        executeReceiptCommand(input, principal, allocation).pipe(
          Effect.provideService(Database, database),
        ),
      authorizeReceiptMutation: (target, principal) =>
        authorizeReceiptMutation(target, principal).pipe(Effect.provideService(Database, database)),
      executeAuthorizedReceipt: (input, authorization, allocation) =>
        executeAuthorizedReceiptCommand(input, authorization, allocation).pipe(
          Effect.provideService(Database, database),
        ),
      readReceiptSettlementRevision: (receiptId, principal) =>
        readReceiptSettlementRevision(receiptId, principal).pipe(
          Effect.provideService(Database, database),
        ),
      recordReceiptSettlement: (input, principal) =>
        recordReceiptSettlement(input, principal).pipe(Effect.provideService(Database, database)),
      listOwnedReceipts: (ownerPersonId, status) =>
        listOwnedReceiptProjection(ownerPersonId, status).pipe(
          Effect.provideService(Database, database),
        ),
      listReceiptsForApproval: (personId, authorizationInstant, status) =>
        listReceiptsForApprovalPostgres(personId, authorizationInstant, status).pipe(
          Effect.provideService(Database, database),
        ),
      listReceiptsForSettlement: (personId, authorizationInstant) =>
        listReceiptsForSettlement(personId, authorizationInstant).pipe(
          Effect.provideService(Database, database),
        ),
      readReceiptFileForApproval: (receiptId, personId, authorizationInstant) =>
        readReceiptFileForApprovalPostgres(receiptId, personId, authorizationInstant).pipe(
          Effect.provideService(Database, database),
        ),
      readReceiptSettlementForFinance: (receiptId, personId, authorizationInstant) =>
        readReceiptSettlementForFinance(receiptId, personId, authorizationInstant).pipe(
          Effect.provideService(Database, database),
        ),
      readReceiptLifecycleEvidence: (receiptId, ownerPersonId) =>
        readReceiptLifecycleEvidence(receiptId, ownerPersonId).pipe(
          Effect.provideService(Database, database),
        ),
      receiptStatusTotals: receiptStatusTotals.pipe(Effect.provideService(Database, database)),
      listStaleOutboxClaims: (claimedBefore, receiptId) =>
        listStaleReceiptOutboxClaimIds(claimedBefore, receiptId).pipe(
          Effect.provideService(Database, database),
        ),
      recoverStaleOutboxClaim: (claimId, claimedBefore) =>
        recoverStaleReceiptOutbox(claimId, claimedBefore).pipe(
          Effect.provideService(Database, database),
        ),
      deliverNextOutboxEffect: (claimId, claimedAt, receiptId) =>
        deliverNextReceiptOutbox(claimId, claimedAt, receiptId).pipe(
          Effect.provideService(Database, database),
        ),
    });
  }),
);
