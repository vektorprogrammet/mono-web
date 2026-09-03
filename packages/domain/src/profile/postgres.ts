import { Database, type DatabaseShape } from "../database/service.js";
import { Organization } from "../organization/service.js";
import { PersonId } from "../organization/schema.js";
import type { DirectoryEntry, DirectoryPage, ReadDirectoryPageInput } from "./service.js";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { Effect, Schema } from "effect";
import {
  ProfileCommandConflict,
  ProfileContactNotFound,
  ProfileDecodeError,
  ProfileNotFound,
  ProfilePersistenceError,
  ProfileQueryLimitExceeded,
  ProfileStaleRevision,
  type ProfileFailure,
} from "./errors.js";
import {
  OwnProfile,
  OwnProfileHttpSource,
  PersonContactProfile,
  type PersonContactProfileSelect,
  PersonProfile,
  type PersonProfileSelect,
  type ProfileCommandId,
  UpdateOwnProfileCommand,
} from "./schema.js";
import type { UpdateOwnProfileInput } from "./service.js";

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

interface OwnProfileJoinedRow {
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly nameRevision: number;
  readonly representationRevision: number;
  readonly contactPersonId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly contactRevision: number | null;
}

interface ProfileCommandReceiptRow {
  readonly commandSha256: string;
  readonly commandJson: unknown;
  readonly resultJson: unknown;
  readonly actorPersonId: string;
  readonly expectedNameRevision: number;
  readonly expectedContactRevision: number;
  readonly committedNameRevision: number;
  readonly committedContactRevision: number;
}

interface ProfileCommandPayload {
  readonly actorPersonId: PersonId;
  readonly _tag: UpdateOwnProfileCommand["_tag"];
  readonly commandId: UpdateOwnProfileCommand["commandId"];
  readonly expectedNameRevision: UpdateOwnProfileCommand["expectedNameRevision"];
  readonly expectedContactRevision: UpdateOwnProfileCommand["expectedContactRevision"];
  readonly firstName: UpdateOwnProfileCommand["firstName"];
  readonly lastName: UpdateOwnProfileCommand["lastName"];
  readonly email: UpdateOwnProfileCommand["email"];
  readonly phone: UpdateOwnProfileCommand["phone"];
}

const decodePersonId = (value: unknown): Effect.Effect<PersonId, ProfileDecodeError> =>
  Schema.decodeUnknownEffect(PersonId)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new ProfileDecodeError({
          message: cause instanceof Error ? cause.message : "invalid Profile actor person ID",
        }),
    ),
  );

const decodeOwnProfileValue = (value: unknown): Effect.Effect<OwnProfile, ProfileDecodeError> =>
  Schema.decodeUnknownEffect(OwnProfile)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new ProfileDecodeError({
          message: cause instanceof Error ? cause.message : "invalid own Profile observation",
        }),
    ),
  );

const decodeUpdateOwnProfileCommand = (
  value: unknown,
): Effect.Effect<UpdateOwnProfileCommand, ProfileDecodeError> =>
  Schema.decodeUnknownEffect(UpdateOwnProfileCommand)(value, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProfileDecodeError({
          message: cause instanceof Error ? cause.message : "invalid own Profile command",
        }),
    ),
  );

