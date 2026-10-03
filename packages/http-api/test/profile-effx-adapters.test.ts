import type { HttpAccessAnnotationSpec, ProblemRegistry } from "@effx/runtime";
import { Context, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  NativeProblemRegistry,
  ProfileReadResponseHeaders,
  EntityMutationResponseHeaders,
  privateConditionalResponses,
  entityMutationResponse,
} from "../src/http-semantics.js";
import {
  ProfileReadOwnProfileCodes,
  ProfileUpdateOwnProfileCodes,
  ProfileReadOwnProfileProblem,
  ProfileUpdateOwnProfileProblem,
  nativeProblems,
} from "../src/endpoint-problems.js";
import { AccessSpecAnnotation, personNativeAccess } from "../src/access.js";
import { ProfileCurrentPerson, profileAccessAnnotations } from "../src/profile-effx-adapters.js";

const TestCapability = Schema.TaggedStruct("One", { capability: Schema.String });

const TestReveal = Schema.TaggedStruct("Reveal", {});

const TestNotFound = Schema.TaggedStruct("NotFound", { stages: Schema.NonEmptyArray(Schema.String) });

const readAccess = {
  exposure: "External",
  acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: ["Person"],
  capabilities: TestCapability.make({ capability: "profile.read-self" }),
  requirements: [{ id: "profile.owner" }],
  canonicalScopeResolver: ProfileCurrentPerson,
  concealment: TestReveal.make({}),
  decisionTime: "SnapshotRead",
} as const satisfies HttpAccessAnnotationSpec;

describe("Profile effx contract adapters", () => {
  it("shares the exact GET 200/304 and PATCH response header schemas", () => {
    const [success, notModified] = privateConditionalResponses(Schema.String);
    const mutation = entityMutationResponse(Schema.String);

    expect(success.headers).toBe(ProfileReadResponseHeaders);
    expect(notModified.headers).toBe(ProfileReadResponseHeaders);
    expect(mutation.headers).toBe(EntityMutationResponseHeaders);
  });

  it("derives each existing problem union from the same exported code tuple", () => {
    expect(ProfileReadOwnProfileProblem.members.map((member) => member.fields.code.literal)).toEqual(
      ProfileReadOwnProfileCodes,
    );
    expect(ProfileUpdateOwnProfileProblem.members.map((member) => member.fields.code.literal)).toEqual(
      ProfileUpdateOwnProfileCodes,
    );
  });

  it("derives the same person-owned AccessSpec without authorizing", () => {
    const spec = Context.get(profileAccessAnnotations(readAccess), AccessSpecAnnotation);

    expect(spec).toEqual(
      personNativeAccess({
        capability: "profile.read-self",
        canonicalScopeResolver: "profile.current-person",
        requirements: ["profile.owner"],
        decisionTime: "SnapshotRead",
      }),
    );
  });

  it("rejects altered credentials, a copied resolver or a write at read decision time", () => {
    expect(() =>
      profileAccessAnnotations({
        ...readAccess,
        acceptedCredentials: ["OAuthUserBearer", "BetterAuthCookie"],
      }),
    ).toThrow();
    expect(() =>
      profileAccessAnnotations({
        ...readAccess,
        canonicalScopeResolver: { id: "profile.current-person" },
      }),
    ).toThrow();
    expect(() =>
      profileAccessAnnotations({
        ...readAccess,
        capabilities: TestCapability.make({ capability: "profile.update-self" }),
      }),
    ).toThrow();

    const unsupported: ReadonlyArray<HttpAccessAnnotationSpec> = [
      { ...readAccess, principalKinds: ["ServicePrincipal"] },
      { ...readAccess, requirements: [{ id: "profile.owner", parameters: { team: "1" } }] },
      { ...readAccess, concealment: TestNotFound.make({ stages: ["Requirement"] }) },
    ];

    for (const spec of unsupported) expect(() => profileAccessAnnotations(spec)).toThrow();
  });

  it("validates broad problem codes while retaining the narrow tuple return type", () => {
    const registry: ProblemRegistry = nativeProblems;

    const expectedStatuses = new Set(
      ProfileReadOwnProfileCodes.map((code) => NativeProblemRegistry[code].status),
    );

    expect(registry("ProfileReadOwnProfileProblem", ProfileReadOwnProfileCodes)).toHaveLength(
      expectedStatuses.size,
    );
    expect(() => registry("InvalidProblem", ["not-a-native-problem"])).toThrow();
  });

});
