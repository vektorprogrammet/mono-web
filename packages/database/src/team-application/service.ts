import { Effect, Layer } from "effect";
import { TeamApplications } from "@vektorprogrammet/domain/team-application";
import { Database } from "../service.js";
import {
  cleanUpTeamApplicationDeliveryQueue,
  deliverNextTeamApplicationOutbox,
  TeamApplicationDeliveryQueue,
  TeamApplicationDeliveryQueueLive,
  type TeamApplicationDeliveryOptions,
} from "./outbox.js";
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

/**
 * Captures the caller's Database and builds the notification queue store on it. The store
 * is one delivery worker identity; it acquires no pool and polls only while a delivery
 * waits.
 */
export const TeamApplicationsLive = (delivery: Partial<TeamApplicationDeliveryOptions> = {}) =>
  Layer.effect(
    TeamApplications,
    Effect.gen(function* () {
      const database = yield* Database;
      const queue = yield* TeamApplicationDeliveryQueue;

      return TeamApplications.of({
        readPublicIntake: (teamId) =>
          readPublicTeamApplicationIntake(teamId).pipe(Effect.provideService(Database, database)),
        listPublicIntakes: listPublicTeamApplicationIntakes.pipe(
          Effect.provideService(Database, database),
        ),
        submit: (command) =>
          submitTeamApplication(command).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(TeamApplicationDeliveryQueue, queue),
          ),
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
        deliverNextOutboxEffect: (sender, idle) =>
          deliverNextTeamApplicationOutbox(sender, idle).pipe(
            Effect.provideService(Database, database),
            Effect.provideService(TeamApplicationDeliveryQueue, queue),
          ),
        cleanUpDeliveryQueue: cleanUpTeamApplicationDeliveryQueue.pipe(
          Effect.provideService(TeamApplicationDeliveryQueue, queue),
        ),
      });
    }),
  ).pipe(Layer.provide(TeamApplicationDeliveryQueueLive(delivery)));
