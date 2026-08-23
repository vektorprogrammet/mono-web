import { Context, Effect } from "effect";
import type { PersonId } from "../organization/schema.js";
import type { ProfileFailure } from "./errors.js";
import type { PersonContactProfile, PersonProfile } from "./schema.js";

export interface ProfileShape {
  /** Reads a bounded set of canonical names and fails if any requested person is missing. */
  readonly readProfiles: (
    personIds: ReadonlyArray<PersonId>,
  ) => Effect.Effect<ReadonlyArray<PersonProfile>, ProfileFailure>;
  /** Reads canonical staff contacts and fails if any requested contact is missing. */
  readonly readContacts: (
    personIds: ReadonlyArray<PersonId>,
  ) => Effect.Effect<ReadonlyArray<PersonContactProfile>, ProfileFailure>;
}

export class Profile extends Context.Service<Profile, ProfileShape>()(
  "@vektorprogrammet/domain/Profile",
) {}
