import { Context, Data, type Effect } from "effect";
import type { DepartmentId, OrganizationPersonAuthority, PersonId } from "../organization/index.js";
import type { PlacementFailure } from "./policy.js";
import type { PlacementDraft } from "./scheduler.js";
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

/** A database failure. Callers must not expose the internal cause to clients. */
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

/**
 * Trusted server operations, not an authentication or authorization boundary.
 * Callers authorize reads and writes before invocation.
 * The concrete Layer captures Database; execute also retains callback requirements.
 */
export interface PlacementsOperations {
  /** Projects management availability from supplied authority; does not authenticate it. */
  readonly listScopes: (
    authority: OrganizationPersonAuthority,
  ) => Effect.Effect<typeof PlacementScopes.Type, PlacementOperationFailure>;
  /** Returns Absent at revision zero when a known department has no affiliation. */
  readonly readOwnAffiliation: (
    personId: PersonId,
    departmentId: DepartmentId,
  ) => Effect.Effect<Affiliation, PlacementOperationFailure>;
  /**
   * Drafts placements for the scoped board after caller authorization. The draft reads
   * demand, placements, capacity plans, and current availability, and writes nothing;
   * the same facts give the same draft.
   */
  readonly readDraft: (
    scope: PlacementScope,
  ) => Effect.Effect<PlacementDraft, PlacementOperationFailure>;
  /** Reads the scoped board after caller authorization. */
  readonly readBoard: (
    scope: PlacementScope,
  ) => Effect.Effect<PlacementBoard, PlacementOperationFailure>;
  /**
   * Reads one person's coverage after caller authorization.
   * Current placements include only active rows for that person, department, and semester.
   * Placements, confirmed roster slots, and dated commitments remain separate facts.
   */
  readonly readOwnCoverage: (
    scope: PlacementScope,
    personId: PersonId,
  ) => Effect.Effect<OwnCoverageView, PlacementOperationFailure>;
  /** Reads coordinator coverage after caller authorization. */
  readonly readCoverageBoard: (
    scope: PlacementScope,
  ) => Effect.Effect<CoverageBoard, PlacementOperationFailure>;
  /**
   * Runs on the caller's transaction after current authority and receipt lookup.
   * Holds the department lock across the snapshot precondition, transition,
   * audit, history, and outbox writes. The callback checks a transport-owned
   * precondition; it does not authorize the command or perform business writes.
   * Success returns a snapshot before the caller commits its transaction.
   * Callback failures propagate unchanged; execute does not retry or deliver notifications.
   */
  readonly execute: <E, R>(
    input: PlacementExecution,
    checkPrecondition: (current: PlacementSnapshot) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<PlacementSnapshot, PlacementOperationFailure | E, R>;
}

/** The portable service key. The server entry point supplies its database-backed Layer. */
export class Placements extends Context.Service<Placements, PlacementsOperations>()(
  "@vektorprogrammet/domain/Placements",
) {}
