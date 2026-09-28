/**
 * Placements: affiliation, placement boards, drafts, and coverage.
 *
 * Each RPC keeps the operation ID of the HTTP operation it replaces as its tag. A read takes the
 * old query as its payload. A command takes that scope, its `idempotencyKey`, the `ifMatch` of the
 * snapshot it changes, and the old body as its `request`, and answers the changed snapshot beside
 * its new entity tag.
 *
 * @since 0.3.0
 */
import {
  Affiliation,
  AffiliationScope,
  CoverageBoard,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  OwnCoverageView,
  PlacementBoard,
  PlacementCommand,
  PlacementDraft,
  PlacementScope,
  PlacementScopes,
} from "@vektorprogrammet/domain/placements";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";

export {
  AffiliationScope,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  PlacementCommand,
  PlacementScope,
  PlacementScopes,
};

/** The caller's own affiliation, with the tag that `placements.commandOwnAffiliation` repeats. */
export const OwnAffiliationResource = Schema.Struct({
  ...Affiliation.fields,
  etag: StrongETag,
}).annotate({ identifier: "OwnAffiliationResource" });

/** The coordinator's board, with the tag that `placements.commandBoard` repeats. */
export const PlacementBoardResource = Schema.Struct({
  ...PlacementBoard.fields,
  etag: StrongETag,
}).annotate({ identifier: "PlacementBoardResource" });

/** The caller's own coverage, with the tag that `placements.commandOwnCoverage` repeats. */
export const OwnCoverageResource = Schema.Struct({
  ...OwnCoverageView.fields,
  etag: StrongETag,
}).annotate({ identifier: "OwnCoverageResource" });

/** The coordinator's coverage board, with the tag that `placements.commandCoverageBoard` repeats. */
export const CoverageBoardResource = Schema.Struct({
  ...CoverageBoard.fields,
  etag: StrongETag,
}).annotate({ identifier: "CoverageBoardResource" });

/**
 * A draft is a read. `boardEtag` names the board version it was drafted from, for the `ifMatch`
 * of the placement commands that apply it.
 */
export const PlacementDraftResource = Schema.Struct({
  ...PlacementDraft.fields,
  boardEtag: StrongETag,
}).annotate({ identifier: "PlacementDraftResource" });

/** The failures that every placement operation can answer: credential, authority, and domain. */
const placementFailureCodes = [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "scope.invalid",
  "affiliation.transition-invalid",
  "affiliation.inactive",
  "placement.overlap",
  "placement.inactive",
  "school-service.proposal-empty",
  "school-service.proposal-inactive",
  "school-service.exception-review-invalid",
  "commitment.target-invalid",
  "commitment.duplicate",
  "commitment.closed",
  "commitment.outcome-invalid",
  "commitment.interval-invalid",
  "absence.target-invalid",
  "absence.duplicate",
  "coverage.owner-invalid",
  "coverage.coverer-ineligible",
  "coverage.coverer-unavailable",
  "coverage.not-recorded",
  "transaction.conflict",
  "internal.error",
] as const;

export const PlacementsReadProblem = problemUnion("PlacementsReadProblem", placementFailureCodes);

export const PlacementsCommandProblem = problemUnion("PlacementsCommandProblem", [
  ...placementFailureCodes,
  "absence.closed",
  "precondition.failed",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "idempotency.unavailable",
]);

const access = (capability: "placements.self" | "placements.manage", write: boolean) =>
  withAccessSpec(
    personNativeAccess({
      capability,
      canonicalScopeResolver: "placements.explicit-department",
      decisionTime: write ? "Transaction" : "SnapshotRead",
    }),
  );

/** The replay key and precondition of a command on one snapshot. */
const commandFields = { idempotencyKey: IdempotencyKey, ifMatch: StrongETag };

/**
 * Public department labels and canonical semesters; private candidate names require coordinator
 * authority.
 */
