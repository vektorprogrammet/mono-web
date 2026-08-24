/**
 * User schemas — shared between auth and admin domains.
 */

import { Schema } from "effect"

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
  ),
)
const ProfilePersonId = NonEmpty.pipe(Schema.brand("ProfilePersonId"))
const Name = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty name" }),
    Schema.isMaxLength(100),
  ),
)
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const Email = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const separator = value.indexOf("@")
        return (
          value.length <= 320 &&
          separator > 0 &&
          separator === value.lastIndexOf("@") &&
          separator < value.length - 1 &&
          !/[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
        )
      },
      { message: "a valid email address" },
    ),
  ),
)
const Phone = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => {
        const normalized = value.trim()
        return (
          normalized.length > 0 &&
          normalized.length <= 32 &&
          /^[+\d][\d\s().-]*$/u.test(normalized)
        )
      },
      { message: "a valid phone number" },
    ),
  ),
)

export const SessionActor = Schema.Struct({
  personId: ProfilePersonId,
  /** Backend session contract: ISO instant of the underlying auth session. */
  expiresAt: Schema.optional(Schema.String),
})
export type SessionActor = typeof SessionActor.Type

export class User extends Schema.Class<User>("User")({
  id: Schema.Number,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  role: Schema.String,
}) {}

export const ProfileCommandId = NonEmpty.pipe(Schema.brand("ProfileCommandId"))
export type ProfileCommandId = typeof ProfileCommandId.Type

export const UserRole = Schema.Literals([
  "ROLE_ADMIN",
  "ROLE_TEAM_LEADER",
  "ROLE_TEAM_MEMBER",
])
export type UserRole = typeof UserRole.Type

export const UpdateOwnProfileCommand = Schema.Struct({
  _tag: Schema.Literals(["UpdateOwnProfile"]),
  commandId: ProfileCommandId,
  expectedNameRevision: Revision,
  expectedContactRevision: Revision,
  firstName: Name,
  lastName: Name,
  email: Email,
  phone: Phone,
})
export type UpdateOwnProfileCommand = typeof UpdateOwnProfileCommand.Type

export const UserProfile = Schema.Struct({
  personId: ProfilePersonId,
  firstName: Name,
  lastName: Name,
  email: Email,
  phone: Phone,
  role: UserRole,
  nameRevision: Revision,
  contactRevision: Revision,
})
export type UserProfile = typeof UserProfile.Type
