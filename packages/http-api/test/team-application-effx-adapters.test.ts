import { Capability, Concealment, type HttpAccessAnnotationSpec } from "@effx/runtime";
import { TEAM_APPLICATION_INTAKE_LIST_LIMIT } from "@vektorprogrammet/domain/team-application";
import { Context, Option, Predicate, Schema } from "effect";
import { HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { AccessSpecAnnotation, reflectAccessSpec } from "../src/access.js";
import { ExternalNativeApi } from "../src/api.js";
import { nativeProblems } from "../src/endpoint-problems.js";
import {
  createdMutationResponse,
  entityMutationResponse,
  IdempotencyHeaders,
  IdempotencyIfMatchHeaders,
  noContentMutationResponse,
  noStoreReadResponse,
  privateReadResponse,
} from "../src/http-semantics.js";
import {
  TeamApplicationListQuery,
  TeamApplicationParams,
  TeamApplicationTeamParams,
  TeamApplicationsByIdResolver,
  TeamApplicationsCreateResolver,
  TeamApplicationsDeleteCodes,
  TeamApplicationsIntakeByTeamResolver,
  TeamApplicationsListIntakesCodes,
  TeamApplicationsListResolver,
  TeamApplicationsNoStoreResponseHeaders,
  TeamApplicationsPublicIntakeResolver,
  TeamApplicationsPublicIntakesResolver,
  TeamApplicationsReadIntakeCodes,
  TeamApplicationsReviseIntakeCodes,
  TeamApplicationsStaffReadCodes,
  TeamApplicationsSubmitCodes,
  teamApplicationsAccessAnnotations,
} from "../src/team-application-effx-adapters.js";
import {
  DeleteTeamApplication,
  ListTeamApplicationIntakes,
  ListTeamApplications,
  ReadTeamApplication,
  ReadTeamApplicationIntake,
  ReviseTeamApplicationIntake,
  SubmitTeamApplication,
  TeamApplicationsGroup,
} from "../src/team-application.effx.js";
import {
  DeleteTeamApplicationEndpoint,
  ListTeamApplicationIntakesEndpoint,
  ListTeamApplicationsEndpoint,
  ReadTeamApplicationEndpoint,
  ReadTeamApplicationIntakeEndpoint,
  ReviseTeamApplicationIntakeEndpoint,
  SubmitTeamApplicationEndpoint,
  TeamApplicationsDeleteProblem,
  TeamApplicationsListIntakesProblem,
  TeamApplicationsReadIntakeProblem,
  TeamApplicationsReviseIntakeProblem,
  TeamApplicationsStaffReadProblem,
  TeamApplicationsSubmitProblem,
} from "../src/team-application.js";

const annotation = (declaration: typeof ReadTeamApplicationIntake, name: string) => {
  const matches = declaration.annotations.filter((candidate) => candidate.name === name);
  expect(matches).toHaveLength(1);

  return matches[0]?.args[0];
};

const cases = [
  {
    declaration: ReadTeamApplicationIntake,
    endpoint: ReadTeamApplicationIntakeEndpoint,
    codes: TeamApplicationsReadIntakeCodes,
    problem: TeamApplicationsReadIntakeProblem,
    problemName: "TeamApplicationsReadIntakeProblem",
    resolver: TeamApplicationsPublicIntakeResolver,
  },
  {
    declaration: ListTeamApplicationIntakes,
    endpoint: ListTeamApplicationIntakesEndpoint,
    codes: TeamApplicationsListIntakesCodes,
    problem: TeamApplicationsListIntakesProblem,
    problemName: "TeamApplicationsListIntakesProblem",
    resolver: TeamApplicationsPublicIntakesResolver,
  },
  {
    declaration: SubmitTeamApplication,
    endpoint: SubmitTeamApplicationEndpoint,
    codes: TeamApplicationsSubmitCodes,
    problem: TeamApplicationsSubmitProblem,
    problemName: "TeamApplicationsSubmitProblem",
    resolver: TeamApplicationsCreateResolver,
  },
  {
    declaration: ListTeamApplications,
    endpoint: ListTeamApplicationsEndpoint,
    codes: TeamApplicationsStaffReadCodes,
    problem: TeamApplicationsStaffReadProblem,
    problemName: "TeamApplicationsStaffReadProblem",
    resolver: TeamApplicationsListResolver,
  },
  {
    declaration: ReadTeamApplication,
    endpoint: ReadTeamApplicationEndpoint,
    codes: TeamApplicationsStaffReadCodes,
    problem: TeamApplicationsStaffReadProblem,
    problemName: "TeamApplicationsStaffReadProblem",
    resolver: TeamApplicationsByIdResolver,
  },
  {
    declaration: DeleteTeamApplication,
    endpoint: DeleteTeamApplicationEndpoint,
    codes: TeamApplicationsDeleteCodes,
    problem: TeamApplicationsDeleteProblem,
    problemName: "TeamApplicationsDeleteProblem",
    resolver: TeamApplicationsByIdResolver,
  },
  {
    declaration: ReviseTeamApplicationIntake,
    endpoint: ReviseTeamApplicationIntakeEndpoint,
    codes: TeamApplicationsReviseIntakeCodes,
    problem: TeamApplicationsReviseIntakeProblem,
    problemName: "TeamApplicationsReviseIntakeProblem",
    resolver: TeamApplicationsIntakeByTeamResolver,
  },
] as const;

const publicAccess = (
  resolver: (typeof cases)[number]["resolver"],
  decisionTime: "SnapshotRead" | "Transaction",
): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["None"],
  principalKinds: ["Anonymous"],
  capabilities: Capability.none,
  requirements: [],
  canonicalScopeResolver: resolver,
  concealment: Concealment.reveal,
  decisionTime,
});

