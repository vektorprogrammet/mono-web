import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { SocialEventScope } from "@vektorprogrammet/domain/social-events";
import { Context, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AccessSpecAnnotation, personNativeAccess, reflectAccessSpec } from "../src/access.js";
import {
  CreatedMutationResponseHeaders,
  createdMutationResponse,
  PrivateReadResponseHeaders,
  privateReadResponse,
} from "../src/http-semantics.js";
import {
  CreateSocialEventEndpoint,
  ListSocialEventsEndpoint,
  ReadSocialEventScopeEndpoint,
  SocialEventScopeQuery,
  SocialEventsCreateCodes,
  SocialEventsCreateProblem,
  SocialEventsListCodes,
  SocialEventsListProblem,
  SocialEventsReadScopeCodes,
  SocialEventsReadScopeProblem,
} from "../src/social-events.js";
import {
  SocialEventsCreateResolver,
  SocialEventsListResolver,
  SocialEventsScopeResolver,
  socialEventsAccessAnnotations,
} from "../src/social-events-effx-adapters.js";

const TestCapability = Schema.TaggedStruct("One", { capability: Schema.String });

const TestReveal = Schema.TaggedStruct("Reveal", {});

const TestNotFound = Schema.TaggedStruct("NotFound", {
  stages: Schema.NonEmptyArray(Schema.String),
});

const TestAny = Schema.TaggedStruct("Any", {
  capabilities: Schema.NonEmptyArray(Schema.String),
});

const triples = [
  {
    capability: "social-events.read-scope",
    resolver: SocialEventsScopeResolver,
    decisionTime: "SnapshotRead",
    endpoint: ReadSocialEventScopeEndpoint,
  },
  {
    capability: "social-events.read",
    resolver: SocialEventsListResolver,
    decisionTime: "SnapshotRead",
    endpoint: ListSocialEventsEndpoint,
  },
  {
    capability: "social-events.create",
    resolver: SocialEventsCreateResolver,
    decisionTime: "Transaction",
    endpoint: CreateSocialEventEndpoint,
  },
] as const;

const access = (
  capability: string,
  canonicalScopeResolver: (typeof triples)[number]["resolver"],
  decisionTime: "SnapshotRead" | "Transaction",
): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: ["Person"],
  capabilities: TestCapability.make({ capability }),
  requirements: [],
  canonicalScopeResolver,
  concealment: TestReveal.make({}),
  decisionTime,
});

describe("SocialEvents effx contract preparation", () => {
  it("uses exactly the domain scope fields for the existing list query", () => {
    expect(SocialEventScopeQuery.fields).toEqual(SocialEventScope.fields);
    expect(Object.keys(SocialEventScopeQuery.fields)).toEqual(["departmentId", "semesterId"]);

    expect(ListSocialEventsEndpoint.query).toBeDefined();

    // HttpApiEndpoint normalizes the query schema; the exported source retains its fields.
    const decodeQuery = Schema.decodeUnknownSync(SocialEventScopeQuery, { onExcessProperty: "error" });
    expect(decodeQuery({ departmentId: "1", semesterId: "2026-autumn" })).toEqual({
      departmentId: "1",
      semesterId: "2026-autumn",
    });

    for (const invalid of [
      { departmentId: "1" },
      { departmentId: "1", semesterId: null },
      { departmentId: "1", semesterId: "2026-autumn", extra: "1" },
    ]) {
      expect(() => decodeQuery(invalid)).toThrow();
    }
  });

  it("shares the 201 response header schema and preserves its strict wire policy", () => {
    expect(privateReadResponse(Schema.String).headers).toBe(PrivateReadResponseHeaders);
    expect(createdMutationResponse(Schema.String).headers).toBe(CreatedMutationResponseHeaders);

    const decodeHeaders = Schema.decodeUnknownSync(CreatedMutationResponseHeaders, {
      onExcessProperty: "error",
    });

    const headers = {
      "cache-control": "no-store",
      vary: "Origin",
      etag: `"vkr2.${"A".repeat(43)}"`,
      location: "/api/social-events/event-1",
    };

    expect(decodeHeaders(headers)).toEqual(headers);

    for (const invalid of [
      { ...headers, "cache-control": "private, no-store" },
      { ...headers, vary: "*" },
      { ...headers, etag: "W/\"weak\"" },
      { ...headers, location: "https://example.org/event-1" },
      { "cache-control": headers["cache-control"], vary: headers.vary, etag: headers.etag },
      { ...headers, extra: "unexpected" },
    ]) {
      expect(() => decodeHeaders(invalid)).toThrow();
    }
  });

  it("derives each existing endpoint problem union from its one ordered code tuple", () => {
    for (const [problem, codes] of [
      [SocialEventsReadScopeProblem, SocialEventsReadScopeCodes],
      [SocialEventsListProblem, SocialEventsListCodes],
      [SocialEventsCreateProblem, SocialEventsCreateCodes],
    ] as const) {
      expect(problem.members.map((member) => member.fields.code.literal)).toEqual(codes);
    }
  });

  it("projects only the three original person-owned access contracts", () => {
    for (const { capability, resolver, decisionTime, endpoint } of triples) {
      const expected = personNativeAccess({
        capability,
        canonicalScopeResolver: resolver.id,
        decisionTime,
      });

      const declared = access(capability, resolver, decisionTime);

      expect(Context.get(socialEventsAccessAnnotations(declared), AccessSpecAnnotation)).toEqual(
        expected,
      );
      expect(Option.getOrThrow(reflectAccessSpec(endpoint))).toEqual(expected);
    }
  });

  it("rejects every resolver/time cross-product outside the three declared triples", () => {
    for (const requested of triples) {
      for (const candidate of triples) {
        for (const decisionTime of ["SnapshotRead", "Transaction"] as const) {
          if (
            requested.resolver === candidate.resolver &&
            requested.decisionTime === decisionTime
          ) continue;

          expect(() =>
            socialEventsAccessAnnotations(
              access(requested.capability, candidate.resolver, decisionTime),
            ),
          ).toThrow();
        }
      }
    }
  });

  it("rejects copied resolvers and any widened authority, credential or concealment", () => {
    const read = access("social-events.read-scope", SocialEventsScopeResolver, "SnapshotRead");

    const excessInput = { extra: "unexpected" };

    for (const altered of [
      { ...read, canonicalScopeResolver: { id: SocialEventsScopeResolver.id } },
      { ...read, capabilities: TestCapability.make({ capability: "social-events.read-by-id" }) },
      {
        ...read,
        capabilities: TestAny.make({
          capabilities: ["social-events.read", "social-events.create"],
        }),
      },
      { ...read, exposure: "Internal" },
      { ...read, acceptedCredentials: ["OAuthUserBearer", "BetterAuthCookie"] as const },
      { ...read, principalKinds: ["ServicePrincipal"] as const },
      { ...read, requirements: [{ id: "social-events.owner" }] },
      { ...read, concealment: TestNotFound.make({ stages: ["Requirement"] }) },
      { ...read, ...excessInput },
    ] satisfies ReadonlyArray<HttpAccessAnnotationSpec>) {
      expect(() => socialEventsAccessAnnotations(altered)).toThrow();
    }
  });
});
