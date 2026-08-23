import { Database, type DatabaseShape } from "../database/service.js";
import { Organization } from "../organization/service.js";
import { PersonId } from "../organization/schema.js";
import { Effect, Schema } from "effect";
import {
  ProfileContactNotFound,
  ProfileDecodeError,
  ProfileNotFound,
  ProfilePersistenceError,
  ProfileQueryLimitExceeded,
  type ProfileFailure,
} from "./errors.js";
import {
  PersonContactProfile,
  type PersonContactProfileSelect,
  PersonProfile,
  type PersonProfileSelect,
} from "./schema.js";

export const PROFILE_READ_LIMIT = 100;

const persistenceError = (operation: string, cause?: unknown): ProfilePersistenceError =>
  new ProfilePersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : "profile persistence failed",
  });

const decodeProfile = (
  row: PersonProfileSelect,
): Effect.Effect<PersonProfile, ProfileDecodeError> =>
  Schema.decodeUnknownEffect(PersonProfile)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new ProfileDecodeError({
          message: cause instanceof Error ? cause.message : "invalid person profile row",
        }),
    ),
  );
const decodeContact = (
  row: PersonContactProfileSelect,
): Effect.Effect<PersonContactProfile, ProfileDecodeError> =>
  Schema.decodeUnknownEffect(PersonContactProfile)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new ProfileDecodeError({
          message: cause instanceof Error ? cause.message : "invalid person contact row",
        }),
    ),
  );


const readProfile = (
  sql: DatabaseShape,
  personId: PersonId,
): Effect.Effect<PersonProfile | undefined, ProfileFailure> =>
  sql<PersonProfileSelect>`
    SELECT
      person_id AS "personId",
      first_name AS "firstName",
      last_name AS "lastName",
      revision
    FROM person_profiles
    WHERE person_id = ${personId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeProfile(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read person profile", cause)),
    ),
  );
const readContact = (
  sql: DatabaseShape,
  personId: PersonId,
): Effect.Effect<PersonContactProfile | undefined, ProfileFailure> =>
  sql<PersonContactProfileSelect>`
    SELECT
      person_id AS "personId",
      email,
      phone,
      revision
    FROM person_contact_profiles
    WHERE person_id = ${personId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeContact(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read person contact", cause)),
    ),
  );


export const readPersonProfiles = (
  personIds: ReadonlyArray<PersonId>,
): Effect.Effect<ReadonlyArray<PersonProfile>, ProfileFailure, Database | Organization> =>
  Effect.gen(function* () {
    // Keep Organization explicit in the Profile composition graph. Organization remains the
    // authority that determines which person identities are eligible to request here.
    yield* Organization;
    if (personIds.length > PROFILE_READ_LIMIT) {
      return yield* new ProfileQueryLimitExceeded({ limit: PROFILE_READ_LIMIT });
    }
    const sql = yield* Database;
    const seen = new Set<string>();
    const uniqueIds = personIds.filter((personId) => {
      if (seen.has(personId)) return false;
      seen.add(personId);
      return true;
    });
    const profiles: PersonProfile[] = [];
    for (const personId of uniqueIds) {
      const profile = yield* readProfile(sql, personId);
      if (profile === undefined) return yield* new ProfileNotFound({ personId });
      profiles.push(profile);
    }
    return profiles.sort((left, right) => left.personId.localeCompare(right.personId));
  });
export const readPersonContacts = (
  personIds: ReadonlyArray<PersonId>,
): Effect.Effect<ReadonlyArray<PersonContactProfile>, ProfileFailure, Database | Organization> =>
  Effect.gen(function* () {
    yield* Organization;
    if (personIds.length > PROFILE_READ_LIMIT) {
      return yield* new ProfileQueryLimitExceeded({ limit: PROFILE_READ_LIMIT });
    }
    const sql = yield* Database;
    const seen = new Set<string>();
    const uniqueIds = personIds.filter((personId) => {
      if (seen.has(personId)) return false;
      seen.add(personId);
      return true;
    });
    const contacts: PersonContactProfile[] = [];
    for (const personId of uniqueIds) {
      const contact = yield* readContact(sql, personId);
      if (contact === undefined) return yield* new ProfileContactNotFound({ personId });
      contacts.push(contact);
    }
    return contacts.sort((left, right) => left.personId.localeCompare(right.personId));
  });
