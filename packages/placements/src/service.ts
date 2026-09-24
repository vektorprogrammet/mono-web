import { Context, Data, type Effect } from "effect";
import type {
  DepartmentId,
  OrganizationPersonAuthority,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import type { PlacementFailure } from "./policy.js";
import type {
  Affiliation,
  CoverageBoard,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  OwnCoverageView,
  PlacementBoard,
  PlacementCommand,
  PlacementScope,
  PlacementScopes,
} from "./schema.js";

export class PlacementPersistenceError extends Data.TaggedError("PlacementPersistenceError")<{
  readonly code: "internal.error" | "transaction.conflict";
  readonly status: 409 | 500;
  readonly cause: unknown;
}> {}

export type PlacementOperationFailure = PlacementFailure | PlacementPersistenceError;

export type PlacementMutation =
  | {
      readonly mode: "affiliation";
      readonly scope: { readonly departmentId: DepartmentId };
      readonly command: OwnAffiliationCommand;
    }
  | { readonly mode: "board"; readonly scope: PlacementScope; readonly command: PlacementCommand }
  | {
      readonly mode: "ownCoverage";
      readonly scope: PlacementScope;
      readonly command: OwnCoverageCommand;
    }
  | {
      readonly mode: "coverage";
      readonly scope: PlacementScope;
      readonly command: CoverageCommand;
    };

export type PlacementSnapshot = Affiliation | PlacementBoard | OwnCoverageView | CoverageBoard;

export interface PlacementExecution {
  readonly mutation: PlacementMutation;
  readonly actor: PersonId;
  readonly now: string;
  readonly commandId: string;
}

export interface PlacementsOperations {
  readonly listScopes: (
    authority: OrganizationPersonAuthority,
  ) => Effect.Effect<typeof PlacementScopes.Type, PlacementOperationFailure>;
  readonly readOwnAffiliation: (
    personId: PersonId,
    departmentId: DepartmentId,
  ) => Effect.Effect<Affiliation, PlacementOperationFailure>;
  readonly readBoard: (
    scope: PlacementScope,
  ) => Effect.Effect<PlacementBoard, PlacementOperationFailure>;
  readonly readOwnCoverage: (
    scope: PlacementScope,
    personId: PersonId,
  ) => Effect.Effect<OwnCoverageView, PlacementOperationFailure>;
  readonly readCoverageBoard: (
    scope: PlacementScope,
  ) => Effect.Effect<CoverageBoard, PlacementOperationFailure>;
  /**
   * Runs on the caller's transaction after current authority and receipt lookup.
   * Holds the department lock across the snapshot precondition, transition,
   * audit, history, and outbox writes. The callback checks a transport-owned
   * precondition; it does not authorize the command or perform business writes.
   */
  readonly execute: <E, R>(
    input: PlacementExecution,
    checkPrecondition: (current: PlacementSnapshot) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<PlacementSnapshot, PlacementOperationFailure | E, R>;
}

export class Placements extends Context.Service<Placements, PlacementsOperations>()(
  "@vektorprogrammet/placements/Placements",
) {}
