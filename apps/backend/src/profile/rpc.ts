/**
 * The ProfileRpcs handlers: the caller's own profile.
 *
 * A read resolves the caller's organization authority, evaluates the owner-only AccessSpec, and
 * answers the profile beside its strong entity tag. An update applies a JSON merge patch inside
 * the serializable transaction that resolves the credential again, compares `ifMatch` with the
 * current tag there, and stores its answer as a command receipt.
 */
import { readOwnProfileHttpSourcePostgres } from "@vektorprogrammet/database/profile";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { ResourceId, ResourceKind } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type {
  OrganizationPersonAuthority,
  PersonId,
  ProfileRole,
} from "@vektorprogrammet/domain/organization";
import {
  type OwnProfile,
  Profile,
  ProfileCommandId,
  UpdateOwnProfileCommand,
  type ProfileFailure,
} from "@vektorprogrammet/domain/profile";
import {
  type OwnProfileResource,
  type ProfileMergePatch,
  ProfileRpcs,
  ReadOwnProfile,
  UpdateOwnProfile,
  UserProfileResponse,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import {
  type CredentialPresentation,
  makeNativeValidationError,
  Problem,
  StrongETag,
} from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Match, Option, Predicate, Schema } from "effect";
import {
  profileRoleFrom,
  resolveRequestPersonAuthority,
  resolveRequestPersonAuthorityInTransaction,
  type OrganizationResolutionError,
} from "../authority.js";
import {
  deriveProfileStrongETag,
  jsonBodyBytes,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizePerson,
  commandIdentity,
  commandReceiptProblems,
  personPresentation,
  problemMapper,
  requestInvalid,
  requireCurrentETag,
  strictOutput,
  unreachable,
} from "../rpc/problem.js";
import {
  executeNativeHttpCommandPostgres,
  NativeHttpReceiptInvalid,
  type NativeHttpCommandOutcome,
  type NativeHttpResponseCapsule,
} from "../rpc/receipt-transaction.js";

interface ProfileActor {
  readonly personId: PersonId;
  readonly role: ProfileRole;
}

/**
 * The one answer for every profile failure; a rejected credential is answered from the request's
 * own credential evidence.
 */
const profileProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    ProfileFailure | OrganizationResolutionError | IdentityEngineError | UnauthenticatedActor
  >()({
    ProfileNotFound: () => Problem.make("profile.not-found"),
    ProfileContactNotFound: () => Problem.make("profile.not-found"),
    ProfileDecodeError: requestInvalid,
    ProfileStaleRevision: () => Problem.make("precondition.failed"),
    ProfileCommandConflict: () => Problem.make("idempotency.digest-conflict"),
    ProfilePersistenceError: () => Problem.make("profile.unavailable"),
    ProfileQueryLimitExceeded: () => Problem.make("profile.unavailable"),
    OrganizationDecodeError: () => Problem.make("profile.unavailable"),
    OrganizationPersistenceError: () => Problem.make("profile.unavailable"),
    IdentityEngineError: () => Problem.make("profile.unavailable"),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
  });

/** The dashboard role of an authority; a person without one is denied or unauthenticated. */
const profileActor = (authority: OrganizationPersonAuthority) => {
  const decision = profileRoleFrom(authority);

  if (Predicate.isTagged(decision, "Deny")) {
    return Effect.fail(
      decision.reason === "Unauthenticated"
        ? UnauthenticatedActor.make({ message: "Authentication required" })
        : Problem.make("authority.denied"),
    );
  }

  return Effect.succeed<ProfileActor>({ personId: authority.personId, role: decision.value });
};

/** The owner-only AccessSpec input shared by both profile operations. */
const ownProfileAuthorization = (actor: ProfileActor) => ({
  personId: actor.personId,
  resolution: {
    selection: "ExactlyOne" as const,
    contexts: [
      genericContext({
        domainId: "profile",
        resourceKind: "person-profile",
        resourceId: actor.personId,
        facts: { ownerPersonId: actor.personId },
        authorityVersion: `profile:${actor.role}`,
      }),
    ],
  },
  grantScopes: [
    {
      _tag: "Resource" as const,
      resource: {
        kind: ResourceKind.make("person-profile"),
        id: ResourceId.make(actor.personId),
      },
    },
  ],
});

