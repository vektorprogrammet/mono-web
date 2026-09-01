import { Schema } from "effect";
import { PersonId } from "../organization/schema.js";

const boundedString = (maximumLength: number, message: string) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter(
        (value) => value.length > 0 && value.length <= maximumLength && !/\p{Cc}/u.test(value),
        { message },
      ),
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

export const IdentitySessionId = boundedString(128, "a bounded opaque session identifier");
export type IdentitySessionId = typeof IdentitySessionId.Type;

const RequestCorrelation = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value),
      { message: "a bounded request correlation" },
    ),
  ),
);

const SourceIp = Schema.NullOr(
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter(
        (value) => value.length > 0 && value.length <= 64 && /^[A-Fa-f0-9.:]+$/u.test(value),
        { message: "a sanitized source IP" },
      ),
    ),
  ),
);

const UserAgent = Schema.NullOr(boundedString(256, "a bounded user agent"));

/**
 * Sanitized request evidence passed into the identity persistence boundary.
 * It contains no raw headers, cookies, request bodies, or credentials.
 */
export class IdentityRequestContext extends Schema.Class<IdentityRequestContext>(
  "IdentityRequestContext",
)({
  requestCorrelation: RequestCorrelation,
  sourceIp: SourceIp,
  userAgent: UserAgent,
}) {}

/**
 * The only fact authorization may learn from the identity schema: which
 * canonical person holds this session, and until when.
 */
export class IdentityActor extends Schema.Class<IdentityActor>("IdentityActor")({
  personId: PersonId,
  sessionId: IdentitySessionId,
  expiresAt: Schema.DateTimeUtcFromDate,
}) {}

/** Decodes an engine-native actor row into the canonical domain shape. */
export const decodeIdentityActor = Schema.decodeUnknownEffect(IdentityActor);

/** Credential-free metadata exposed by the native session resources. */
export class IdentitySession extends Schema.Class<IdentitySession>("IdentitySession")({
  sessionId: IdentitySessionId,
  createdAt: Schema.DateTimeUtcFromDate,

  updatedAt: Schema.DateTimeUtcFromDate,
  expiresAt: Schema.DateTimeUtcFromDate,
  ipAddress: SourceIp,
  userAgent: UserAgent,
  current: Schema.Boolean,
}) {}

export const decodeIdentitySession = Schema.decodeUnknownEffect(IdentitySession);

export const IdentitySecurityEventKind = Schema.Literals([
  "sign-in-success",
  "sign-in-failure",
  "sign-out",
  "session-revoked-one",
  "session-revoked-others",
  "session-revoked-all",
  "sign-up-rejected",
  "trusted-origin-csrf-rejected",
  "account-provisioned-administratively",
  "session-provisioned-administratively",
]);
export type IdentitySecurityEventKind = typeof IdentitySecurityEventKind.Type;

export const IdentitySecurityOutcomeCode = Schema.Literals([
  "credential-accepted",
  "credential-rejected",
  "current-session-ended",
  "owned-session-revoked",
  "other-sessions-revoked",
  "all-sessions-revoked",
  "public-sign-up-disabled",
  "origin-not-trusted",
  "account-provisioned",
  "session-provisioned",
]);
export type IdentitySecurityOutcomeCode = typeof IdentitySecurityOutcomeCode.Type;

const AffectedSessionCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000)),
);

/** Closed, bounded, non-secret detail shape persisted with every security event. */
export class IdentitySecurityEventDetails extends Schema.Class<IdentitySecurityEventDetails>(
  "IdentitySecurityEventDetails",
)({
  outcomeCode: IdentitySecurityOutcomeCode,
  affectedSessionCount: Schema.NullOr(AffectedSessionCount),
}) {}

const ActorPrincipal = Schema.NullOr(boundedString(256, "a bounded actor principal"));

/** Input to the owned append-only identity security audit adapter. */
export class IdentitySecurityEvent extends Schema.Class<IdentitySecurityEvent>(
  "IdentitySecurityEvent",
)({
  eventKind: IdentitySecurityEventKind,
  subjectPersonId: Schema.NullOr(PersonId),
  sessionId: Schema.NullOr(IdentitySessionId),
  actorPrincipal: ActorPrincipal,
  requestCorrelation: Schema.NullOr(RequestCorrelation),
  sourceIp: SourceIp,
  userAgent: UserAgent,
  details: IdentitySecurityEventDetails,
}) {}

export interface IdentitySignInInput {
  readonly email: string;
  readonly password: string;
}

export interface IdentitySignInSuccess {
  /** Set-Cookie header value to forward verbatim on the response. */
  readonly setCookie: string;
  readonly actor: IdentityActor;
}

export interface IdentitySessionMutationSuccess {
  /** Credential-clearing cookie headers emitted by Better Auth, when applicable. */
  readonly setCookies: ReadonlyArray<string>;
}
