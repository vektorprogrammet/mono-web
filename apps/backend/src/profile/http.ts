import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { readOwnProfileHttpSourcePostgres } from "@vektorprogrammet/database/profile";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { ResourceId, ResourceKind } from "@vektorprogrammet/domain/authz";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { Organization } from "@vektorprogrammet/domain/organization";
import {
  ProfilePersistenceError,
  OwnProfile,
  Profile,
  UpdateOwnProfileCommand,
  ProfileCommandId,
} from "@vektorprogrammet/domain/profile";
import {
  ExternalNativeApi,
  ProfileMergePatch,
  ReadOwnProfileEndpoint,
  UpdateOwnProfileEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import { Cause, DateTime, Predicate, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  profileRoleFrom,
  resolveRequestPersonAuthorityInTransaction,
  type OrganizationResolutionError,
} from "../authority.js";
import type { BackendConfig } from "../config.js";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveProfileStrongETag,
  evaluateMutationPrecondition,
  evaluateReadPreconditions,
  jsonBodyBytes,
  notModifiedResponse,
  parseIfNoneMatch,
  parseReadIfMatch,
  PRIVATE_NO_STORE,
  nativeProblemResponse,
  parseIdempotencyKey,
  parseRequiredIfMatch,
  semanticRequestDigest,
  semanticMutationRequest,
} from "../http-semantics.js";
import {
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";

export interface ProfileApiHttpOptions {
  readonly config: BackendConfig;
  /**
   * Cookie -> Organization projection -> {personId, role Decision}.
   * Deny(reason) is translated here into the typed profile denial.
   */
  readonly resolveActor: (
    request: Request,
  ) => Effect.Effect<
    ProfileActor,
    IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | TaggedHttpError,
    Identity | OAuthCredentialAuthority | Organization
  >;
}

const UserRole = Schema.Literals(["ROLE_ADMIN", "ROLE_TEAM_LEADER", "ROLE_TEAM_MEMBER"]);

type UserRole = typeof UserRole.Type;

const UserProfile = Schema.Struct({
  personId: OwnProfile.fields.personId,
  firstName: OwnProfile.fields.firstName,
  lastName: OwnProfile.fields.lastName,
  email: OwnProfile.fields.email,
  phone: OwnProfile.fields.phone,
  role: UserRole,
  nameRevision: OwnProfile.fields.nameRevision,
  contactRevision: OwnProfile.fields.contactRevision,
});

type TaggedHttpError = HttpSemanticFailure;

const jsonResponse = (
  body: Schema.Json,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

const errorResponse = (cause: unknown): Response => {
  while (Cause.isUnknownError(cause)) cause = cause.cause;

  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }

  const tag = cause instanceof Error && "_tag" in cause ? String(cause._tag) : "";

  switch (tag) {
    case "UnauthenticatedActor":
    case "IdentitySessionNotFound":
    case "IdentitySessionExpired":
      return nativeProblemResponse("credential.invalid", 401, {
        "www-authenticate": 'VektorSession realm="native-api", Bearer realm="native-api"',
      });
    case "AuthorityInactive":
    case "NotInScope":
      return nativeProblemResponse("authority.denied", 403);
    case "ProfileNotFound":
    case "ProfileContactNotFound":
      return nativeProblemResponse("profile.not-found", 404);
    case "ProfileDecodeError":
      return nativeProblemResponse("validation.failed", 422);
    case "ProfileStaleRevision":
      return nativeProblemResponse("precondition.failed", 412);
    case "ProfileCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "NativeHttpReceiptPersistenceError":
      return nativeProblemResponse("idempotency.unavailable", 503);
    default:
      return nativeProblemResponse("profile.unavailable", 503);
  }
};

interface ProfileActor {
  readonly personId: OwnProfile["personId"];
  readonly role: UserRole;
}

const actorFor = (request: Request, input: ProfileApiHttpOptions) => input.resolveActor(request);

const transactionProfileAuthorityFor = (request: Request) =>
  resolveRequestPersonAuthorityInTransaction(request, {});

/** A stored profile that does not fit its representation is a server defect, never the caller's. */
const readProfileSource = (personId: OwnProfile["personId"]) =>
  readOwnProfileHttpSourcePostgres(personId).pipe(
    Effect.catchTag("ProfileDecodeError", (cause) => Effect.die(cause)),
  );

const decodePatch = (request: Request) =>
  Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";

    if (!/^application\/merge-patch\+json(?:\s*;|$)/iu.test(contentType)) {
      return yield* Effect.fail(new HttpSemanticFailure("media-type.unsupported", 415));
    }

    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => new HttpSemanticFailure("request.malformed", 400),
    });

    const patch = yield* Schema.decodeUnknownEffect(ProfileMergePatch)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422)));

    const fields = ["firstName", "lastName", "email", "phone"] as const;

    if (!fields.some((field) => Object.hasOwn(patch, field))) {
      return yield* Effect.fail(new HttpSemanticFailure("validation.no-change", 422));
    }

    if (fields.some((field) => Object.hasOwn(patch, field) && patch[field] === null)) {
      return yield* Effect.fail(new HttpSemanticFailure("validation.field-not-deletable", 422));
    }

    return patch;
  });