const readOwnProfileHttpSourceWith = (
  sql: DatabaseShape,
  personId: PersonId,
): Effect.Effect<OwnProfileHttpSource, ProfileFailure> =>
  sql<OwnProfileJoinedRow>`
    SELECT
      profile.person_id AS "personId",
      profile.first_name AS "firstName",
      profile.last_name AS "lastName",
      profile.revision AS "nameRevision",
      http_version.representation_revision AS "representationRevision",
      contact.person_id AS "contactPersonId",
      contact.email,
      contact.phone,
      contact.revision AS "contactRevision"
    FROM public.person_profiles AS profile
    INNER JOIN public.profile_http_versions AS http_version
      ON http_version.person_id = profile.person_id
    LEFT JOIN public.person_contact_profiles AS contact
      ON contact.person_id = profile.person_id
    WHERE profile.person_id = ${personId}
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        const row = rows[0];
        if (row === undefined) return yield* new ProfileNotFound({ personId });
        if (row.contactPersonId === null) {
          return yield* new ProfileContactNotFound({ personId });
        }
        const profile = yield* decodeOwnProfileValue({
          personId: row.personId,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          phone: row.phone,
          nameRevision: row.nameRevision,
          contactRevision: row.contactRevision,
        });
        return yield* OwnProfileHttpSource.makeEffect({
          profile,
          representationRevision: row.representationRevision,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProfileDecodeError({
                message: cause instanceof Error ? cause.message : "invalid own Profile HTTP source",
              }),
          ),
        );
      }),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read own Profile HTTP source", cause)),
    ),
  );

const readOwnProfileWith = (
  sql: DatabaseShape,
  personId: PersonId,
): Effect.Effect<OwnProfile, ProfileFailure> =>
  readOwnProfileHttpSourceWith(sql, personId).pipe(Effect.map((source) => source.profile));

/** Reads names and contacts from one SQL snapshot. */
export const readOwnProfile = (
  personId: PersonId,
): Effect.Effect<OwnProfile, ProfileFailure, Database> =>
  Effect.gen(function* () {
    const decodedPersonId = yield* decodePersonId(personId);
    const sql = yield* Database;
    return yield* readOwnProfileWith(sql, decodedPersonId);
  });

/** Reads an own-Profile representation and its authoritative HTTP revision from one SQL snapshot. */
export const readOwnProfileHttpSourcePostgres = (
  personId: PersonId,
): Effect.Effect<OwnProfileHttpSource, ProfileFailure, Database> =>
  Effect.gen(function* () {
    const decodedPersonId = yield* decodePersonId(personId);
    const sql = yield* Database;
    return yield* readOwnProfileHttpSourceWith(sql, decodedPersonId);
  });

const lockProfileCommand = (sql: DatabaseShape, commandId: ProfileCommandId) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 0))`.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock own Profile command", cause)),
    ),
  );

const readProfileCommandReceipt = (
  sql: DatabaseShape,
  commandId: ProfileCommandId,
): Effect.Effect<ProfileCommandReceiptRow | undefined, ProfilePersistenceError> =>
  sql<ProfileCommandReceiptRow>`
    SELECT
      command_sha256 AS "commandSha256",
      command_json AS "commandJson",
      result_json AS "resultJson",
      actor_person_id AS "actorPersonId",
      expected_name_revision AS "expectedNameRevision",
      expected_contact_revision AS "expectedContactRevision",
      committed_name_revision AS "committedNameRevision",
      committed_contact_revision AS "committedContactRevision"
    FROM profile_self_edit_commands
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read own Profile command receipt", cause)),
    ),
  );

const lockPersonProfile = (
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
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeProfile(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock own Profile name row", cause)),
    ),
  );

const lockPersonContact = (
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
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeContact(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock own Profile contact row", cause)),
    ),
  );

const updatePersonProfile = (
  sql: DatabaseShape,
  actorPersonId: PersonId,
  command: UpdateOwnProfileCommand,
): Effect.Effect<PersonProfile, ProfileFailure> =>
  sql<PersonProfileSelect>`
    UPDATE person_profiles
    SET
      first_name = ${command.firstName},
      last_name = ${command.lastName},
      revision = revision + 1
    WHERE person_id = ${actorPersonId}
      AND revision = ${command.expectedNameRevision}
    RETURNING
      person_id AS "personId",
      first_name AS "firstName",
      last_name AS "lastName",
      revision
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        const row = rows[0];
        if (row === undefined) {
          return yield* persistenceError("update locked own Profile name row");
        }
        return yield* decodeProfile(row);
      }),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("update own Profile name row", cause)),
    ),
  );

