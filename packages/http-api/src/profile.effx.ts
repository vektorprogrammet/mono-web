// Excluded from tsconfig until effx supplies declaration-only operations, Http.Group,
// and lowering of the exported `as const satisfies` problem-code tuples.
import { Schema } from "effect";
import { Http, Operation } from "@effx/runtime";
import { PersonSecurity } from "./common.js";
import {
  ProfileReadOwnProfileCodes,
  ProfileUpdateOwnProfileCodes,
  profileProblems,
} from "./endpoint-problems.js";
import {
  ConditionalReadHeaders,
  IdempotencyIfMatchHeaders,
  ProfileReadResponseHeaders,
  ProfileMutationResponseHeaders,
} from "./http-semantics.js";
import { UserProfileResponse } from "./profile.js";
import { ProfileCurrentPerson, profileAccessAnnotations } from "./profile-effx-adapters.js";
import { ProfileMergePatch } from "./v2-schemas.js";

export const ProfileGroup = Http.Group({
  root: "external-native-api",
  group: "profile",
  title: "Profile",
  description: "Authenticated self-service profile API.",
  override: { "x-displayName": "Profile" },
});

export const ReadOwnProfile = Operation.query({
  name: "profile.readOwnProfile",
  input: ConditionalReadHeaders,
  success: UserProfileResponse,
})
  .http.get("/api/profile")
  .http.contract({
    root: "external-native-api",
    group: "profile",
    headers: ConditionalReadHeaders,
    success: UserProfileResponse,
    responseHeaders: ProfileReadResponseHeaders,
    conditional: true,
    middleware: [PersonSecurity],
    metadata: {
      operationId: "profile.readOwnProfile",
      summary: "Read own profile",
      description: "Returns the profile selected by the current session.",
    },
  })
  .http.problems({
    registry: profileProblems,
    identifier: "ProfileReadOwnProfileProblem",
    codes: ProfileReadOwnProfileCodes,
  })
  .http.access({
    annotator: profileAccessAnnotations,
    exposure: "External",
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Schema.TaggedStruct("One", { capability: Schema.String }).make({
      capability: "profile.read-self",
    }),
    requirements: [{ id: "profile.owner" }],
    canonicalScopeResolver: ProfileCurrentPerson,
    concealment: Schema.TaggedStruct("Reveal", {}).make({}),
    decisionTime: "SnapshotRead",
  })
  .declare();

export const UpdateOwnProfile = Operation.command({
  name: "profile.updateOwnProfile",
  input: ProfileMergePatch,
  success: UserProfileResponse,
})
  .http.patch("/api/profile")
  .http.contract({
    root: "external-native-api",
    group: "profile",
    headers: IdempotencyIfMatchHeaders,
    payload: ProfileMergePatch,
    mediaType: "application/merge-patch+json",
    success: UserProfileResponse,
    responseHeaders: ProfileMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      operationId: "profile.updateOwnProfile",
      summary: "Update own profile",
      description:
        "Updates only the profile selected by the current session and returns the fresh projection.",
    },
  })
  .http.problems({
    registry: profileProblems,
    identifier: "ProfileUpdateOwnProfileProblem",
    codes: ProfileUpdateOwnProfileCodes,
  })
  .http.access({
    annotator: profileAccessAnnotations,
    exposure: "External",
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Schema.TaggedStruct("One", { capability: Schema.String }).make({
      capability: "profile.update-self",
    }),
    requirements: [{ id: "profile.owner" }],
    canonicalScopeResolver: ProfileCurrentPerson,
    concealment: Schema.TaggedStruct("Reveal", {}).make({}),
    decisionTime: "Transaction",
  })
  .declare();
