import {
  OwnProfile,
  Profile,
  UpdateOwnProfileCommand,
  readOwnProfileHttpSourcePostgres,
} from "@vektorprogrammet/domain/profile";
import {
  ExternalNativeApi,
  ProfileMergePatch,
  ReadOwnProfileEndpoint,
  UpdateOwnProfileEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { ResourceId, ResourceKind } from "@vektorprogrammet/domain/authz";
import { executeNativeHttpCommandPostgres } from "@vektorprogrammet/domain/http-semantics";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
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
import type { BackendConfig } from "../config.js";
import type { BackendRun } from "../router.js";

export interface ProfileApiHttpOptions {
  readonly config: BackendConfig;
  /**
   * Cookie -> Organization projection -> {personId, role Decision}.
   * Deny(reason) is translated here into the typed profile denial.
   */
  readonly resolveActor: (request: Request) => Promise<ProfileActor>;
  readonly run: BackendRun;
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

type ProfileHttpErrorTag =
  | "UnauthenticatedActor"
  | "AuthorityInactive"
  | "NotInScope"
  | "ProfileDecodeError"
  | "ProfileNotFound"
  | "ProfileContactNotFound"
  | "ProfileStaleRevision"
  | "ProfileCommandConflict"
  | "ProfilePersistenceError";

const ProfileHttpErrorTag = Schema.Literals([
  "UnauthenticatedActor",
  "AuthorityInactive",
  "NotInScope",
  "ProfileDecodeError",
  "ProfileNotFound",
  "ProfileContactNotFound",
  "ProfileStaleRevision",
  "ProfileCommandConflict",
  "ProfilePersistenceError",
]);

type TaggedHttpError = Error & { readonly _tag: ProfileHttpErrorTag };

const taggedError = (tag: ProfileHttpErrorTag): TaggedHttpError => {
  const error = new Error(tag) as TaggedHttpError;
  Object.defineProperty(error, "_tag", { value: tag, enumerable: true });
  return error;
};

const jsonResponse = (
  body: unknown,
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
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause ? String(cause._tag) : "";
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

const actorFor = async (request: Request, input: ProfileApiHttpOptions): Promise<ProfileActor> => {
  try {
    return await input.resolveActor(request);
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw taggedError("ProfilePersistenceError");
  }
};

const decodePatch = async (
  request: Request,
  input: ProfileApiHttpOptions,
): Promise<typeof ProfileMergePatch.Type> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/merge-patch\+json(?:\s*;|$)/iu.test(contentType)) {
    throw new HttpSemanticFailure("media-type.unsupported", 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpSemanticFailure("request.malformed", 400);
  }

  const patch = await input.run(
    Schema.decodeUnknownEffect(ProfileMergePatch)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new HttpSemanticFailure("validation.failed", 422))),
  );
  const fields = ["firstName", "lastName", "email", "phone"] as const;
  if (!fields.some((field) => Object.hasOwn(patch, field))) {
    throw new HttpSemanticFailure("validation.no-change", 422);
  }
  if (fields.some((field) => Object.hasOwn(patch, field) && patch[field] === null)) {
    throw new HttpSemanticFailure("validation.field-not-deletable", 422);
  }
  return patch;
};

const strictProfileResponse = async (
  request: Request,
  profile: OwnProfile,
  role: UserRole,
  representationRevision: number,
  input: ProfileApiHttpOptions,
): Promise<Response> => {
  const decoded = await input.run(
    Schema.decodeUnknownEffect(UserProfile)(
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
    ).pipe(Effect.mapError(() => taggedError("ProfilePersistenceError"))),
  );
  const etag = deriveProfileStrongETag({
    personId: profile.personId,
    nameRevision: profile.nameRevision,
    contactRevision: profile.contactRevision,
    representationRevision,
  });
  const decision = evaluateReadPreconditions({
    currentETag: etag,
    ifMatch: parseReadIfMatch(
      request.headers.get("if-match") === null ? [] : [request.headers.get("if-match")!],
    ),
    ifNoneMatch: parseIfNoneMatch(
      request.headers.get("if-none-match") === null ? [] : [request.headers.get("if-none-match")!],
    ),
  });
  if (decision._tag === "Failed") {
    return nativeProblemResponse(decision.code, decision.status);
  }
  if (decision._tag === "NotModified") {
    return notModifiedResponse({ etag, cacheControl: PRIVATE_NO_STORE, vary: "Origin" });
  }
  return jsonResponse(decoded, 200, { etag });
};

