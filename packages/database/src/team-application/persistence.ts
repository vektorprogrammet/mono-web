import { Predicate } from "effect";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { TeamApplicationPersistenceError } from "@vektorprogrammet/domain/team-application";

const serializationConflict = (cause: unknown, depth: number): boolean =>
  depth < 8 &&
  ((isSqlError(cause) &&
    (Predicate.isTagged(cause.reason, "SerializationError") ||
      Predicate.isTagged(cause.reason, "DeadlockError"))) ||
    (Predicate.hasProperty(cause, "cause") && serializationConflict(cause.cause, depth + 1)));

/** Keeps the cause private and marks serialization and deadlock aborts as retryable conflicts. */
export const persistenceFailure =
  (operation: string) =>
  (cause: unknown): TeamApplicationPersistenceError =>
    new TeamApplicationPersistenceError({
      operation,
      conflict: serializationConflict(cause, 0),
      cause,
    });