/** The profile representation: the stored profile and the caller's dashboard role. */
const profileRepresentation = (profile: OwnProfile, role: ProfileRole) => ({
  personId: profile.personId,
  firstName: profile.firstName,
  lastName: profile.lastName,
  email: profile.email,
  phone: profile.phone,
  role,
  nameRevision: profile.nameRevision,
  contactRevision: profile.contactRevision,
});

/** A stored profile that does not fit its representation is a server defect, never the caller's. */
const readProfileSource = (personId: PersonId) =>
  readOwnProfileHttpSourcePostgres(personId).pipe(
    Effect.catchTag("ProfileDecodeError", (cause) => Effect.die(cause)),
  );

type ProfileSource = Effect.Success<ReturnType<typeof readProfileSource>>;

const profileETag = (source: ProfileSource) =>
  deriveProfileStrongETag({
    personId: source.profile.personId,
    nameRevision: source.profile.nameRevision,
    contactRevision: source.profile.contactRevision,
    representationRevision: source.representationRevision,
  });

const patchFields = ["firstName", "lastName", "email", "phone"] as const;

/**
 * The merge patch semantics of RFC 7396 that a profile admits: at least one member, and no member
 * set to `null`, because no profile field can be deleted.
 */
const requireApplicablePatch = (patch: ProfileMergePatch) => {
  if (!patchFields.some((field) => Object.hasOwn(patch, field))) {
    return Effect.fail(
      Problem.validation("validation.no-change", [makeNativeValidationError("", "no-change")]),
    );
  }

  if (patchFields.some((field) => Object.hasOwn(patch, field) && patch[field] === null)) {
    return Effect.fail(
      Problem.validation("validation.field-not-deletable", [
        makeNativeValidationError("", "field-not-deletable"),
      ]),
    );
  }

  return Effect.void;
};

const ProfileBodyJson = Schema.fromJsonString(Schema.toCodecJson(UserProfileResponse));

/**
 * The receipt of a profile update, byte for byte what the HTTP contract stored: the profile as the
 * JSON body, and its entity tag as the `etag` header. A retry that straddles the cutover from HTTP
 * therefore replays the first answer.
 */
const profileCapsule = (resource: OwnProfileResource) =>
  Schema.encodeEffect(Schema.toCodecJson(UserProfileResponse))(resource.profile).pipe(
    Effect.orDie,
    Effect.map(
      (body): NativeHttpResponseCapsule => ({
        status: 200,
        mediaType: "application/json",
        headers: { "content-type": "application/json", etag: resource.etag },
        bodyBytes: jsonBodyBytes(body),
      }),
    ),
  );

/** The profile and entity tag that a profile update receipt stores; a mismatch is a defect. */
const storedProfile = (capsule: NativeHttpResponseCapsule) =>
  Effect.gen(function* () {
    if (capsule.bodyBytes === null || capsule.headers.etag === undefined) {
      return yield* Effect.die(
        new NativeHttpReceiptInvalid({ reason: "a profile receipt stores no profile" }),
      );
    }

    const profile = yield* Schema.decodeEffect(ProfileBodyJson)(
      new TextDecoder().decode(capsule.bodyBytes),
    ).pipe(Effect.orDie);

    const etag = yield* Schema.decodeEffect(StrongETag)(capsule.headers.etag).pipe(Effect.orDie);

    return { profile, etag } satisfies OwnProfileResource;
  });

const profileOutcome = (outcome: NativeHttpCommandOutcome) =>
  Match.value(outcome).pipe(
    Match.tag("Committed", "Replay", ({ response }) => storedProfile(response)),
    Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
    Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
    Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
    Match.exhaustive,
  );

