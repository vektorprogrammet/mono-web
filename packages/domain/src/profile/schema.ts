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
const Email = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const separator = value.indexOf("@");
        return (
          value.length <= 320 &&
          separator > 0 &&
          separator === value.lastIndexOf("@") &&
          separator < value.length - 1 &&
          !/[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
        );
      },
      { message: "a valid email address" },
    ),
  ),
);
const Phone = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const normalized = value.trim();
        return (
          normalized.length > 0 &&
          normalized.length <= 32 &&
          /^[+\d][\d\s().-]*$/u.test(normalized)
        );
      },
      { message: "a valid phone number" },
    ),
  ),
);
export const PersonContactEmail = Email;
export type PersonContactEmail = typeof PersonContactEmail.Type;
export const PersonContactPhone = Phone;
export type PersonContactPhone = typeof PersonContactPhone.Type;


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
/** Canonical staff contact data used by approved notification requests. */
export class PersonContactProfile extends Model.Class<PersonContactProfile>(
  "Profile.PersonContactProfile",
)({
  personId: Model.Field({
    select: PersonId,
    insert: PersonId,
    json: PersonId,
  }),
  email: Model.Field({
    select: Email,
    insert: Email,
    update: Email,
    json: Email,
    jsonCreate: Email,
    jsonUpdate: Email,
  }),
  phone: Model.Field({
    select: Phone,
    insert: Phone,
    update: Phone,
    json: Phone,
    jsonCreate: Phone,
    jsonUpdate: Phone,
  }),
  revision: Model.GeneratedByDb(Revision),
}) {}

export type PersonContactProfileSelect = typeof PersonContactProfile.Encoded;
export type PersonContactProfileInsert = typeof PersonContactProfile.insert.Encoded;
export type PersonContactProfileUpdate = typeof PersonContactProfile.update.Encoded;
export type PersonContactProfileJson = typeof PersonContactProfile.json.Type;

/** Total display projection; the value is never persisted. */
export const personProfileDisplayName = (
  profile: Pick<PersonProfile, "firstName" | "lastName">,
): string => `${profile.firstName.trim()} ${profile.lastName.trim()}`.trim();
