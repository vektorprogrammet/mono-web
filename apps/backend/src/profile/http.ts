import {
  OwnProfile,
  Profile,
  UpdateOwnProfileCommand,
} from "@vektorprogrammet/domain/profile";
import { Effect, Match, Schema } from "effect";
import type { BackendConfig } from "../config.js";
import type { BackendRun } from "../router.js";

export interface ProfileApiHttpOptions {
  readonly config: BackendConfig;
  readonly run: BackendRun;
}

export interface ProfileApiHttp {
  readonly fetch: (request: Request) => Promise<Response>;
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
  | "InactiveActor"
  | "ProfileDecodeError"
  | "ProfileNotFound"
  | "ProfileContactNotFound"
  | "ProfileStaleRevision"
  | "ProfileCommandConflict"
  | "ProfilePersistenceError";

const ProfileHttpErrorTag = Schema.Literals([
  "UnauthenticatedActor",
  "InactiveActor",
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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
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
    Match.whenOr("UnauthenticatedActor", "InactiveActor", () => 401),
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

const actorFor = (request: Request, config: BackendConfig): ProfileActor => {
  const authorization = request.headers.get("authorization");
  const token =
    authorization === null ? undefined : /^Bearer ([^\s]+)$/u.exec(authorization)?.[1];
  const admissionPrincipal = token === undefined ? undefined : config.admission.tokens.get(token);
  const receiptPrincipal = token === undefined ? undefined : config.receipt.tokens.get(token);
  const recruitmentPrincipal = token === undefined ? undefined : config.recruitment.tokens.get(token);
  const actor = admissionPrincipal?.actor ?? receiptPrincipal?.actor ?? recruitmentPrincipal?.actor;
  if (actor === undefined) throw taggedError("UnauthenticatedActor");
  if (!actor.active) throw taggedError("InactiveActor");

  const role: UserRole =
    "_tag" in actor
      ? actor._tag === "DepartmentLeader"
        ? "ROLE_TEAM_LEADER"
        : actor._tag === "GlobalAdmin"
          ? "ROLE_ADMIN"
          : "ROLE_TEAM_MEMBER"
      : actor.approvalScope._tag === "Global"
        ? "ROLE_ADMIN"
        : actor.approvalScope._tag === "Department"
          ? "ROLE_TEAM_LEADER"
          : "ROLE_TEAM_MEMBER";
  return { personId: actor.personId, role };
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
  return jsonResponse(decoded);
};

const readOwnProfile = async (
  request: Request,
  input: ProfileApiHttpOptions,
): Promise<Response> => {
  const actor = actorFor(request, input.config);
  const profile = await input.run(
    Profile.use(({ readOwnProfile }) => readOwnProfile(actor.personId)),
  );
  return strictProfileResponse(profile, actor.role, input);
};

const updateOwnProfile = async (
  request: Request,
  input: ProfileApiHttpOptions,
): Promise<Response> => {
  const actor = actorFor(request, input.config);
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

export const makeProfileApiHttp = (input: ProfileApiHttpOptions): ProfileApiHttp => ({
  fetch: async (request) => {
    const pathname = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && pathname === "/api/me") {
        return await readOwnProfile(request, input);
      }
      if (request.method === "PUT" && pathname === "/api/me") {
        return await updateOwnProfile(request, input);
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});