/** The ProfileRpcs handlers. */
export const ProfileRpcHandlers = (options: NativeRpcOptions) =>
  ProfileRpcs.toLayer({
    "profile.readOwnProfile": (_payload, { headers }) => {
      const presentation = personPresentation(headers);
      const request = credentialRequestOf(headers);

      return Effect.gen(function* () {
        const actor = yield* resolveRequestPersonAuthority(request, { now: options.now }).pipe(
          Effect.flatMap(profileActor),
        );

        const now = DateTime.formatIso(yield* DateTime.now);

        yield* authorizePerson(
          {
            spec: Option.getOrThrow(reflectAccessSpec(ReadOwnProfile)),
            request,
            ...ownProfileAuthorization(actor),
            now,
          },
          presentation,
        );

        const source = yield* readProfileSource(actor.personId);

        const profile = yield* strictOutput(UserProfileResponse)(
          profileRepresentation(source.profile, actor.role),
        );

        return { profile, etag: profileETag(source) } satisfies OwnProfileResource;
      }).pipe(
        profileProblems(presentation),
        // Reveal concealment never hides the profile, and a read neither replays nor writes.
        unreachable("resource.not-found", "idempotency.digest-conflict", "precondition.failed"),
      );
    },

    "profile.updateOwnProfile": ({ idempotencyKey, ifMatch, request: patch }, { headers }) => {
      const presentation = personPresentation(headers);
      const operationId = "profile.updateOwnProfile";

      return Effect.gen(function* () {
        yield* requireApplicablePatch(patch);

        // Failures are mapped once, after the executor, which adds its own receipt failures.
        const outcome = yield* executeNativeHttpCommandPostgres(
          Effect.gen(function* () {
            const resolved = yield* resolveRequestPersonAuthorityInTransaction(
              credentialRequestOf(headers),
            );

            const actor = yield* profileActor(resolved.authority);

            yield* authorizePerson(
              {
                spec: Option.getOrThrow(reflectAccessSpec(UpdateOwnProfile)),
                credential: resolved.credential,
                ...ownProfileAuthorization(actor),
                now: resolved.authorizationInstant,
              },
              presentation,
            );

            const currentSource = yield* readProfileSource(actor.personId);
            const current = currentSource.profile;

            // The HTTP route stays the normalized target, so receipts and command IDs are stable.
            const identity = yield* commandIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/profile",
              idempotencyKey,
            });

            return {
              identity: {
                identitySha256: identity.identitySha256,
                requestSha256: semanticRequestDigest(semanticMutationRequest(patch, ifMatch)),
                operationId,
              },
              // A receipt lookup precedes the precondition, so a replay after this command's own
              // write still answers its stored response, and a changed body under the same key
              // is a digest conflict rather than a stale precondition.
              execute: Effect.gen(function* () {
                yield* requireCurrentETag(profileETag(currentSource), ifMatch);

                yield* Profile.use((profileService) =>
                  profileService.updateOwnProfile({
                    actorPersonId: actor.personId,
                    command: UpdateOwnProfileCommand.make({
                      commandId: ProfileCommandId.make(identity.commandId),
                      expectedNameRevision: current.nameRevision,
                      expectedContactRevision: current.contactRevision,
                      firstName: patch.firstName ?? current.firstName,
                      lastName: patch.lastName ?? current.lastName,
                      email: patch.email ?? current.email,
                      phone: patch.phone ?? current.phone,
                    }),
                  }),
                );

                const updatedSource = yield* readProfileSource(actor.personId);

                const profile = yield* strictOutput(UserProfileResponse)(
                  profileRepresentation(updatedSource.profile, actor.role),
                );

                return yield* profileCapsule({ profile, etag: profileETag(updatedSource) });
              }),
            };
          }),
        ).pipe(
          profileProblems(presentation),
          commandReceiptProblems,
          // Reveal concealment never hides the caller's own profile.
          unreachable("resource.not-found"),
        );

        return yield* profileOutcome(outcome);
      });
    },
  });
