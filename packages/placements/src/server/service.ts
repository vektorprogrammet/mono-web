import { Database } from "@vektorprogrammet/database";
import { Effect, Layer, Match, Predicate } from "effect";
import {
  Placements,
  PlacementFailure,
  PlacementPersistenceError,
  type PlacementExecution,
  type PlacementSnapshot,
} from "../contracts.js";
import {
  lockPlacementDepartment,
  mutateAffiliation,
  mutatePlacementBoard,
  readOwnAffiliation,
  readPlacementBoard,
  readPlacementScopes,
} from "./postgres.js";
import {
  mutateCoverageBoard,
  mutateOwnCoverage,
  readCoverageBoard,
  readOwnCoverage,
} from "./coverage.js";

const sqlField = (cause: unknown, field: "code" | "constraint", depth = 0): string | null => {
  if (depth >= 8 || !Predicate.isObjectOrArray(cause)) return null;
  const candidate = Predicate.hasProperty(cause, field) ? cause[field] : undefined;

  if (Predicate.isString(candidate)) return candidate;

  return "cause" in cause ? sqlField(cause.cause, field, depth + 1) : null;
};

const persistenceFailure = (cause: unknown) => {
  const code = sqlField(cause, "code");
  const constraint = sqlField(cause, "constraint");

  if (code === "23505") {
    switch (constraint) {
      case "school_service_absence_target_unique":
        return new PlacementFailure({ code: "absence.duplicate", status: 409 });
      case "school_service_substitute_offer_active_partial_unique":
      case "school_service_substitute_offer_accepted_partial_unique":
        return new PlacementFailure({ code: "offer.unresolved", status: 409 });
      case "school_service_commitment_slot_unique":
        return new PlacementFailure({ code: "commitment.duplicate", status: 409 });
    }
  }

  const conflict =
    code === "40001" ||
    code === "40P01" ||
    (code === "23P01" && constraint === "school_service_person_reservation_no_overlap");

  return new PlacementPersistenceError({
    code: conflict ? "transaction.conflict" : "internal.error",
    status: conflict ? 409 : 500,
    cause,
  });
};

export const PlacementsLive = Layer.effect(
  Placements,
  Effect.gen(function* () {
    const database = yield* Database;

    const run = <A, E>(effect: Effect.Effect<A, E, Database>) =>
      effect.pipe(
        Effect.provideService(Database, database),
        Effect.mapError((cause) =>
          cause instanceof PlacementFailure ? cause : persistenceFailure(cause),
        ),
      );

    const execute = <E, R>(
      input: PlacementExecution,
      checkPrecondition: (current: PlacementSnapshot) => Effect.Effect<void, E, R>,
    ) =>
      Effect.gen(function* () {
        const { mutation, actor, now, commandId } = input;
        yield* run(lockPlacementDepartment(mutation.scope.departmentId));

        return yield* Match.value(mutation).pipe(
          Match.when({ mode: "affiliation" }, ({ scope, command }) =>
            Effect.gen(function* () {
              const current = yield* run(readOwnAffiliation(actor, scope.departmentId));
              yield* checkPrecondition(current);

              return yield* run(mutateAffiliation(current, command.action, actor, now));
            }),
          ),
          Match.when({ mode: "board" }, ({ scope, command }) =>
            Effect.gen(function* () {
              const current = yield* run(readPlacementBoard(scope));
              yield* checkPrecondition(current);

              const id = Match.value(command.action).pipe(
                Match.when("GenerateProposal", () => `school-service-proposal-${commandId}`),
                Match.when("ScheduleService", () => `school-service-commitment-${commandId}`),
                Match.orElse(() => `placement-${commandId}`),
              );

              return yield* run(mutatePlacementBoard(scope, command, actor, now, id));
            }),
          ),
          Match.when({ mode: "ownCoverage" }, ({ scope, command }) =>
            Effect.gen(function* () {
              const current = yield* run(readOwnCoverage(scope, actor));
              yield* checkPrecondition(current);

              return yield* run(
                mutateOwnCoverage(
                  scope,
                  command,
                  actor,
                  now,
                  `school-service-absence-${commandId}`,
                ),
              );
            }),
          ),
          Match.when({ mode: "coverage" }, ({ scope, command }) =>
            Effect.gen(function* () {
              const current = yield* run(readCoverageBoard(scope));
              yield* checkPrecondition(current);

              return yield* run(
                mutateCoverageBoard(scope, command, actor, now, {
                  absenceId: `school-service-absence-${commandId}`,
                  offerId: `school-service-substitute-offer-${commandId}`,
                  acknowledgementId: `school-service-coverage-acknowledgement-${commandId}`,
                  occurrenceId: `school-service-occurrence-${commandId}`,
                }),
              );
            }),
          ),
          Match.exhaustive,
        );
      });

    return Placements.of({
      listScopes: (authority) => run(readPlacementScopes(authority)),
      readOwnAffiliation: (personId, departmentId) =>
        run(readOwnAffiliation(personId, departmentId)),
      readBoard: (scope) => run(readPlacementBoard(scope)),
      readOwnCoverage: (scope, personId) => run(readOwnCoverage(scope, personId)),
      readCoverageBoard: (scope) => run(readCoverageBoard(scope)),
      execute,
    });
  }),
);
