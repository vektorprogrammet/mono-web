import { Effect, Layer } from "effect";
import { TeamApplications } from "@vektorprogrammet/domain/team-application";
import { Database } from "../service.js";
import { deliverNextTeamApplicationOutbox, recoverStaleTeamApplicationOutbox } from "./outbox.js";
import {
  authorizeTeamApplicationAction,
  deleteTeamApplication,
  listPublicTeamApplicationIntakes,
  listTeamApplications,
  readPublicTeamApplicationIntake,
  readTeamApplication,
  reviseTeamApplicationIntake,
  submitTeamApplication,
} from "./postgres.js";

/** Captures the caller's Database. Does not acquire a pool, transaction, or worker. */
export const TeamApplicationsLive = Layer.effect(
  TeamApplications,
  Effect.gen(function* () {
    const database = yield* Database;

    return TeamApplications.of({
      readPublicIntake: (teamId) =>
        readPublicTeamApplicationIntake(teamId).pipe(Effect.provideService(Database, database)),
      listPublicIntakes: listPublicTeamApplicationIntakes.pipe(
        Effect.provideService(Database, database),
      ),
      submit: (command) =>
        submitTeamApplication(command).pipe(Effect.provideService(Database, database)),
      authorize: (principal, action) =>
        authorizeTeamApplicationAction(principal, action).pipe(
          Effect.provideService(Database, database),
        ),
      listApplications: (principal, teamId, cursor) =>
        listTeamApplications(principal, teamId, cursor).pipe(
          Effect.provideService(Database, database),
        ),
      readApplication: (principal, applicationId) =>
        readTeamApplication(principal, applicationId).pipe(
          Effect.provideService(Database, database),
        ),
      deleteApplication: (command, principal) =>
        deleteTeamApplication(command, principal).pipe(Effect.provideService(Database, database)),
      reviseIntake: (command, principal, checkPrecondition) =>
        reviseTeamApplicationIntake(command, principal, checkPrecondition).pipe(
          Effect.provideService(Database, database),
        ),
      recoverStaleOutboxClaims: (claimedBefore) =>
        recoverStaleTeamApplicationOutbox(claimedBefore).pipe(
          Effect.provideService(Database, database),
        ),
      deliverNextOutboxEffect: (claimId, sender) =>
        deliverNextTeamApplicationOutbox(claimId, sender).pipe(
          Effect.provideService(Database, database),
        ),
    });
  }),
);
