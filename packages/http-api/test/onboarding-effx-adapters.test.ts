/**
 * EX-0022: required public native APIs in exact stable Effect4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Capability, Concealment, type HttpAccessAnnotationSpec } from "@effx/runtime";
import { OnboardingBoard } from "@vektorprogrammet/domain/onboarding";
import { Context, Option, Result, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { describe, expect, expectTypeOf, it } from "vitest";
import { command, readBoard } from "../.effx/generated/onboarding-contract.js";
import { AccessSpecAnnotation, personNativeAccess, reflectAccessSpec } from "../src/access.js";
import { ExternalNativeApi } from "../src/api.js";
import {
  nativeProblems,
  OnboardingCodes,
  OnboardingClaimProblem,
  OnboardingCommandCodes,
  OnboardingCommandProblem,
  OnboardingProblem,
} from "../src/endpoint-problems.js";
import {
  EntityMutationResponseHeaders,
  entityMutationResponse,
  NativeProblemRegistry,
  PrivateReadResponseHeaders,
  privateReadResponse,
} from "../src/http-semantics.js";
import {
  OnboardingApplicationDepartmentResolver,
  OnboardingCommandDeclarationCodes,
  onboardingCommandAccessAnnotations,
  onboardingReadAccessAnnotations,
  OnboardingResource,
} from "../src/onboarding-effx-adapters.js";
import { ClaimOnboardingEndpoint, OnboardingApi } from "../src/onboarding.js";

const access = (
  decisionTime: HttpAccessAnnotationSpec["decisionTime"],
): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: ["Person"],
  capabilities: Capability.one("onboarding.manage"),
  requirements: [],
  canonicalScopeResolver: OnboardingApplicationDepartmentResolver,
  concealment: Concealment.reveal,
  decisionTime,
});

describe("onboarding's ordered problem derivation", () => {
  it("keeps the flat declaration tuple exactly equal to its authoritative composed source", () => {
    expect(OnboardingCommandDeclarationCodes).toStrictEqual(OnboardingCommandCodes);
    expectTypeOf<typeof OnboardingCommandDeclarationCodes>().toEqualTypeOf<
      typeof OnboardingCommandCodes
    >();
  });

  it("rejects a reordered copy at runtime and at the type level", () => {
    const [first, second, ...remaining] = OnboardingCommandDeclarationCodes;
    const reordered = [second, first, ...remaining] as const;

    expect(reordered).not.toStrictEqual(OnboardingCommandCodes);
    expectTypeOf<typeof reordered>().not.toEqualTypeOf<typeof OnboardingCommandCodes>();
  });

  it("derives the native read, command and unchanged claim unions from their owning tuples", () => {
    expect(OnboardingProblem.members.map((member) => member.fields.code.literal)).toStrictEqual(
      OnboardingCodes,
    );
    expect(
      OnboardingCommandProblem.members.map((member) => member.fields.code.literal),
    ).toStrictEqual(OnboardingCommandCodes);
    expect(
      OnboardingClaimProblem.members.map((member) => member.fields.code.literal),
    ).toStrictEqual([...OnboardingCodes, "credential.missing", "credential.invalid"]);
    expect(
      nativeProblems("OnboardingCommandProblem", OnboardingCommandDeclarationCodes),
    ).toHaveLength(
      new Set(OnboardingCommandCodes.map((code) => NativeProblemRegistry[code].status)).size,
    );
  });
});

describe("onboarding access adapters", () => {
  it("projects each original Person policy without authorizing a request", () => {
    for (const [annotate, decisionTime] of [
      [onboardingReadAccessAnnotations, "SnapshotRead"],
      [onboardingCommandAccessAnnotations, "Transaction"],
    ] as const) {
      const expected = personNativeAccess({
        capability: "onboarding.manage",
        canonicalScopeResolver: "onboarding.application-department",
        decisionTime,
      });

      expect(Context.get(annotate(access(decisionTime)), AccessSpecAnnotation)).toEqual(expected);
    }
  });

  it("rejects moving the command decision to a read snapshot or the read decision to a transaction", () => {
    expect(() => onboardingCommandAccessAnnotations(access("SnapshotRead"))).toThrow();
    expect(() => onboardingReadAccessAnnotations(access("Transaction"))).toThrow();
  });

  it("rejects altered authority, credentials, resolver identity, requirements and concealment", () => {
    for (const [annotate, decisionTime] of [
      [onboardingReadAccessAnnotations, "SnapshotRead"],
      [onboardingCommandAccessAnnotations, "Transaction"],
    ] as const) {
      const original = access(decisionTime);

      const refused: ReadonlyArray<HttpAccessAnnotationSpec> = [
        { ...original, exposure: "Internal" },
        { ...original, acceptedCredentials: ["OAuthUserBearer", "BetterAuthCookie"] },
        { ...original, acceptedCredentials: ["ObjectCapability:onboarding.claim"] },
        { ...original, principalKinds: ["CapabilityHolder"] },
        { ...original, capabilities: Capability.one("admissions.outcomes") },
        { ...original, capabilities: Capability.any("onboarding.manage", "admissions.outcomes") },
        { ...original, canonicalScopeResolver: { id: "onboarding.application-department" } },
        { ...original, requirements: [{ id: "onboarding.claim-token" }] },
        { ...original, concealment: Concealment.notFound("Scope") },
      ];

      for (const spec of refused) expect(() => annotate(spec)).toThrow();
    }
  });
});

describe("the original mixed onboarding group", () => {
  it("mounts only the two generated constants and Identity's original handwritten claim", () => {
    expect(ExternalNativeApi.groups.onboarding.identifier).toBe(OnboardingApi.identifier);
    expect(
      Object.values(ExternalNativeApi.groups).filter((group) => group.identifier === "onboarding"),
    ).toHaveLength(1);
    expect(Object.keys(OnboardingApi.endpoints)).toStrictEqual(["readBoard", "command", "claim"]);
    expect(OnboardingApi.endpoints.readBoard).toBe(readBoard);
    expect(OnboardingApi.endpoints.command).toBe(command);
    expect(OnboardingApi.endpoints.claim).toBe(ClaimOnboardingEndpoint);
    expect(Context.getUnsafe(OnboardingApi.annotations, OpenApi.Title)).toBe(
      "Applicant account onboarding",
    );
    expect(Context.getUnsafe(OnboardingApi.annotations, OpenApi.Description)).toBe(
      "Explicit applicant identity proof and account linking.",
    );
  });

  it("keeps the exact generated read and command access metadata", () => {
    for (const [endpoint, decisionTime] of [
      [readBoard, "SnapshotRead"],
      [command, "Transaction"],
    ] as const) {
      expect(Option.getOrThrow(reflectAccessSpec(endpoint))).toEqual(
        personNativeAccess({
          capability: "onboarding.manage",
          canonicalScopeResolver: "onboarding.application-department",
          decisionTime,
        }),
      );
    }
  });

  it("retains the original operation IDs, paths and one group tag in full-root OpenAPI", () => {
    const document = OpenApi.fromApi(ExternalNativeApi);

    const operations = [
      document.paths["/api/onboarding"]?.get,
      document.paths["/api/onboarding"]?.post,
      document.paths["/api/onboarding/claim"]?.post,
    ];

    expect(operations.map((operation) => operation?.operationId)).toStrictEqual([
      "onboarding.readBoard",
      "onboarding.command",
      "onboarding.claim",
    ]);
    expect(operations.map((operation) => operation?.tags)).toStrictEqual([
      ["Applicant account onboarding"],
      ["Applicant account onboarding"],
      ["Applicant account onboarding"],
    ]);
  });

  it("shares the repaired board schema and the original response-header schemas", () => {
    expect(OnboardingResource.fields.items).toBe(OnboardingBoard.fields.items);
    expect(privateReadResponse(OnboardingResource).headers).toBe(PrivateReadResponseHeaders);
    expect(entityMutationResponse(OnboardingResource).headers).toBe(EntityMutationResponseHeaders);
  });

  it("refuses a board item without the server-owned canIssue field", () => {
    const decode = Schema.decodeUnknownResult(OnboardingResource, { onExcessProperty: "error" });

    const item = {
      applicationId: "onboarding-adapter-application",
      firstName: "Ada",
      lastName: "Applicant",
      invitationId: null,
      state: "Absent",
      delivery: "Absent",
      expiresAt: null,
    };

    const board = {
      departmentId: "onboarding-adapter-department",
      etag: `"vkr2.${"a".repeat(43)}"`,
    };

    expect(Result.isFailure(decode({ ...board, items: [item] }))).toBe(true);
    expect(
      Result.getOrThrow(decode({ ...board, items: [{ ...item, canIssue: false }] })).items[0]
        ?.canIssue,
    ).toBe(false);
  });
});
