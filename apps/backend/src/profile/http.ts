import { OwnProfile, Profile, UpdateOwnProfileCommand } from "@vektorprogrammet/domain/profile";
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect, Match, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
import { deriveProfileStrongETag } from "../http-semantics.js";
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
const isProfileHttpErrorTag = Schema.is(ProfileHttpErrorTag);

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

const errorTag = (cause: unknown): ProfileHttpErrorTag => {
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : "ProfilePersistenceError";
  return isProfileHttpErrorTag(tag) ? tag : "ProfilePersistenceError";
};

const statusForErrorTag = (tag: ProfileHttpErrorTag): number =>
  Match.value(tag).pipe(
    Match.when("UnauthenticatedActor", () => 401),
    Match.whenOr("AuthorityInactive", "NotInScope", () => 403),
    Match.when("ProfileDecodeError", () => 422),
    Match.whenOr("ProfileNotFound", "ProfileContactNotFound", () => 404),
    Match.whenOr("ProfileStaleRevision", "ProfileCommandConflict", () => 409),
    Match.when("ProfilePersistenceError", () => 503),
    Match.exhaustive,
  );

const errorResponse = (cause: unknown): Response => {
  const tag = errorTag(cause);
  return jsonResponse({ error: { tag } }, statusForErrorTag(tag));
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

const decodeCommand = async (
  request: Request,
  input: ProfileApiHttpOptions,
): Promise<UpdateOwnProfileCommand> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw taggedError("ProfileDecodeError");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw taggedError("ProfileDecodeError");
  }

  return await input.run(
    Schema.decodeUnknownEffect(UpdateOwnProfileCommand)(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError("ProfileDecodeError"))),
  );
};

const strictProfileResponse = async (
  profile: OwnProfile,
  role: UserRole,
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
  return jsonResponse(decoded, 200, {
    etag: deriveProfileStrongETag({
      personId: profile.personId,
      nameRevision: profile.nameRevision,
      contactRevision: profile.contactRevision,
      role,
    }),
  });
};

const readOwnProfile = async (
  request: Request,
  input: ProfileApiHttpOptions,
): Promise<Response> => {
  const actor = await actorFor(request, input);
  const profile = await input.run(
    Profile.use(({ readOwnProfile }) => readOwnProfile(actor.personId)),
  );
  return strictProfileResponse(profile, actor.role, input);
};

const updateOwnProfile = async (
  request: Request,
  input: ProfileApiHttpOptions,
): Promise<Response> => {
  const actor = await actorFor(request, input);
  const command = await decodeCommand(request, input);
  const profile = await input.run(
    Profile.use(({ updateOwnProfile, readOwnProfile }) =>
      updateOwnProfile({ actorPersonId: actor.personId, command }).pipe(
        Effect.flatMap(() => readOwnProfile(actor.personId)),
      ),
    ),
  );
  return strictProfileResponse(profile, actor.role, input);
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
