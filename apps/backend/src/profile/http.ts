import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { readOwnProfileHttpSourcePostgres } from "@vektorprogrammet/database/profile";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { ResourceId, ResourceKind } from "@vektorprogrammet/domain/authz";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type {
  Organization,
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
  ExternalNativeApi,
  ProfileMergePatch,
  ReadOwnProfileEndpoint,
  UpdateOwnProfileEndpoint,
  UserProfileResponse,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import {
  type CredentialPresentation,
  makeNativeValidationError,
  Problem,
} from "@vektorprogrammet/http-api/http-semantics";
import { DateTime, Effect, Option, Predicate, type Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  profileRoleFrom,
  resolveRequestPersonAuthorityInTransaction,
  type OrganizationResolutionError,
} from "../authority.js";
import type { BackendConfig } from "../config.js";
import {
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  conditionalJson,
  decodeRequest,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  problemMapper,
  requestInvalid,
  requireCurrentETag,
  requiredIfMatchOf,
  strictOutput,
  unreachable,
  webHandler,
} from "../http-api/problem.js";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  deriveProfileStrongETag,
  jsonBodyBytes,
  PRIVATE_NO_STORE,
  semanticMutationRequest,
  semanticRequestDigest,
} from "../http-semantics.js";
import { genericContext } from "../native-operation.js";

export interface ProfileApiHttpOptions {
  readonly config: BackendConfig;
  /** Cookie or delegated bearer -> the current organization authority of that person. */
  readonly resolveActor: (
    request: Request,
  ) => Effect.Effect<
    OrganizationPersonAuthority,
    IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError,
    Identity | OAuthCredentialAuthority | Organization
  >;
}

interface ProfileActor {
  readonly personId: PersonId;
  readonly role: ProfileRole;
}

/**
 * The one answer for every profile failure; a rejected credential is answered
 * from the request's own credential evidence.
 *
 * @construct http-problem
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
        ? new UnauthenticatedActor({ message: "Authentication required" })
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

const readJsonPatch = (request: Request) =>
  Effect.gen(function* () {
    if (
      !/^application\/merge-patch\+json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")
    ) {
      return yield* Problem.make("media-type.unsupported");
    }

    // The merge patch is read without a size bound or duplicate-member check, as before.
    const body = yield* Effect.tryPromise({
      try: async (): Promise<Schema.Json> => JSON.parse(await request.text()),
      catch: () => Problem.make("request.malformed"),
    });

    const patch = yield* decodeRequest(ProfileMergePatch)(body);
    const fields = ["firstName", "lastName", "email", "phone"] as const;

    if (!fields.some((field) => Object.hasOwn(patch, field))) {
      return yield* Problem.validation("validation.no-change", [
        makeNativeValidationError("", "no-change"),
      ]);
    }

    if (fields.some((field) => Object.hasOwn(patch, field) && patch[field] === null)) {
      return yield* Problem.validation("validation.field-not-deletable", [
        makeNativeValidationError("", "field-not-deletable"),
      ]);
    }

    return patch;
  });

const readOwnProfile = (request: Request, input: ProfileApiHttpOptions) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const actor = yield* input.resolveActor(request).pipe(Effect.flatMap(profileActor));
    const now = DateTime.formatIso(yield* DateTime.now);

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(ReadOwnProfileEndpoint)),
        request,
        ...ownProfileAuthorization(actor),
        now,
      },
      presentation,
    );

    const source = yield* readProfileSource(actor.personId);
    const profile = source.profile;

    const body = yield* strictOutput(UserProfileResponse)(
      profileRepresentation(profile, actor.role),
    );

    return yield* conditionalJson({
      request,
      body,
      etag: deriveProfileStrongETag({
        personId: profile.personId,
        nameRevision: profile.nameRevision,
        contactRevision: profile.contactRevision,
        representationRevision: source.representationRevision,
      }),
      cacheControl: PRIVATE_NO_STORE,
      contentType: "application/json; charset=utf-8",
    });
  }).pipe(
    profileProblems(presentation),
    // Reveal concealment never hides the profile, and a read never replays a command.
    unreachable("resource.not-found", "idempotency.digest-conflict"),
  );
};

const updateOwnProfile = (request: Request) =>
  Effect.gen(function* () {
    const idempotencyKey = yield* idempotencyKeyOf(request);
    const ifMatch = yield* requiredIfMatchOf(request);
    const patch = yield* readJsonPatch(request);
    const presentation = personPresentation(request);
    const operationId = "profile.updateOwnProfile";

    // Failures are mapped once, after the executor, which adds its own receipt failures.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* resolveRequestPersonAuthorityInTransaction(request);
        const actor = yield* profileActor(resolved.authority);

        yield* authorizePerson(
          {
            spec: Option.getOrThrow(reflectAccessSpec(UpdateOwnProfileEndpoint)),
            credential: resolved.credential,
            ...ownProfileAuthorization(actor),
            now: resolved.authorizationInstant,
          },
          presentation,
        );

        const currentSource = yield* readProfileSource(actor.personId);
        const current = currentSource.profile;

        const identity = yield* httpIdentity({
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
            yield* requireCurrentETag(
              deriveProfileStrongETag({
                personId: current.personId,
                nameRevision: current.nameRevision,
                contactRevision: current.contactRevision,
                representationRevision: currentSource.representationRevision,
              }),
              ifMatch,
            );

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
            const updated = updatedSource.profile;

            return {
              status: 200,
              mediaType: "application/json",
              headers: {
                "content-type": "application/json",
                etag: deriveProfileStrongETag({
                  personId: updated.personId,
                  nameRevision: updated.nameRevision,
                  contactRevision: updated.contactRevision,
                  representationRevision: updatedSource.representationRevision,
                }),
              },
              bodyBytes: jsonBodyBytes(profileRepresentation(updated, actor.role)),
            };
          }),
        };
      }),
    ).pipe(
      profileProblems(presentation),
      commandReceiptProblems,
      // Reveal concealment never hides the caller's own profile.
      unreachable("resource.not-found"),
    );

    return yield* commandOutcomeResponse(outcome);
  });

/** Native HttpApi implementations for self-service profile endpoints. */
export const ProfileApiHandlers = (input: ProfileApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "profile", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readOwnProfile", ({ request }) =>
          webHandler(request, (webRequest) => readOwnProfile(webRequest, input)),
        )
        .handleRaw("updateOwnProfile", ({ request }) => webHandler(request, updateOwnProfile)),
    ),
  );