const readOwnProfile = async (
  request: Request,
  input: ProfileApiHttpOptions,
): Promise<Response> => {
  const actor = await actorFor(request, input);
  const now = new Date().toISOString();
  const personResource = {
    _tag: "Resource" as const,
    resource: {
      kind: ResourceKind.make("person-profile"),
      id: ResourceId.make(actor.personId),
    },
  };
  await authorizePersonNativeOperation({
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
    run: input.run,
  });
  const source = await input.run(readOwnProfileHttpSourcePostgres(actor.personId));
  return strictProfileResponse(
    request,
    source.profile,
    actor.role,
    source.representationRevision,
    input,
  );
};

const updateOwnProfile = async (
  request: Request,
  input: ProfileApiHttpOptions,
): Promise<Response> => {
  const actor = await actorFor(request, input);
  const now = new Date().toISOString();
  const personResource = {
    _tag: "Resource" as const,
    resource: {
      kind: ResourceKind.make("person-profile"),
      id: ResourceId.make(actor.personId),
    },
  };
  await authorizePersonNativeOperation({
    spec: Option.getOrThrow(reflectAccessSpec(UpdateOwnProfileEndpoint)),
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
    run: input.run,
  });
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key") === null
      ? []
      : [request.headers.get("idempotency-key")!],
  );
  const ifMatch = parseRequiredIfMatch(
    request.headers.get("if-match") === null ? [] : [request.headers.get("if-match")!],
  );
  const patch = await decodePatch(request, input);
  const operationId = "profile.updateOwnProfile";
  const derived = deriveHttpIdentity({
    credentialSubject: `Person:${actor.personId}`,
    qualifiedOperationId: operationId,
    normalizedTarget: "/api/profile",
    idempotencyKey,
  });
  const identity = {
    identitySha256: derived.identitySha256,
    requestSha256: semanticRequestDigest(semanticMutationRequest(patch, ifMatch)),
    operationId,
  };
  const result = await input.run(
    Profile.use((profileService) =>
      executeNativeHttpCommandPostgres(
        identity,
        Effect.gen(function* () {
          const currentSource = yield* readOwnProfileHttpSourcePostgres(actor.personId);
          const current = currentSource.profile;
          const currentETag = deriveProfileStrongETag({
            personId: current.personId,
            nameRevision: current.nameRevision,
            contactRevision: current.contactRevision,
            representationRevision: currentSource.representationRevision,
          });
          const precondition = evaluateMutationPrecondition(currentETag, ifMatch);
          if (precondition._tag === "Failed") {
            return yield* Effect.fail(
              new HttpSemanticFailure(precondition.code, precondition.status),
            );
          }
          yield* profileService.updateOwnProfile({
            actorPersonId: actor.personId,
            command: {
              _tag: "UpdateOwnProfile",
              commandId: derived.commandId as unknown as UpdateOwnProfileCommand["commandId"],
              expectedNameRevision: current.nameRevision,
              expectedContactRevision: current.contactRevision,
              firstName: patch.firstName ?? current.firstName,
              lastName: patch.lastName ?? current.lastName,
              email: patch.email ?? current.email,
              phone: patch.phone ?? current.phone,
            },
          });
          const updatedSource = yield* readOwnProfileHttpSourcePostgres(actor.personId);
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
    ),
  );
  return nativeCommandOutcomeResponse(result);
};

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
          toHttpApiResponse(
            request,
            (webRequest) => updateOwnProfile(webRequest, input),
            errorResponse,
          ),
        ),
    ),
  );
