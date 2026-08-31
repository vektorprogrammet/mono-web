/**
 * Portable Economy service contract for receipt lifecycle operations.
 *
 * @since 0.1.0
 */
import { Context, Effect } from "effect";
import type { OrganizationAuthorityInstant } from "../organization/authority.js";
import type { PersonId } from "../organization/schema.js";
import type { ReceiptAuxiliaryEffects } from "./auxiliary-service.js";
import type {
  ReceiptApprovalListFailure,
  ReceiptFailure,
  ReceiptNotFound,
  ReceiptPersistenceError,
} from "./errors.js";
import type { ReceiptFileService } from "./file-service.js";
import type { ReceiptOutboxDeliveryResult } from "./outbox.js";
import type {
  OwnedReceiptProjectionItem,
  ReceiptListItem,
  ReceiptLifecycleEvidenceProjection,
  ReceiptStatusTotal,
} from "./projections.js";
import type {
  ReceiptCommandPrincipal,
  ReceiptObservation,
  ReceiptStatus,
  ReceiptSubmissionAllocation,
} from "./schema.js";

export interface ReceiptTransactionResult {
  readonly observation: ReceiptObservation;
  readonly replayed: boolean;
  readonly outboxCount: number;
}

export interface EconomyShape {
  readonly executeReceipt: (
    input: unknown,
    principal: ReceiptCommandPrincipal,
    allocation?: ReceiptSubmissionAllocation,
  ) => Effect.Effect<ReceiptTransactionResult, ReceiptFailure>;
  readonly listOwnedReceipts: (
    ownerPersonId: string,
    status?: ReceiptStatus,
  ) => Effect.Effect<ReadonlyArray<OwnedReceiptProjectionItem>, ReceiptPersistenceError>;
  readonly listReceiptsForApproval: (
    personId: PersonId,
    authorizationInstant: OrganizationAuthorityInstant,
    status?: ReceiptStatus,
  ) => Effect.Effect<ReadonlyArray<ReceiptListItem>, ReceiptApprovalListFailure>;
  readonly readReceiptLifecycleEvidence: (
    receiptId: string,
    ownerPersonId: string,
  ) => Effect.Effect<ReceiptLifecycleEvidenceProjection, ReceiptPersistenceError | ReceiptNotFound>;
  readonly receiptStatusTotals: Effect.Effect<
    ReadonlyArray<ReceiptStatusTotal>,
    ReceiptPersistenceError
  >;
  readonly listStaleOutboxClaims: (
    claimedBefore: string,
    receiptId?: string,
  ) => Effect.Effect<ReadonlyArray<string>, ReceiptPersistenceError>;
  readonly recoverStaleOutboxClaim: (
    claimId: string,
    claimedBefore: string,
  ) => Effect.Effect<number, ReceiptPersistenceError>;
  readonly deliverNextOutboxEffect: (
    claimId: string,
    claimedAt: string,
    receiptId?: string,
  ) => Effect.Effect<
    ReceiptOutboxDeliveryResult,
    ReceiptPersistenceError,
    ReceiptFileService | ReceiptAuxiliaryEffects
  >;
}

export class Economy extends Context.Service<Economy, EconomyShape>()(
  "@vektorprogrammet/domain/Economy",
) {}
