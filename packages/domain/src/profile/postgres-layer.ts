import { Effect, Layer } from "effect";
import { Database } from "../database/service.js";
import { Organization } from "../organization/service.js";
import {
  readDirectoryPage as readDirectoryPagePostgres,
  readOwnProfile as readOwnProfilePostgres,
  readPersonContacts,
  readPersonProfiles,
  updateOwnProfile as updateOwnProfilePostgres,
} from "./postgres.js";
import { Profile } from "./service.js";

/** Live Profile authority; both Database and Organization remain explicit requirements. */
export const ProfileLive = Layer.effect(
  Profile,
  Effect.gen(function* () {
    const database = yield* Database;
    const organization = yield* Organization;
    return Profile.of({
      readProfiles: (personIds) =>
        readPersonProfiles(personIds).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
      readContacts: (personIds) =>
        readPersonContacts(personIds).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
      readOwnProfile: (personId) =>
        readOwnProfilePostgres(personId).pipe(Effect.provideService(Database, database)),
      updateOwnProfile: (input) =>
        updateOwnProfilePostgres(input).pipe(Effect.provideService(Database, database)),
      readDirectoryPage: (input) =>
        readDirectoryPagePostgres(input).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
    });
  }),
);
