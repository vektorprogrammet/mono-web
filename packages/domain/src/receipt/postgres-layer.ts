import { Database } from "../database/service.js";
import { Effect, Layer } from "effect";
import { resolveReceiptAuthority as resolveReceiptAuthorityPostgres } from "./authority-postgres.js";
import {
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "./outbox.js";
import { executeReceiptCommand } from "./postgres.js";
import {
  listApproverReceipts,
  listOwnedReceiptProjection,
  readReceiptLifecycleEvidence,
  receiptStatusTotals,
} from "./projections.js";
import { Economy } from "./service.js";

export const EconomyLive = Layer.effect(
  Economy,
  Effect.gen(function* () {
    const database = yield* Database;

    return Economy.of({
      executeReceipt: (input, context) =>
        executeReceiptCommand(input, context).pipe(Effect.provideService(Database, database)),
      resolveReceiptAuthority: (personId, authorizationInstant, organizationProjection) =>
        resolveReceiptAuthorityPostgres(
          personId,
          authorizationInstant,
          organizationProjection,
        ).pipe(Effect.provideService(Database, database)),
      listOwnedReceipts: (ownerPersonId, status) =>
        listOwnedReceiptProjection(ownerPersonId, status).pipe(
          Effect.provideService(Database, database),
        ),
      listReceiptsForApproval: (scope) =>
        listApproverReceipts(scope).pipe(Effect.provideService(Database, database)),
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