const updatePersonContact = (
  sql: DatabaseShape,
  actorPersonId: PersonId,
  command: UpdateOwnProfileCommand,
): Effect.Effect<PersonContactProfile, ProfileFailure> =>
  sql<PersonContactProfileSelect>`
    UPDATE person_contact_profiles
    SET
      email = ${command.email},
      phone = ${command.phone},
      revision = revision + 1
    WHERE person_id = ${actorPersonId}
      AND revision = ${command.expectedContactRevision}
    RETURNING
      person_id AS "personId",
      email,
      phone,
      revision
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        const row = rows[0];
        if (row === undefined) {
          return yield* persistenceError("update locked own Profile contact row");
        }
        return yield* decodeContact(row);
      }),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("update own Profile contact row", cause)),
    ),
  );

const replayOwnProfile = (
  receipt: ProfileCommandReceiptRow,
  actorPersonId: PersonId,
  command: UpdateOwnProfileCommand,
  commandJson: string,
  commandDigest: string,
): Effect.Effect<
  OwnProfile,
  ProfileCommandConflict | ProfileDecodeError | ProfilePersistenceError
> =>
  Effect.gen(function* () {
    const storedCommandJson = canonicalJson(receipt.commandJson);
    if (storedCommandJson !== commandJson) {
      return yield* new ProfileCommandConflict({ commandId: command.commandId });
    }
    const storedDigest = sha256Hex(canonicalJsonBytes(receipt.commandJson));
    if (receipt.commandSha256 !== commandDigest || receipt.commandSha256 !== storedDigest) {
      return yield* persistenceError("validate own Profile command digest");
    }
    const result = yield* decodeOwnProfileValue(receipt.resultJson);
    if (
      receipt.actorPersonId !== actorPersonId ||
      receipt.expectedNameRevision !== command.expectedNameRevision ||
      receipt.expectedContactRevision !== command.expectedContactRevision ||
      receipt.committedNameRevision !== command.expectedNameRevision + 1 ||
      receipt.committedContactRevision !== command.expectedContactRevision + 1 ||
      result.personId !== actorPersonId ||
      result.firstName !== command.firstName ||
      result.lastName !== command.lastName ||
      result.email !== command.email ||
      result.phone !== command.phone ||
      result.nameRevision !== receipt.committedNameRevision ||
      result.contactRevision !== receipt.committedContactRevision
    ) {
      return yield* persistenceError("validate own Profile command receipt linkage");
    }
    return result;
  });

const writeProfileCommandReceipt = (
  sql: DatabaseShape,
  actorPersonId: PersonId,
  command: UpdateOwnProfileCommand,
  payload: ProfileCommandPayload,
  commandDigest: string,
  result: OwnProfile,
): Effect.Effect<void, ProfilePersistenceError> =>
  sql`
    INSERT INTO profile_self_edit_commands (
      command_id,
      command_sha256,
      command_json,
      result_json,
      actor_person_id,
      expected_name_revision,
      expected_contact_revision,
      committed_name_revision,
      committed_contact_revision
    ) VALUES (
      ${command.commandId},
      ${commandDigest},
      ${sql.json(payload)},
      ${sql.json(result)},
      ${actorPersonId},
      ${command.expectedNameRevision},
      ${command.expectedContactRevision},
      ${result.nameRevision},
      ${result.contactRevision}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("write own Profile command receipt", cause)),
    ),
  );

/** Atomically updates the authenticated actor's separate name and contact rows. */
export const updateOwnProfile = (
  input: UpdateOwnProfileInput,
): Effect.Effect<OwnProfile, ProfileFailure, Database> =>
  Effect.gen(function* () {
    const actorPersonId = yield* decodePersonId(input.actorPersonId);
    const command = yield* decodeUpdateOwnProfileCommand(input.command);
    const payload: ProfileCommandPayload = {
      actorPersonId,
      _tag: command._tag,
      commandId: command.commandId,
      expectedNameRevision: command.expectedNameRevision,
      expectedContactRevision: command.expectedContactRevision,
      firstName: command.firstName,
      lastName: command.lastName,
      email: command.email,
      phone: command.phone,
    };
    const commandJson = canonicalJson(payload);
    const commandDigest = sha256Hex(canonicalJsonBytes(payload));
    const sql = yield* Database;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockProfileCommand(sql, command.commandId);
          const receipt = yield* readProfileCommandReceipt(sql, command.commandId);
          if (receipt !== undefined) {
            return yield* replayOwnProfile(
              receipt,
              actorPersonId,
              command,
              commandJson,
              commandDigest,
            );
          }

          // The fixed name-then-contact order prevents cross-command row-lock inversions.
          const profile = yield* lockPersonProfile(sql, actorPersonId);
          if (profile === undefined) {
            return yield* new ProfileNotFound({ personId: actorPersonId });
          }
          const contact = yield* lockPersonContact(sql, actorPersonId);
          if (contact === undefined) {
            return yield* new ProfileContactNotFound({ personId: actorPersonId });
          }
          if (
            profile.revision !== command.expectedNameRevision ||
            contact.revision !== command.expectedContactRevision
          ) {
            return yield* new ProfileStaleRevision({
              personId: actorPersonId,
              expectedNameRevision: command.expectedNameRevision,
              actualNameRevision: profile.revision,
              expectedContactRevision: command.expectedContactRevision,
              actualContactRevision: contact.revision,
            });
          }

          const updatedProfile = yield* updatePersonProfile(sql, actorPersonId, command);
          const updatedContact = yield* updatePersonContact(sql, actorPersonId, command);
          const result = yield* decodeOwnProfileValue({
            personId: actorPersonId,
            firstName: updatedProfile.firstName,
            lastName: updatedProfile.lastName,
            email: updatedContact.email,
            phone: updatedContact.phone,
            nameRevision: updatedProfile.revision,
            contactRevision: updatedContact.revision,
          });
          yield* writeProfileCommandReceipt(
            sql,
            actorPersonId,
            command,
            payload,
            commandDigest,
            result,
          );
          return result;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("update own Profile transaction", cause)),
        ),
      );
  });