const staffAccess = (
  capability: "team-applications.read" | "team-applications.manage",
  resolver: (typeof cases)[number]["resolver"],
  decisionTime: "SnapshotRead" | "Transaction",
): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: ["Person"],
  capabilities: Capability.one(capability),
  requirements: [],
  canonicalScopeResolver: resolver,
  concealment: Concealment.reveal,
  decisionTime,
});

const declaredAccess = [
  publicAccess(TeamApplicationsPublicIntakeResolver, "SnapshotRead"),
  publicAccess(TeamApplicationsPublicIntakesResolver, "SnapshotRead"),
  publicAccess(TeamApplicationsCreateResolver, "Transaction"),
  staffAccess("team-applications.read", TeamApplicationsListResolver, "SnapshotRead"),
  staffAccess("team-applications.read", TeamApplicationsByIdResolver, "SnapshotRead"),
  staffAccess("team-applications.manage", TeamApplicationsByIdResolver, "Transaction"),
  staffAccess("team-applications.manage", TeamApplicationsIntakeByTeamResolver, "Transaction"),
] as const;

const accessAt = (index: number): HttpAccessAnnotationSpec => {
  const access = declaredAccess[index];

  if (access === undefined) throw new TypeError("The seven declarations need seven access policies");

  return access;
};

