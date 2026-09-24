import { Effect, Layer, Predicate } from "effect";
import {
  Substitutes,
  SubstituteFailure,
  SubstitutePersistenceError,
  type SubstituteCommand,
  type SubstituteEntry,
  type SubstituteScope,
} from "@vektorprogrammet/domain/substitutes";
import { Database } from "../service.js";
import {
  lockSubstituteApplication,
  mutateSubstitute,
  readSubstituteEntries,
  readSubstituteEntry,
  readSubstitutePeriod,
  readSubstituteScopes,
} from "./postgres.js";

const serializationConflict = (cause: unknown, depth = 0): boolean =>
  depth < 8 && Predicate.isObjectOrArray(cause) &&
  (("code" in cause && (cause.code === "40001" || cause.code === "40P01")) ||
    ("cause" in cause && serializationConflict(cause.cause, depth + 1)));

/** Captures the caller's Database. Does not acquire a pool, transaction, or worker. */
export const SubstitutesLive = Layer.effect(Substitutes, Effect.gen(function* () {
  const database = yield* Database;
  const run = <A, E>(effect: Effect.Effect<A, E, Database>) => effect.pipe(
    Effect.provideService(Database, database),
    Effect.mapError((cause) => {
      if (cause instanceof SubstituteFailure) return cause;
      const conflict = serializationConflict(cause);
      return new SubstitutePersistenceError({
        code: conflict ? "transaction.conflict" : "internal.error",
        status: conflict ? 409 : 500,
        cause,
      });
    }),
  );
  const readPool = Effect.fnUntraced(function* (scope: SubstituteScope) {
    const admissionPeriodId = yield* run(readSubstitutePeriod(scope));
    return {
      admissionPeriodId,
      entries: admissionPeriodId === null ? [] : yield* run(readSubstituteEntries(scope)),
    };
  });
  const execute = <E, R>(
    applicationId: SubstituteEntry["applicationId"],
    command: SubstituteCommand,
    checkPrecondition: (current: SubstituteEntry) => Effect.Effect<void, E, R>,
  ) => Effect.gen(function* () {
    yield* run(lockSubstituteApplication(applicationId));
    const current = yield* run(readSubstituteEntry(applicationId));
    yield* checkPrecondition(current);
    return yield* run(mutateSubstitute(current, command));
  });
  return Substitutes.of({
    listScopes: (authority) => run(readSubstituteScopes(authority)),
    readPool,
    readEntry: (applicationId) => run(readSubstituteEntry(applicationId)),
    execute,
  });
}));