export const ListPlacementScopes = Rpc.make("placements.listScopes", {
  success: PlacementScopes,
  error: rpcProblems(PlacementsReadProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.self", false));

/** The caller's own affiliation; there is no person selector. */
export const ReadOwnAffiliation = Rpc.make("placements.readOwnAffiliation", {
  payload: AffiliationScope,
  success: OwnAffiliationResource,
  error: rpcProblems(PlacementsReadProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.self", false));

/** Requests or withdraws the caller's own affiliation, which lets scoped coordinators find them. */
export const CommandOwnAffiliation = Rpc.make("placements.commandOwnAffiliation", {
  payload: Schema.Struct({
    ...AffiliationScope.fields,
    ...commandFields,
    request: OwnAffiliationCommand,
  }),
  success: OwnAffiliationResource,
  error: rpcProblems(PlacementsCommandProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.self", true));

/**
 * The placement board, for holders of placement coordination in the department (a board
 * leadership or a delegation) and global administrators only.
 */
export const ReadPlacementBoard = Rpc.make("placements.readBoard", {
  payload: PlacementScope,
  success: PlacementBoardResource,
  error: rpcProblems(PlacementsReadProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.manage", false));

/**
 * Manages placements and dated school service: demand, proposals, commitments, and placement
 * changes inside one transaction.
 */
export const CommandPlacementBoard = Rpc.make("placements.commandBoard", {
  payload: Schema.Struct({
    ...PlacementScope.fields,
    ...commandFields,
    request: PlacementCommand,
  }),
  success: PlacementBoardResource,
  error: rpcProblems(PlacementsCommandProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.manage", true));

/**
 * Drafts open school demand for unplaced active assistants from their weekday availability and
 * teaching blocks. Nothing is stored; coordinators apply the draft with placement commands.
 */
export const ReadPlacementDraft = Rpc.make("placements.readDraft", {
  payload: PlacementScope,
  success: PlacementDraftResource,
  error: rpcProblems(PlacementsReadProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.manage", false));

/**
 * The caller's own coverage and scheduled service: only commitments where they are scheduled or
 * cover a recorded absence, and possible coverers only while they have an open absence.
 */
export const ReadOwnCoverage = Rpc.make("placements.readOwnCoverage", {
  payload: PlacementScope,
  success: OwnCoverageResource,
  error: rpcProblems(PlacementsReadProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.self", false));

/**
 * Reports the caller's own absence or records who covers it. The caller must own a scheduled
 * assignment in an open commitment; coverage commands name only the caller's own absence.
 */
export const CommandOwnCoverage = Rpc.make("placements.commandOwnCoverage", {
  payload: Schema.Struct({
    ...PlacementScope.fields,
    ...commandFields,
    request: OwnCoverageCommand,
  }),
  success: OwnCoverageResource,
  error: rpcProblems(PlacementsCommandProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.self", true));

/**
 * The coordinator coverage board: absences, coverage records, possible coverers, per-absence
 * closures, and commitment outcomes, for a scoped coordinator only.
 */
export const ReadCoverageBoard = Rpc.make("placements.readCoverageBoard", {
  payload: PlacementScope,
  success: CoverageBoardResource,
  error: rpcProblems(PlacementsReadProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.manage", false));

/**
 * Records coverage and decides dated service: checks coordinator scope, records absences and
 * coverage, and derives actual attendance for immutable outcome evidence in one transaction.
 */
export const CommandCoverageBoard = Rpc.make("placements.commandCoverageBoard", {
  payload: Schema.Struct({
    ...PlacementScope.fields,
    ...commandFields,
    request: CoverageCommand,
  }),
  success: CoverageBoardResource,
  error: rpcProblems(PlacementsCommandProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.manage", true));

export class PlacementsRpcs extends RpcGroup.make(
  ListPlacementScopes,
  ReadOwnAffiliation,
  CommandOwnAffiliation,
  ReadPlacementBoard,
  CommandPlacementBoard,
  ReadPlacementDraft,
  ReadOwnCoverage,
  CommandOwnCoverage,
  ReadCoverageBoard,
  CommandCoverageBoard,
) {}
