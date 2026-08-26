import { Schema } from "effect";
import { PersonId } from "../organization/schema.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
  ),
);

export const SessionToken = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => value.length >= 32 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value),
      { message: "a session token string" },
    ),
  ),
);
export type SessionToken = typeof SessionToken.Type;

/**
 * The only fact authorization may learn from the identity schema: which
 * canonical person holds this session, and until when.
 */
export class IdentityActor extends Schema.Class<IdentityActor>("IdentityActor")({
  personId: PersonId,
  sessionId: NonEmpty,
  expiresAt: Schema.DateTimeUtcFromDate,
}) {}

/** Decodes an engine-native actor row into the canonical domain shape. */
export const decodeIdentityActor = Schema.decodeUnknownEffect(IdentityActor);

export interface IdentitySignInInput {
  readonly email: string;
  readonly password: string;
}

export interface IdentitySignInSuccess {
  /** Set-Cookie header value to forward verbatim on the response. */
  readonly setCookie: string;
  readonly actor: IdentityActor;
}
