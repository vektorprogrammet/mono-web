import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { Context, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AccessSpecAnnotation, personNativeAccess } from "../src/access.js";
import {
  directoryAccessAnnotations,
  PeopleDirectoryResolver,
  SchoolsDirectoryResolver,
  SchoolsManagementResolver,
} from "../src/directory-effx-adapters.js";
import {
  DirectoryListPeopleCodes,
  DirectoryListPeopleProblem,
  DirectoryListSchoolsCodes,
  DirectoryListSchoolsProblem,
  SchoolAdministrationCodes,
  SchoolAdministrationProblem,
} from "../src/endpoint-problems.js";
import {
  EntityMutationResponseHeaders,
  PrivateReadResponseHeaders,
  entityMutationResponse,
  privateReadResponse,
} from "../src/http-semantics.js";

const TestCapability = Schema.TaggedStruct("One", { capability: Schema.String });

const TestReveal = Schema.TaggedStruct("Reveal", {});

const TestNotFound = Schema.TaggedStruct("NotFound", {
  stages: Schema.NonEmptyArray(Schema.String),
});

const peopleAccess = {
  exposure: "External",
  acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: ["Person"],
  capabilities: TestCapability.make({ capability: "profile.read-directory" }),
  requirements: [],
  canonicalScopeResolver: PeopleDirectoryResolver,
  concealment: TestReveal.make({}),
  decisionTime: "SnapshotRead",
} as const satisfies HttpAccessAnnotationSpec;

const schoolsReadAccess = {
  ...peopleAccess,
  capabilities: TestCapability.make({ capability: "schools.read-directory" }),
  canonicalScopeResolver: SchoolsDirectoryResolver,
} as const satisfies HttpAccessAnnotationSpec;

const schoolsManagementAccess = {
  ...peopleAccess,
  capabilities: TestCapability.make({ capability: "schools.manage" }),
  canonicalScopeResolver: SchoolsManagementResolver,
} as const satisfies HttpAccessAnnotationSpec;

describe("generated Directory contract adapters", () => {
  it("derives each existing People and Schools AccessSpec from its own resolver", () => {
    for (const [input, capability, resolver, decisionTime] of [
      [peopleAccess, "profile.read-directory", "profile.people-directory", "SnapshotRead"],
      [schoolsReadAccess, "schools.read-directory", "schools.directory", "SnapshotRead"],
      [schoolsManagementAccess, "schools.manage", "schools.management", "SnapshotRead"],
      [
        { ...schoolsManagementAccess, decisionTime: "Transaction" },
        "schools.manage",
        "schools.management",
        "Transaction",
      ],
    ] as const) {
      const spec = Context.get(directoryAccessAnnotations(input), AccessSpecAnnotation);

      expect(spec).toEqual(
        personNativeAccess({ capability, canonicalScopeResolver: resolver, decisionTime }),
      );
    }
  });

  it("rejects a copied resolver, reversed credentials, authority mismatch and concealed denial", () => {
    for (const input of [
      { ...peopleAccess, canonicalScopeResolver: { id: "profile.people-directory" } },
      { ...schoolsReadAccess, acceptedCredentials: ["OAuthUserBearer", "BetterAuthCookie"] },
      { ...schoolsReadAccess, decisionTime: "Transaction" },
      { ...schoolsManagementAccess, canonicalScopeResolver: SchoolsDirectoryResolver },
      { ...schoolsManagementAccess, requirements: [{ id: "schools.manage" }] },
      { ...schoolsManagementAccess, concealment: TestNotFound.make({ stages: ["Requirement"] }) },
    ] satisfies ReadonlyArray<HttpAccessAnnotationSpec>) {
      expect(() => directoryAccessAnnotations(input)).toThrow();
    }
  });

  it("uses the same private read and entity mutation header schemas", () => {
    expect(privateReadResponse(Schema.String).headers).toBe(PrivateReadResponseHeaders);
    expect(entityMutationResponse(Schema.String).headers).toBe(EntityMutationResponseHeaders);
  });

  it("keeps each declared endpoint problem union on its one code tuple", () => {
    expect(DirectoryListPeopleProblem.members.map((member) => member.fields.code.literal)).toEqual(
      DirectoryListPeopleCodes,
    );
    expect(DirectoryListSchoolsProblem.members.map((member) => member.fields.code.literal)).toEqual(
      DirectoryListSchoolsCodes,
    );
    expect(SchoolAdministrationProblem.members.map((member) => member.fields.code.literal)).toEqual(
      SchoolAdministrationCodes,
    );
  });
});
