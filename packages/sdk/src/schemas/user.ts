/**
 * User schemas — shared between auth and admin domains.
 */

import { Schema } from "effect"

export class LoginResponse extends Schema.Class<LoginResponse>("LoginResponse")({
  token: Schema.String,
}) {}

export class User extends Schema.Class<User>("User")({
  id: Schema.Number,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  role: Schema.String,
}) {}

export class UserProfile extends Schema.Class<UserProfile>("UserProfile")({
  id: Schema.NullOr(Schema.Number),
  firstName: Schema.String,
  lastName: Schema.String,
  userName: Schema.NullOr(Schema.String),
  email: Schema.String,
  phone: Schema.NullOr(Schema.String),
  gender: Schema.NullOr(Schema.Number),
  fieldOfStudy: Schema.NullOr(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      shortName: Schema.String,
    }),
  ),
  accountNumber: Schema.NullOr(Schema.String),
  role: Schema.String,
  profilePhoto: Schema.NullOr(Schema.String),
}) {}