const strictProfileResponse = (
  request: Request,
  profile: OwnProfile,
  role: UserRole,
  representationRevision: number,
) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(UserProfile)(
      {
        personId: profile.personId,
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        role,
        nameRevision: profile.nameRevision,
        contactRevision: profile.contactRevision,
      },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () => new ProfilePersistenceError({ operation: "HTTP", message: "Profile unavailable" }),
      ),
    );

    const etag = deriveProfileStrongETag({
      personId: profile.personId,
      nameRevision: profile.nameRevision,
      contactRevision: profile.contactRevision,
      representationRevision,
    });

    const decision = yield* Effect.try({
      try: () =>
        evaluateReadPreconditions({
          currentETag: etag,
          ifMatch: parseReadIfMatch(
            request.headers.get("if-match") === null ? [] : [request.headers.get("if-match")!],
          ),
          ifNoneMatch: parseIfNoneMatch(
            request.headers.get("if-none-match") === null
              ? []
              : [request.headers.get("if-none-match")!],
          ),
        }),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
    });

    if (Predicate.isTagged(decision, "Failed")) {
      return nativeProblemResponse(decision.code, decision.status);
    }

    if (Predicate.isTagged(decision, "NotModified")) {
      return notModifiedResponse({ etag, cacheControl: PRIVATE_NO_STORE, vary: "Origin" });
    }

    return jsonResponse(decoded, 200, { etag, "cache-control": PRIVATE_NO_STORE });
  });

const readOwnProfile = (request: Request, input: ProfileApiHttpOptions) =>
  Effect.gen(function* () {
    const actor = yield* actorFor(request, input);
    const now = DateTime.formatIso(yield* DateTime.now);

    const personResource = {
      _tag: "Resource" as const,
      resource: {
        kind: ResourceKind.make("person-profile"),
        id: ResourceId.make(actor.personId),
      },
    };

    yield* authorizePersonNativeOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadOwnProfileEndpoint)),
      request,
      personId: actor.personId,
      resolution: {
        selection: "ExactlyOne",
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
      grantScopes: [personResource],
      now,
    });
    const source = yield* readProfileSource(actor.personId);

    return yield* strictProfileResponse(
      request,
      source.profile,
      actor.role,
      source.representationRevision,
    );
  });