describe("TeamApplications effx source declarations", () => {
  it("keeps all seven routes on one group without registering a second runtime endpoint", () => {
    const group = TeamApplicationsGroup.annotations[0]?.args[0];
    expect(group).toMatchObject({
      group: "team-applications",
      title: "Team applications",
      description: "Public team intake, staff review, deletion, and intake settings.",
    });

    const listing = OpenApi.fromApi(ExternalNativeApi).paths["/api/team-application-intakes"]?.get;
    expect(listing?.description).toBe(
      `Returns the intake state of at most ${TEAM_APPLICATION_INTAKE_LIST_LIMIT} active teams.`,
    );

    for (const { declaration, endpoint } of cases) {
      expect(annotation(declaration, "Http.In")).toBe(TeamApplicationsGroup);
      expect(annotation(declaration, endpoint.method === "GET" ? "Query" : "Command")).toMatchObject({
        name: `team-applications.${endpoint.identifier}`,
      });
      expect(annotation(declaration, `Http.${endpoint.method[0]}${endpoint.method.slice(1).toLowerCase()}`)).toBe(endpoint.path);
    }
  });

  it("preserves each ordered endpoint-local problem union and response headers", () => {
    for (const { declaration, endpoint, codes, problem, problemName } of cases) {
      expect(problem.members.map((member) => member.fields.code.literal)).toEqual(codes);
      expect(annotation(declaration, "Http.Problems")).toEqual({
        identifier: problemName,
        codes,
      });
      const derived = nativeProblems(problemName, codes);

      expect(derived.map((response) => HttpApiSchema.isWithHeaders(response) && response.headers.ast)).toEqual(
        [...endpoint.error].map((response) => HttpApiSchema.isWithHeaders(response) && response.headers.ast),
      );
    }
  });

  it("preserves original header, media, status and middleware boundaries", () => {

    const expectedHeaderSchemas = [
      TeamApplicationsNoStoreResponseHeaders,
      TeamApplicationsNoStoreResponseHeaders,
      createdMutationResponse(Schema.String).headers,
      privateReadResponse(Schema.String).headers,
      privateReadResponse(Schema.String).headers,
      TeamApplicationsNoStoreResponseHeaders,
      entityMutationResponse(Schema.String).headers,
    ] as const;

    const contracts = cases.map(({ declaration }) => {
      const contract = annotation(declaration, "Http.Contract");

      expect(Predicate.isObject(contract)).toBe(true);

      return Predicate.isObject(contract) ? contract : {};
    });

    for (const [index, { endpoint }] of cases.entries()) {
      const success = [...endpoint.success][0];

      expect(HttpApiSchema.isWithHeaders(success)).toBe(true);

      if (!HttpApiSchema.isWithHeaders(success)) continue;

      expect(contracts[index]).toMatchObject({
        responseHeaders: expect.objectContaining({ ast: success.headers.ast }),
        middleware: index < 3 ? [] : [expect.any(Function)],
      });

      expect(Object.hasOwn(contracts[index] ?? {}, "status")).toBe(index === 2 || index === 5);
      expect(success.headers.ast).toEqual(expectedHeaderSchemas[index]?.ast);
    }

    expect(contracts[0]).toMatchObject({ params: TeamApplicationTeamParams });
    expect(contracts[3]).toMatchObject({ params: TeamApplicationTeamParams, query: TeamApplicationListQuery });
    expect(contracts[4]).toMatchObject({ params: TeamApplicationParams });
    expect(contracts[2]).toMatchObject({ headers: IdempotencyHeaders, params: TeamApplicationTeamParams, status: 201 });
    expect(contracts[5]).toMatchObject({ headers: IdempotencyHeaders, params: TeamApplicationParams, status: 204 });
    expect(contracts[6]).toMatchObject({
      headers: IdempotencyIfMatchHeaders,
      params: TeamApplicationTeamParams,
      mediaType: "application/merge-patch+json",
    });
    expect(Object.keys(contracts[5] ?? {})).not.toContain("payload");
    expect(Object.keys(contracts[5] ?? {})).not.toContain("mediaType");
    expect(noContentMutationResponse().headers.ast).toEqual(TeamApplicationsNoStoreResponseHeaders.ast);
    expect(noStoreReadResponse(Schema.String).headers.ast).toEqual(TeamApplicationsNoStoreResponseHeaders.ast);
  });

  it("projects exactly the original anonymous and Person authority without authorizing", () => {
    for (const [index, { declaration, endpoint }] of cases.entries()) {
      const access = accessAt(index);
      expect(annotation(declaration, "Http.Access")).toEqual({
        acceptedCredentials: access.acceptedCredentials,
        principalKinds: access.principalKinds,
        capabilities: access.capabilities,
        requirements: access.requirements,
        canonicalScopeResolver: access.canonicalScopeResolver,
        decisionTime: access.decisionTime,
      });
      expect(Context.get(teamApplicationsAccessAnnotations(access), AccessSpecAnnotation)).toEqual(
        Option.getOrThrow(reflectAccessSpec(endpoint)),
      );
      expect(endpoint.middlewares.size).toBe(index < 3 ? 0 : 1);
    }
  });

  it("rejects copied resolver symbols and unsafe access combinations", () => {
    for (const [index, valid] of declaredAccess.entries()) {
      expect(() => teamApplicationsAccessAnnotations(valid)).not.toThrow();
      expect(() => teamApplicationsAccessAnnotations({ ...valid, canonicalScopeResolver: { id: cases[index]?.resolver.id } })).toThrow();
      expect(() => teamApplicationsAccessAnnotations({ ...valid, acceptedCredentials: ["OAuthUserBearer", "BetterAuthCookie"] })).toThrow();
      expect(() => teamApplicationsAccessAnnotations({ ...valid, principalKinds: [index < 3 ? "Person" : "Anonymous"] })).toThrow();
      expect(() => teamApplicationsAccessAnnotations({ ...valid, requirements: [{ id: "team-applications.read" }] })).toThrow();
      expect(() => teamApplicationsAccessAnnotations({ ...valid, decisionTime: valid.decisionTime === "Transaction" ? "SnapshotRead" : "Transaction" })).toThrow();
      expect(() => teamApplicationsAccessAnnotations({ ...valid, capabilities: index < 3 ? Capability.one("team-applications.read") : Capability.none })).toThrow();
      expect(() => teamApplicationsAccessAnnotations({ ...valid, concealment: Concealment.notFound("Scope") })).toThrow();
      expect(() => teamApplicationsAccessAnnotations({ ...valid, exposure: "Internal" })).toThrow();
    }

    expect(() => teamApplicationsAccessAnnotations(staffAccess("team-applications.manage", TeamApplicationsListResolver, "Transaction"))).toThrow();
    expect(() => teamApplicationsAccessAnnotations(publicAccess(TeamApplicationsCreateResolver, "SnapshotRead"))).toThrow();
  });
});
