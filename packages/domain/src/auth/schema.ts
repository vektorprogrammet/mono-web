import { Schema } from "effect"

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
  ),
)

/** Identity user id IS the canonical PersonId; no separate identity space. */
export const AuthUserId = NonEmpty.pipe(Schema.brand("AuthUserId"))
export type AuthUserId = typeof AuthUserId.Type

export const SessionToken = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => value.length >= 32 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value),
      { message: "a session token string" },
    ),
  ),
)
export type SessionToken = typeof SessionToken.Type

/**
 * The only fact authorization may learn from the auth schema: which person
 * holds this session, and until when. expiresAt is a DateTime.Utc (ms epoch
 * precision) decoded from the engine's native Date - no string round-trip.
 */
export class AuthenticatedActor extends Schema.Class<AuthenticatedActor>("AuthenticatedActor")({
  personId: AuthUserId,
  sessionId: NonEmpty,
  expiresAt: Schema.DateTimeUtcFromDate,
}) {}

/** Decodes an engine-native actor row into the branded domain shape. */
export const decodeAuthenticatedActor = Schema.decodeUnknownEffect(AuthenticatedActor)

export interface SignInInput {
  readonly email: string
  readonly password: string
}

export interface SignInSuccess {
  /** Set-Cookie header value to forward verbatim on the response. */
  readonly setCookie: string
  readonly actor: AuthenticatedActor
}
