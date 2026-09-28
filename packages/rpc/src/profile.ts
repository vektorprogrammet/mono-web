/**
 * Profile: the caller's own profile.
 *
 * @since 0.3.0
 */
import { PersonId, ProfileRoleSchema } from "@vektorprogrammet/domain/organization";
import { OwnProfile } from "@vektorprogrammet/domain/profile";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";
import { ProfileMergePatch } from "./v2-schemas.js";

/**
 * Dashboard role projection for navigation. A department administrator holds a capability beyond
 * one team through a board leadership or a delegation; a team leader acts within the team.
 */
export const UserRoleSchema = ProfileRoleSchema;

/** Strict self-profile representation exposed to the dashboard. */
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
 * The profile beside its strong entity tag, which `profile.updateOwnProfile` takes as `ifMatch`.
 * The tag covers the stored profile revisions and the role representation revision.
 */
export const OwnProfileResource = Schema.Struct({
  profile: UserProfileResponse,
  etag: StrongETag,
}).annotate({ identifier: "OwnProfileResource" });

export type OwnProfileResource = typeof OwnProfileResource.Type;

export const OwnProfileReadProblem = problemUnion("OwnProfileReadProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "profile.not-found",
  "profile.unavailable",
]);

export const OwnProfileUpdateProblem = problemUnion("OwnProfileUpdateProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "validation.failed",
  "validation.no-change",
  "validation.field-not-deletable",
  "precondition.failed",
  "transaction.conflict",
  "internal.error",
  "profile.not-found",
  "profile.unavailable",
  "idempotency.unavailable",
]);

/** Returns the profile selected by the current credential. */
export const ReadOwnProfile = Rpc.make("profile.readOwnProfile", {
  success: OwnProfileResource,
  error: rpcProblems(OwnProfileReadProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "profile.read-self",
        canonicalScopeResolver: "profile.current-person",
        requirements: ["profile.owner"],
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Applies a JSON merge patch (RFC 7396) to the profile selected by the current credential, and
 * returns the fresh projection. An absent member keeps its value; a patch with no member answers
 * validation.no-change, and a `null` member validation.field-not-deletable.
 */
export const UpdateOwnProfile = Rpc.make("profile.updateOwnProfile", {
  payload: Schema.Struct({
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: ProfileMergePatch,
  }),
  success: OwnProfileResource,
  error: rpcProblems(OwnProfileUpdateProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "profile.update-self",
        canonicalScopeResolver: "profile.current-person",
        requirements: ["profile.owner"],
        decisionTime: "Transaction",
      }),
    ),
  );

export class ProfileRpcs extends RpcGroup.make(ReadOwnProfile, UpdateOwnProfile) {}
