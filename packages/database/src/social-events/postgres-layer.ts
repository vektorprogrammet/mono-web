import { Effect, Layer } from "effect";
import { Database } from "../service.js";
import {
  createSocialEventPostgres,
  readSocialEventListPostgres,
  readSocialEventScopePostgres,
  readSocialEventSnapshotInstantPostgres,
  validateSocialEventScopePostgres,
} from "./postgres.js";
import { SocialEvents } from "@vektorprogrammet/domain/social-events";

/** Live social-event persistence bound to the process Database. */
export const SocialEventsLive = Layer.effect(
  SocialEvents,
  Effect.gen(function* () {
    const database = yield* Database;

    return SocialEvents.of({
      readSnapshotInstant: () =>
        readSocialEventSnapshotInstantPostgres().pipe(Effect.provideService(Database, database)),
      readScope: (input) =>
        readSocialEventScopePostgres(input).pipe(Effect.provideService(Database, database)),
      readList: (input) =>
        readSocialEventListPostgres(input).pipe(Effect.provideService(Database, database)),
      validateScope: (scope) =>
        validateSocialEventScopePostgres(scope).pipe(Effect.provideService(Database, database)),
      create: (command) =>
        createSocialEventPostgres(command).pipe(Effect.provideService(Database, database)),
    });
  }),
);