const updateOwnProfile = (request: Request) =>
  Effect.gen(function* () {
    const { idempotencyKey, ifMatch } = yield* Effect.try({
      try: () => ({
        idempotencyKey: parseIdempotencyKey(
          request.headers.get("idempotency-key") === null
            ? []
            : [request.headers.get("idempotency-key")!],
        ),
        ifMatch: parseRequiredIfMatch(
          request.headers.get("if-match") === null ? [] : [request.headers.get("if-match")!],
        ),
      }),
      catch: (cause) =>
        cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
    });

    const patch = yield* decodePatch(request);
    const operationId = "profile.updateOwnProfile";

    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const resolved = yield* transactionProfileAuthorityFor(request);
        const roleDecision = profileRoleFrom(resolved.authority);

        if (Predicate.isTagged(roleDecision, "Deny")) {
          return yield* Effect.fail(
            roleDecision.reason === "Unauthenticated"
              ? new UnauthenticatedActor({ message: "Authentication required" })
              : new HttpSemanticFailure("authority.denied", 403),
          );
        }

        const actor: ProfileActor = {
          personId: resolved.authority.personId,
          role: roleDecision.value,
        };

        const personResource = {
          _tag: "Resource" as const,
          resource: {
            kind: ResourceKind.make("person-profile"),
            id: ResourceId.make(actor.personId),
          },
        };

        yield* authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(UpdateOwnProfileEndpoint)),
          credential: resolved.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
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
          grantScopes: [personResource],
          now: resolved.authorizationInstant,
        });
        const currentSource = yield* readProfileSource(actor.personId);
        const current = currentSource.profile;

        const currentETag = deriveProfileStrongETag({
          personId: current.personId,
          nameRevision: current.nameRevision,
          contactRevision: current.contactRevision,
          representationRevision: currentSource.representationRevision,
        });

        const precondition = yield* Effect.try({
          try: () => evaluateMutationPrecondition(currentETag, ifMatch),
          catch: (cause) =>
            cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
        });

        const derived = yield* Effect.try({
          try: () =>
            deriveHttpIdentity({
              credentialSubject: `Person:${actor.personId}`,
              qualifiedOperationId: operationId,
              normalizedTarget: "/api/profile",
              idempotencyKey,
            }),
          catch: (cause) =>
            cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
        });

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest(semanticMutationRequest(patch, ifMatch)),
            operationId,
          },
          // A receipt lookup precedes the precondition, so a replay after this command's own
          // write still answers its stored response, and a changed body under the same key
          // is a digest conflict rather than a stale precondition.
          execute: Profile.use((profileService) =>
            Effect.gen(function* () {
              if (Predicate.isTagged(precondition, "Failed")) {
                return yield* Effect.fail(
                  new HttpSemanticFailure(precondition.code, precondition.status),
                );
              }

              yield* profileService.updateOwnProfile({
                actorPersonId: actor.personId,
                command: UpdateOwnProfileCommand.make({
                  commandId: ProfileCommandId.make(derived.commandId),
                  expectedNameRevision: current.nameRevision,
                  expectedContactRevision: current.contactRevision,
                  firstName: patch.firstName ?? current.firstName,
                  lastName: patch.lastName ?? current.lastName,
                  email: patch.email ?? current.email,
                  phone: patch.phone ?? current.phone,
                }),
              });
              const updatedSource = yield* readProfileSource(actor.personId);
              const updated = updatedSource.profile;

              const body = {
                personId: updated.personId,
                firstName: updated.firstName,
                lastName: updated.lastName,
                email: updated.email,
                phone: updated.phone,
                role: actor.role,
                nameRevision: updated.nameRevision,
                contactRevision: updated.contactRevision,
              };

              const etag = deriveProfileStrongETag({
                personId: updated.personId,
                nameRevision: updated.nameRevision,
                contactRevision: updated.contactRevision,
                representationRevision: updatedSource.representationRevision,
              });

              return {
                status: 200,
                mediaType: "application/json",
                headers: { "content-type": "application/json", etag },
                bodyBytes: jsonBodyBytes(body),
              };
            }),
          ),
        };
      }),
    );

    return nativeCommandOutcomeResponse(result);
  });

/** Native HttpApi implementations for self-service profile endpoints. */
export const ProfileApiHandlers = (input: ProfileApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "profile", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readOwnProfile", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readOwnProfile(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("updateOwnProfile", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => updateOwnProfile(webRequest), errorResponse),
        ),
    ),
  );
