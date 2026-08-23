import { Effect, Layer } from "effect";
import { Database } from "../database/service.js";
import { Organization } from "../organization/service.js";
import { readPersonProfiles } from "./postgres.js";
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
    });
  }),
);
