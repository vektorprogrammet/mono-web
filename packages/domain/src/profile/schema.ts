import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { PersonId } from "../organization/schema.js";

const Name = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty name" }),
    Schema.isMaxLength(100),
  ),
);
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/** The canonical person-name record. Names are owned by Profile, not Recruitment. */
export class PersonProfile extends Model.Class<PersonProfile>("Profile.PersonProfile")({
  personId: Model.Field({
    select: PersonId,
    insert: PersonId,
    json: PersonId,
  }),
  firstName: Model.Field({
    select: Name,
    insert: Name,
    update: Name,
    json: Name,
    jsonCreate: Name,
    jsonUpdate: Name,
  }),
  lastName: Model.Field({
    select: Name,
    insert: Name,
    update: Name,
    json: Name,
    jsonCreate: Name,
    jsonUpdate: Name,
  }),
  revision: Model.GeneratedByDb(Revision),
}) {}

export type PersonProfileSelect = typeof PersonProfile.Encoded;
export type PersonProfileInsert = typeof PersonProfile.insert.Encoded;
export type PersonProfileUpdate = typeof PersonProfile.update.Encoded;
export type PersonProfileJson = typeof PersonProfile.json.Type;
export type PersonProfileJsonCreate = typeof PersonProfile.jsonCreate.Type;
export type PersonProfileJsonUpdate = typeof PersonProfile.jsonUpdate.Type;

/** Total display projection; the value is never persisted. */
export const personProfileDisplayName = (
  profile: Pick<PersonProfile, "firstName" | "lastName">,
): string => `${profile.firstName.trim()} ${profile.lastName.trim()}`.trim();
