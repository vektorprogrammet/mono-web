import { Context, Effect } from "effect";
import type {
  OrganizationAuthorityInstant,
  OrganizationPersonAuthority,
} from "../organization/authority.js";
import type { PersonId } from "../organization/schema.js";
import type { ReceiptAuthority } from "./authority.js";
import type { ReceiptAuxiliaryEffects } from "./auxiliary-service.js";
import type {
  ReceiptAuthorityResolutionError,
  ReceiptFailure,
  ReceiptNotFound,
  ReceiptPersistenceError,
} from "./errors.js";
import type { ReceiptFileService } from "./file-service.js";
import type { ReceiptOutboxDeliveryResult } from "./outbox.js";
import type {
  OwnedReceiptProjectionItem,
  ReceiptApprovalScope,
  ReceiptListItem,
  ReceiptLifecycleEvidenceProjection,
  ReceiptStatusTotal,
} from "./projections.js";
import type {
  ReceiptCommandPrincipal,
  ReceiptStatus,
  ReceiptSubmissionAllocation,
} from "./schema.js";

export interface ReceiptTransactionResult {
  readonly observation: import("./schema.js").ReceiptObservation;
  readonly replayed: boolean;
  readonly outboxCount: number;
}

export interface EconomyShape {
  readonly executeReceipt: (
    input: unknown,
    principal: ReceiptCommandPrincipal,
    allocation?: ReceiptSubmissionAllocation,
  ) => Effect.Effect<ReceiptTransactionResult, ReceiptFailure>;
  readonly resolveReceiptAuthority: (
    personId: PersonId,
    authorizationInstant: OrganizationAuthorityInstant,
    organizationProjection: OrganizationPersonAuthority,
  ) => Effect.Effect<ReceiptAuthority, ReceiptAuthorityResolutionError>;
  readonly listOwnedReceipts: (
    ownerPersonId: string,
    status?: ReceiptStatus,
  ) => Effect.Effect<ReadonlyArray<OwnedReceiptProjectionItem>, ReceiptPersistenceError>;
  readonly listReceiptsForApproval: (
    scope: ReceiptApprovalScope,
  ) => Effect.Effect<ReadonlyArray<ReceiptListItem>, ReceiptPersistenceError>;
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
