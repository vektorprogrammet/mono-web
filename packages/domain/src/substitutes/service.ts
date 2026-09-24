import { Context, Data, type Effect } from "effect";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import type { SubstituteFailure } from "./policy.js";
import type {
  SubstituteCommand,
  SubstituteEntry,
  SubstitutePool,
  SubstituteScope,
  SubstituteScopes,
} from "./schema.js";

/** Internal cause information must not enter a public response. */
export class SubstitutePersistenceError extends Data.TaggedError("SubstitutePersistenceError")<{
  readonly code: "internal.error" | "transaction.conflict";
  readonly status: 409 | 500;
  readonly cause: unknown;
}> {}

export type SubstituteOperationFailure = SubstituteFailure | SubstitutePersistenceError;

/** Trusted server operations. The caller authenticates and authorizes every operation. */
export interface SubstitutesOperations {
  /** Projects visible scope choices from supplied current authority; does not authenticate it. */
  readonly listScopes: (
    authority: OrganizationPersonAuthority,
  ) => Effect.Effect<SubstituteScopes, SubstituteOperationFailure>;
  /** Includes inactive candidates. The caller must conceal them from read-only members. */
  readonly readPool: (
    scope: SubstituteScope,
  ) => Effect.Effect<SubstitutePool, SubstituteOperationFailure>;
  /** Selects canonical application fields. The caller checks scope and inactive-entry visibility. */
  readonly readEntry: (
    applicationId: SubstituteEntry["applicationId"],
  ) => Effect.Effect<SubstituteEntry, SubstituteOperationFailure>;
  /**
   * Runs inside the caller's transaction after current authority and receipt lookup.
   * Locks the application, reads the current entry, checks the transport precondition,
   * applies the legal transition, and writes preferences and canonical application year.
   * The callback grants no authority and must not perform business writes.
   * Its failures and requirements propagate unchanged. Success precedes caller commit.
   * This operation does not retry, deliver notifications, or create coverage facts.
   */
  readonly execute: <E, R>(
    applicationId: SubstituteEntry["applicationId"],
    command: SubstituteCommand,
    checkPrecondition: (current: SubstituteEntry) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<SubstituteEntry, SubstituteOperationFailure | E, R>;
}

/** Portable service key; the database/substitutes entry point supplies SubstitutesLive. */
export class Substitutes extends Context.Service<Substitutes, SubstitutesOperations>()(
  "@vektorprogrammet/domain/substitutes/Substitutes",
) {}
