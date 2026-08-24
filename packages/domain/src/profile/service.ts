import { Context, Effect } from "effect";
import type { PersonId } from "../organization/schema.js";
import type { ProfileFailure } from "./errors.js";
import type {
  OwnProfile,
  PersonContactProfile,
  PersonProfile,
  UpdateOwnProfileCommand,
} from "./schema.js";

export interface UpdateOwnProfileInput {
  readonly actorPersonId: PersonId;
  readonly command: UpdateOwnProfileCommand;
}

export interface ProfileShape {
  /** Reads a bounded set of canonical names and fails if any requested person is missing. */
  readonly readProfiles: (
    personIds: ReadonlyArray<PersonId>,
  ) => Effect.Effect<ReadonlyArray<PersonProfile>, ProfileFailure>;
  /** Reads canonical staff contacts and fails if any requested contact is missing. */
  readonly readContacts: (
    personIds: ReadonlyArray<PersonId>,
  ) => Effect.Effect<ReadonlyArray<PersonContactProfile>, ProfileFailure>;
  /** Reads the authenticated actor's canonical names and contact data. */
  readonly readOwnProfile: (personId: PersonId) => Effect.Effect<OwnProfile, ProfileFailure>;
  /**
   * Updates only the authenticated actor. The command deliberately has no target person field.
   */
  readonly updateOwnProfile: (
    input: UpdateOwnProfileInput,
  ) => Effect.Effect<OwnProfile, ProfileFailure>;
}

export class Profile extends Context.Service<Profile, ProfileShape>()(
  "@vektorprogrammet/domain/Profile",
) {}
