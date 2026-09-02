/**
 * Public HTTP contracts for the current user's profile.
 *
 * @since 0.1.0
 */
import {
  OwnProfile,
  UpdateOwnProfileCommand,
  ProfileCommandId,
} from "@vektorprogrammet/domain/profile";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, personNativeAccess } from "./access.js";
import { errorBody, operationAnnotations, SessionSecurity } from "./common.js";

/**
 * Legacy-compatible dashboard role projection.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const UserRoleSchema = Schema.Literals([
  "ROLE_ADMIN",
  "ROLE_TEAM_LEADER",
  "ROLE_TEAM_MEMBER",
]);

/**
 * Strict self-profile response exposed to the dashboard.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const UserProfileResponse = Schema.Struct({
  personId: OwnProfile.fields.personId,
  firstName: OwnProfile.fields.firstName,
  lastName: OwnProfile.fields.lastName,
  email: OwnProfile.fields.email,
  phone: OwnProfile.fields.phone,
  role: UserRoleSchema,
  nameRevision: OwnProfile.fields.nameRevision,
  contactRevision: OwnProfile.fields.contactRevision,
}).annotate({
  identifier: "UserProfileResponse",
  description: "The current person's editable profile and authorization role projection.",
  examples: [
    {
      personId: PersonId.make("7202"),
      firstName: "Ming",
      lastName: "Medlem",
      email: "ming.medlem@example.org",
      phone: "+47 900 00 000",
      role: "ROLE_TEAM_MEMBER",
      nameRevision: 0,
      contactRevision: 1,
    },
  ],
});

/**
 * Representative self-profile update payload for generated examples.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const UpdateOwnProfileCommandExample = {
  _tag: "UpdateOwnProfile",
  commandId: ProfileCommandId.make("profile-command-0080"),
  expectedNameRevision: 0,
  expectedContactRevision: 1,
  firstName: "Ming",
  lastName: "Medlem",
  email: "ming.medlem@example.org",
  phone: "+47 900 00 000",
} as const;

const ProfileForbiddenResponse = errorBody(
  "ProfileForbiddenResponse",
  ["AuthorityInactive", "NotInScope"],
  403,
);
const ProfileNotFoundResponse = errorBody(
  "ProfileNotFoundResponse",
  ["ProfileNotFound", "ProfileContactNotFound"],
  404,
);
const ProfileConflictResponse = errorBody(
  "ProfileConflictResponse",
  ["ProfileStaleRevision", "ProfileCommandConflict"],
  409,
);
const ProfileDecodeResponse = errorBody("ProfileDecodeResponse", ["ProfileDecodeError"], 422);
const ProfileUnavailableResponse = errorBody(
  "ProfileUnavailableResponse",
  ["ProfilePersistenceError"],
  503,
);
const ProfileErrors = [
  ProfileForbiddenResponse,
  ProfileNotFoundResponse,
  ProfileConflictResponse,
  ProfileDecodeResponse,
  ProfileUnavailableResponse,
] as const;

/**
 * Reads the current person's profile.
 *
 * @since 0.1.0
 * @category Endpoints
 */
export const ReadOwnProfileEndpoint = HttpApiEndpoint.get("readOwnProfile", "/api/profile", {
  success: UserProfileResponse,
  error: ProfileErrors,
})
  .middleware(SessionSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "profile.read-self",
        canonicalScopeResolver: "profile.current-person",
        requirements: ["profile.owner"],
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Read own profile",
      "Returns the profile selected by the current session.",
    ),
  );

/**
 * Updates the current person's profile with optimistic revisions.
 *
 * @since 0.1.0
 * @category Endpoints
 */
export const UpdateOwnProfileEndpoint = HttpApiEndpoint.patch("updateOwnProfile", "/api/profile", {
  payload: UpdateOwnProfileCommand.annotate({
    identifier: "UpdateOwnProfileCommand",
    description: "Optimistic self-profile update command.",
    examples: [UpdateOwnProfileCommandExample],
  }),
  success: UserProfileResponse,
  error: ProfileErrors,
})
  .middleware(SessionSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "profile.update-self",
        canonicalScopeResolver: "profile.current-person",
        requirements: ["profile.owner"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Update own profile",
      "Updates only the profile selected by the current session and returns the fresh projection.",
    ),
  );

/**
 * Current-person profile endpoints.
 *
 * @since 0.1.0
 * @category Groups
 */
export class ProfileApi extends HttpApiGroup.make("profile")
  .add(ReadOwnProfileEndpoint, UpdateOwnProfileEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Profile",
      description: "Authenticated self-service profile API.",
      override: { "x-displayName": "Profile" },
    }),
  ) {}
