/**
 * The backend implementations of the credential middlewares of `@vektorprogrammet/rpc`.
 *
 * Each authenticates the credential that its RPCs accept from the request headers that RPC over
 * HTTP carries, and answers a rejected credential from the ingress evidence, as the HTTP security
 * middleware did. None grants authority: a handler resolves the credential and the authority again
 * inside the transaction that commits its command.
 */
import { timingSafeEqual } from "node:crypto";
import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { CONTACT_BACKEND_HEADER } from "@vektorprogrammet/domain/contact";
import { Identity } from "@vektorprogrammet/domain/identity";
import {
  ContactBackendCredential,
  InvitationCapabilityCredential,
  PersonCredential,
  PersonOrServiceCredential,
  SessionCredential,
} from "@vektorprogrammet/rpc";
import {
  credentialPresentation,
  invitationCapabilityChallenge,
  nativeCookieChallenge,
  nativeUserChallenges,
  Problem,
} from "@vektorprogrammet/rpc/problem";
import { Effect, Layer, Result, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  headerCredentialCount,
  resolveAuthenticatedSession,
  resolveRequestCredentialAtInstant,
  resolveRequestPerson,
} from "../authority.js";
import type { ContactConfig } from "../contact/config.js";
import { classifyCredential } from "./problem.js";

/**
 * The web request that the credential resolvers of `authority.ts` read. They read only the
 * `cookie` and `authorization` headers; the URL names no route.
 */
export const credentialRequestOf = (headers: Headers.Headers): Request =>
  new Request("http://native-rpc.invalid/api/rpc", { method: "POST", headers });

const isUnauthenticated = Schema.is(UnauthenticatedActor);

/** Absence is read from the headers: a presented credential that failed is invalid. */
const rejectCredential = (headers: Headers.Headers, challenge: string) =>
  Effect.fail(
    Problem.unauthenticated(classifyCredential(headers.authorization, headers.cookie, challenge)),
  );

/**
 * Runs `authenticate` only when the request presents a credential. A request with neither a
 * session cookie nor an Authorization header is answered credential.missing without asking the
 * identity engine.
 */
const whenPresented = <A, E, R>(
  headers: Headers.Headers,
  challenge: string,
  authenticate: Effect.Effect<A, E, R>,
) =>
  headerCredentialCount(headers.cookie, headers.authorization) === 0
    ? rejectCredential(headers, challenge)
    : authenticate;

const SessionCredentialLive = Layer.effect(SessionCredential)(
  Effect.map(Identity, (identity) =>
    SessionCredential.of((effect, { headers }) =>
      whenPresented(
        headers,
        nativeCookieChallenge,
        Effect.gen(function* () {
          const authentication = yield* Effect.result(
            resolveAuthenticatedSession(headers.cookie, headers.authorization).pipe(
              Effect.provideService(Identity, identity),
            ),
          );

          if (Result.isFailure(authentication) && isUnauthenticated(authentication.failure)) {
            return yield* rejectCredential(headers, nativeCookieChallenge);
          }

          return yield* effect;
        }),
      ),
    ),
  ),
);

const PersonCredentialLive = Layer.effect(PersonCredential)(
  Effect.gen(function* () {
    const identity = yield* Identity;
    const oauthCredentialAuthority = yield* OAuthCredentialAuthority;

    return PersonCredential.of((effect, { headers }) =>
      whenPresented(
        headers,
        nativeUserChallenges(),
        Effect.gen(function* () {
          const authentication = yield* Effect.result(
            resolveRequestPerson(credentialRequestOf(headers)).pipe(
              Effect.provideService(Identity, identity),
              Effect.provideService(OAuthCredentialAuthority, oauthCredentialAuthority),
            ),
          );

          if (Result.isFailure(authentication) && isUnauthenticated(authentication.failure)) {
            return yield* rejectCredential(headers, nativeUserChallenges());
          }

          return yield* effect;
        }),
      ),
    );
  }),
);

const PersonOrServiceCredentialLive = Layer.effect(PersonOrServiceCredential)(
  Effect.gen(function* () {
    const identity = yield* Identity;
    const oauthCredentialAuthority = yield* OAuthCredentialAuthority;

    return PersonOrServiceCredential.of((effect, { headers }) =>
      whenPresented(
        headers,
        nativeUserChallenges(),
        Effect.gen(function* () {
          const authentication = yield* Effect.result(
            resolveRequestCredentialAtInstant(credentialRequestOf(headers), "Either").pipe(
              Effect.provideService(Identity, identity),
              Effect.provideService(OAuthCredentialAuthority, oauthCredentialAuthority),
            ),
          );

          if (Result.isFailure(authentication) && isUnauthenticated(authentication.failure)) {
            return yield* rejectCredential(headers, nativeUserChallenges());
          }

          return yield* effect;
        }),
      ),
    );
  }),
);

/** The capability travels in the payload; a cookie or bearer beside it is a second credential. */
const InvitationCapabilityCredentialLive = Layer.succeed(InvitationCapabilityCredential)(
  InvitationCapabilityCredential.of((effect, { headers }) =>
    headerCredentialCount(headers.cookie, headers.authorization) > 0
      ? Effect.fail(
          Problem.credentialInvalid(
            credentialPresentation({ presented: true, challenge: invitationCapabilityChallenge }),
          ),
        )
      : effect,
  ),
);

const contactBackendCredentialLayer = (contact: ContactConfig | undefined) => {
  const expected = contact === undefined ? undefined : Buffer.from(contact.backendToken);

  return Layer.succeed(ContactBackendCredential)(
    ContactBackendCredential.of((effect, { headers }) => {
      if (expected === undefined) return effect;

      const header = headers[CONTACT_BACKEND_HEADER];

      const supplied = Buffer.from(header ?? "");

      // A request without the header presented no credential; a wrong token presented an invalid one.
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
        ? effect
        : Effect.fail(
            Problem.unauthenticated(
              credentialPresentation({
                presented: header !== undefined,
                challenge: 'ContactSSR realm="native-contact"',
              }),
            ),
          );
    }),
  );
};

/** Every credential middleware, for the composition root. */
export const nativeRpcCredentialLayer = (contact?: ContactConfig) =>
  Layer.mergeAll(
    SessionCredentialLive,
    PersonCredentialLive,
    PersonOrServiceCredentialLive,
    InvitationCapabilityCredentialLive,
    contactBackendCredentialLayer(contact),
  );