const DIRECTORY_CURSOR_VERSION = "v1";

interface DirectoryJoinedRow {
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
}

/** Encodes the last sort tuple as an opaque, strictly decodable cursor. */
export const encodeDirectoryCursor = (entry: {
  readonly lastName: string;
  readonly firstName: string;
  readonly personId: string;
}): string =>
  Buffer.from(
    JSON.stringify([DIRECTORY_CURSOR_VERSION, entry.lastName, entry.firstName, entry.personId]),
    "utf8",
  ).toString("base64");

/**
 * Decodes a directory cursor. Anything malformed — bad base64, wrong shape,
 * unknown version — is the typed decode failure the HTTP layer maps to 422.
 */
export const decodeDirectoryCursor = (
  cursor: string,
): Effect.Effect<{ lastName: string; firstName: string; personId: string }, ProfileDecodeError> =>
  Effect.gen(function* () {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    } catch {
      return yield* new ProfileDecodeError({ message: "malformed Profile directory cursor" });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== DIRECTORY_CURSOR_VERSION ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string" ||
      typeof parsed[3] !== "string"
    ) {
      return yield* new ProfileDecodeError({ message: "malformed Profile directory cursor" });
    }
    return { lastName: parsed[1], firstName: parsed[2], personId: parsed[3] };
  });

/**
 * Scans one page of the directory from a single snapshot. Ordering is
 * lastName, then firstName, then personId; the keyset predicate resumes
 * strictly after the decoded cursor tuple so page boundaries neither
 * duplicate nor drop a person. A scanned person without a contact row is the
 * typed ProfileContactNotFound failure: the directory never fabricates
 * contact values and never silently drops the row.
 */
export const readDirectoryPage = (
  input: ReadDirectoryPageInput,
): Effect.Effect<DirectoryPage, ProfileFailure, Database | Organization> =>
  Effect.gen(function* () {
    // Keep Organization explicit in the Profile composition graph, matching
    // every other Profile read; Organization owns each row's departments and
    // activity while Profile owns names and contacts.
    yield* Organization;
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      return yield* new ProfileQueryLimitExceeded({ limit: input.limit });
    }
    const cursorTuple =
      input.cursor === undefined ? undefined : yield* decodeDirectoryCursor(input.cursor);
    const sql = yield* Database;
    const rows = yield* sql<DirectoryJoinedRow>`
      SELECT
        profile.person_id AS "personId",
        profile.first_name AS "firstName",
        profile.last_name AS "lastName",
        contact.email,
        contact.phone
      FROM person_profiles AS profile
      LEFT JOIN person_contact_profiles AS contact
        ON contact.person_id = profile.person_id
      WHERE ${cursorTuple === undefined}
        OR (
          profile.last_name, profile.first_name, profile.person_id
        ) > (${cursorTuple?.lastName}, ${cursorTuple?.firstName}, ${cursorTuple?.personId})
      ORDER BY profile.last_name ASC, profile.first_name ASC, profile.person_id ASC
      LIMIT ${input.limit + 1}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read Profile directory page", cause)),
      ),
    );
    const entries: Array<DirectoryEntry> = [];
    for (const row of rows) {
      if (row.email === null || row.phone === null) {
        return yield* new ProfileContactNotFound({ personId: PersonId.make(row.personId) });
      }
      entries.push({
        personId: PersonId.make(row.personId),
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        phone: row.phone,
      });
    }
    if (entries.length <= input.limit) return { entries };
    const last = entries[input.limit - 1]!;
    return {
      entries: entries.slice(0, input.limit),
      nextCursor: encodeDirectoryCursor(last),
    };
  });
