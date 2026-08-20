/**
 * User schemas — shared between auth and admin domains.
 */

import { Effect, Schema } from "effect"

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
  id: Schema.NullOr(Schema.Number).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  firstName: Schema.String,
  lastName: Schema.String,
  userName: Schema.NullOr(Schema.String).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  email: Schema.String,
  phone: Schema.NullOr(Schema.String).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  gender: Schema.NullOr(Schema.Number).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  fieldOfStudy: Schema.NullOr(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      shortName: Schema.String,
    }),
  ).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  accountNumber: Schema.NullOr(Schema.String).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  role: Schema.String,
  profilePhoto: Schema.NullOr(Schema.String).pipe(
    Schema.optional,
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
}) {}
