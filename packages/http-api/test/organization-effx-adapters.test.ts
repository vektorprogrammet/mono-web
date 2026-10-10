/**
 * EX-0022: required public native APIs in exact stable Effect4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Capability, Concealment, type HttpAccessAnnotationSpec } from "@effx/runtime";
import { Context, Option, Result, Schema } from "effect";
import { HttpApiSchema, OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";
import {
  AccessSpecAnnotation,
  anonymousNativeAccess,
  personNativeAccess,
  reflectAccessSpec,
} from "../src/access.js";
import { ExternalNativeApi } from "../src/api.js";
import { PersonSecurity } from "../src/common.js";
import {
  OrganizationCreateDepartmentCodes,
  OrganizationCreateDepartmentProblem,
  OrganizationCreateTeamCodes,
  OrganizationCreateTeamProblem,
  OrganizationCreateFieldOfStudyCodes,
  OrganizationCreateFieldOfStudyProblem,
  OrganizationLifecycleCodes,
  OrganizationLifecycleProblem,
  OrganizationListDepartmentsCodes,
  OrganizationListDepartmentsProblem,
  OrganizationListTeamsCodes,
  OrganizationListTeamsProblem,
  OrganizationListFieldOfStudiesCodes,
  OrganizationListFieldOfStudiesProblem,
  OrganizationListTeamInterestCodes,
  OrganizationListTeamInterestProblem,
  OrganizationListMailingListsCodes,
  OrganizationListMailingListsProblem,
} from "../src/endpoint-problems.js";
import {
  NativeProblemRegistry,
  ConditionalReadHeaders,
  CreatedMutationResponseHeaders,
  EntityMutationResponseHeaders,
  IdempotencyHeaders,
  PrivateReadResponseHeaders,
  PublicConditionalResponseHeaders,
} from "../src/http-semantics.js";
import {
  OrganizationAppointmentManagementResolver,
  OrganizationDelegationManagementResolver,
  OrganizationPublicDepartmentsResolver,
  OrganizationPublicTeamsResolver,
  OrganizationPublicFieldOfStudiesResolver,
  OrganizationTeamInterestResolver,
  OrganizationMailingListsResolver,
  OrganizationDepartmentCreateResolver,
  OrganizationTeamCreateResolver,
  OrganizationFieldOfStudyCreateResolver,
  organizationAccessAnnotations,
} from "../src/organization-effx-adapters.js";
import {
  DepartmentExample,
  TeamExample,
  FieldOfStudyExample,
  OrganizationScopeQuerySchema,
  MailingListQuerySchema,
} from "../src/organization.js";
import {
  OrganizationGroup,
  ReadAppointmentManagement,
  ReadBoardRosters,
  ExecuteLifecycle,
  ReadDelegationManagement,
  ExecuteDelegation,
  ListDepartments,
  ListTeams,
  ListFieldOfStudies,
  ListTeamInterest,
  ListMailingLists,
  CreateDepartment,
  CreateTeam,
  CreateFieldOfStudy,
} from "../src/organization.effx.js";
import {
  readAppointmentManagement,
  readBoardRosters,
  executeLifecycle,
  readDelegationManagement,
  executeDelegation,
  listDepartments,
  listTeams,
  listFieldOfStudies,
  listTeamInterest,
  listMailingLists,
  createDepartment,
  createTeam,
  createFieldOfStudy,
} from "../.effx/generated/organization-contract.js";

const cases = [
  {
    source: ReadAppointmentManagement,
    endpoint: readAppointmentManagement,
    path: "/api/organization/appointments",
    method: "GET",
    status: 200,
    headers: PrivateReadResponseHeaders,
    codes: OrganizationLifecycleCodes,
    problem: OrganizationLifecycleProblem,
    resolver: OrganizationAppointmentManagementResolver,
    capability: "organization.manage-appointments",
    time: "SnapshotRead",
  },
  {
    source: ReadBoardRosters,
    endpoint: readBoardRosters,
    path: "/api/organization/board-rosters",
    method: "GET",
    status: 200,
    headers: PrivateReadResponseHeaders,
    codes: OrganizationLifecycleCodes,
    problem: OrganizationLifecycleProblem,
    resolver: OrganizationAppointmentManagementResolver,
    capability: "organization.manage-appointments",
    time: "SnapshotRead",
  },
  {
    source: ExecuteLifecycle,
    endpoint: executeLifecycle,
    path: "/api/organization/appointments/commands",
    method: "POST",
    status: 200,
    headers: EntityMutationResponseHeaders,
    codes: OrganizationLifecycleCodes,
    problem: OrganizationLifecycleProblem,
    resolver: OrganizationAppointmentManagementResolver,
    capability: "organization.manage-appointments",
    time: "Transaction",
  },
  {
    source: ReadDelegationManagement,
    endpoint: readDelegationManagement,
    path: "/api/organization/delegations",
    method: "GET",
    status: 200,
    headers: PrivateReadResponseHeaders,
    codes: OrganizationLifecycleCodes,
    problem: OrganizationLifecycleProblem,
    resolver: OrganizationDelegationManagementResolver,
    capability: "organization.manage-delegations",
    time: "SnapshotRead",
  },
  {
    source: ExecuteDelegation,
    endpoint: executeDelegation,
    path: "/api/organization/delegations/commands",
    method: "POST",
    status: 200,
    headers: EntityMutationResponseHeaders,
    codes: OrganizationLifecycleCodes,
    problem: OrganizationLifecycleProblem,
    resolver: OrganizationDelegationManagementResolver,
    capability: "organization.manage-delegations",
    time: "Transaction",
  },
  {
    source: ListDepartments,
    endpoint: listDepartments,
    path: "/api/departments",
    method: "GET",
    status: 200,
    headers: PublicConditionalResponseHeaders,
    codes: OrganizationListDepartmentsCodes,
    problem: OrganizationListDepartmentsProblem,
    resolver: OrganizationPublicDepartmentsResolver,
    capability: null,
    time: "SnapshotRead",
  },
  {
    source: ListTeams,
    endpoint: listTeams,
    path: "/api/teams",
    method: "GET",
    status: 200,
    headers: PublicConditionalResponseHeaders,
    codes: OrganizationListTeamsCodes,
    problem: OrganizationListTeamsProblem,
    resolver: OrganizationPublicTeamsResolver,
    capability: null,
    time: "SnapshotRead",
  },
  {
    source: ListFieldOfStudies,
    endpoint: listFieldOfStudies,
    path: "/api/field-of-studies",
    method: "GET",
    status: 200,
    headers: PublicConditionalResponseHeaders,
    codes: OrganizationListFieldOfStudiesCodes,
    problem: OrganizationListFieldOfStudiesProblem,
    resolver: OrganizationPublicFieldOfStudiesResolver,
    capability: null,
    time: "SnapshotRead",
  },
  {
    source: ListTeamInterest,
    endpoint: listTeamInterest,
    path: "/api/team-interest-registrations",
    method: "GET",
    status: 200,
    headers: PrivateReadResponseHeaders,
    codes: OrganizationListTeamInterestCodes,
    problem: OrganizationListTeamInterestProblem,
    resolver: OrganizationTeamInterestResolver,
    capability: "organization.read-team-interest",
    time: "SnapshotRead",
  },
  {
    source: ListMailingLists,
    endpoint: listMailingLists,
    path: "/api/mailing-lists",
    method: "GET",
    status: 200,
    headers: PrivateReadResponseHeaders,
    codes: OrganizationListMailingListsCodes,
    problem: OrganizationListMailingListsProblem,
    resolver: OrganizationMailingListsResolver,
    capability: "organization.read-mailing-lists",
    time: "SnapshotRead",
  },
  {
    source: CreateDepartment,
    endpoint: createDepartment,
    path: "/api/departments",
    method: "POST",
    status: 201,
    headers: CreatedMutationResponseHeaders,
    codes: OrganizationCreateDepartmentCodes,
    problem: OrganizationCreateDepartmentProblem,
    resolver: OrganizationDepartmentCreateResolver,
    capability: "organization.create-department",
    time: "Transaction",
  },
  {
    source: CreateTeam,
    endpoint: createTeam,
    path: "/api/teams",
    method: "POST",
    status: 201,
    headers: CreatedMutationResponseHeaders,
    codes: OrganizationCreateTeamCodes,
    problem: OrganizationCreateTeamProblem,
    resolver: OrganizationTeamCreateResolver,
    capability: "organization.create-team",
    time: "Transaction",
  },
  {
    source: CreateFieldOfStudy,
    endpoint: createFieldOfStudy,
    path: "/api/field-of-studies",
    method: "POST",
    status: 201,
    headers: CreatedMutationResponseHeaders,
    codes: OrganizationCreateFieldOfStudyCodes,
    problem: OrganizationCreateFieldOfStudyProblem,
    resolver: OrganizationFieldOfStudyCreateResolver,
    capability: "organization.create-field-of-study",
    time: "Transaction",
  },
] as const;

const accessOf = (row: (typeof cases)[number]): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: row.capability === null ? ["None"] : ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: row.capability === null ? ["Anonymous"] : ["Person"],
  capabilities: row.capability === null ? Capability.none : Capability.one(row.capability),
  requirements: [],
  canonicalScopeResolver: row.resolver,
  concealment: Concealment.reveal,
  decisionTime: row.time,
});

const annotation = (row: (typeof cases)[number], name: string) => {
  const matches = row.source.annotations.filter((candidate) => candidate.name === name);
  expect(matches).toHaveLength(1);

  return matches[0]?.args[0];
};

describe("Organization effx contract parity", () => {
  it("has exactly thirteen external operations including Mailing, no second Organization group", () => {
    expect(OrganizationGroup.annotations[0]?.args[0]).toMatchObject({
      group: "organization",
      title: "Organization",
      description: "Public organization directories and scoped administration.",
    });
    expect(Object.keys(ExternalNativeApi.groups.organization.endpoints)).toHaveLength(13);
    expect(cases.filter((row) => row.capability === null)).toHaveLength(3);
    expect(cases.filter((row) => row.capability !== null)).toHaveLength(10);
    expect(cases.filter((row) => row.method === "POST")).toHaveLength(5);
    expect(cases.filter((row) => row.status === 201)).toHaveLength(3);
    const documented = OpenApi.fromApi(ExternalNativeApi);

    for (const row of cases) {
      const operation = documented.paths[row.path]?.[row.method === "GET" ? "get" : "post"];
      expect(operation?.operationId).toBe(`organization.${row.endpoint.identifier}`);
      expect(operation?.summary).toBeDefined();
      expect(operation?.description).toBeDefined();
      expect(operation?.responses[row.status]).toBeDefined();
      expect(annotation(row, "Http.In")).toBe(OrganizationGroup);
      expect(row.endpoint.method).toBe(row.method);
      expect(row.endpoint.path).toBe(row.path);
    }
  });

  it("preserves public conditional 200/304 and private or mutation headers and statuses", () => {
    const documented = OpenApi.fromApi(ExternalNativeApi);

    for (const row of cases) {
      const successes = [...row.endpoint.success];
      expect(successes).toHaveLength(row.headers === PublicConditionalResponseHeaders ? 2 : 1);

      for (const success of successes) {
        expect(HttpApiSchema.isWithHeaders(success)).toBe(true);

        if (HttpApiSchema.isWithHeaders(success))
          expect(success.headers.ast).toEqual(row.headers.ast);
      }

      expect(new Set<unknown>(row.endpoint.middlewares).has(PersonSecurity)).toBe(
        row.capability !== null,
      );

      if (row.capability === null) expect(row.endpoint.middlewares.size).toBe(0);
      const contract = annotation(row, "Http.Contract");
      expect(contract).toMatchObject({ responseHeaders: row.headers, status: row.status });

      if (row.method === "POST") expect(contract).toMatchObject({ headers: IdempotencyHeaders });

      if (row.headers === PublicConditionalResponseHeaders)
        expect(contract).toMatchObject({ headers: ConditionalReadHeaders, conditional: true });
    }

    for (const row of cases.filter(
      (candidate) => candidate.headers === PublicConditionalResponseHeaders,
    )) {
      const operation = documented.paths[row.path]?.get;
      expect(operation?.responses["304"]).toBeDefined();
    }
  });

  it("keeps each ordered closed problem union and a strict Person/anonymous policy", () => {
    const documented = OpenApi.fromApi(ExternalNativeApi);

    for (const row of cases) {
      expect(row.problem.members.map((member) => member.fields.code.literal)).toEqual(row.codes);
      expect(annotation(row, "Http.Problems")).toMatchObject({ codes: row.codes });
      const statuses = new Set(row.codes.map((code) => NativeProblemRegistry[code].status));
      expect(row.endpoint.error.size).toBe(statuses.size);
      const operation = documented.paths[row.path]?.[row.method === "GET" ? "get" : "post"];

      for (const status of statuses) expect(operation?.responses[status]).toBeDefined();

      const expected =
        row.capability === null
          ? anonymousNativeAccess(row.resolver.id)
          : personNativeAccess({
              capability: row.capability,
              canonicalScopeResolver: row.resolver.id,
              decisionTime: row.time,
            });

      expect(Option.getOrThrow(reflectAccessSpec(row.endpoint))).toEqual(expected);
      expect(
        Context.get(organizationAccessAnnotations(accessOf(row)), AccessSpecAnnotation),
      ).toEqual(expected);
      expect(() =>
        organizationAccessAnnotations({
          ...accessOf(row),
          canonicalScopeResolver: { id: row.resolver.id },
        }),
      ).toThrow();
      expect(() =>
        organizationAccessAnnotations({
          ...accessOf(row),
          acceptedCredentials: ["OAuthUserBearer", "BetterAuthCookie"],
        }),
      ).toThrow();
      expect(() =>
        organizationAccessAnnotations({
          ...accessOf(row),
          principalKinds: row.capability === null ? ["Person"] : ["Anonymous"],
        }),
      ).toThrow();
      const oppositeTime = row.time === "Transaction" ? "SnapshotRead" : "Transaction";

      if (
        !cases.some(
          (other) =>
            other.resolver === row.resolver &&
            other.capability === row.capability &&
            other.time === oppositeTime,
        )
      )
        expect(() =>
          organizationAccessAnnotations({ ...accessOf(row), decisionTime: oppositeTime }),
        ).toThrow();
      expect(() =>
        organizationAccessAnnotations({
          ...accessOf(row),
          capabilities:
            row.capability === null
              ? Capability.one("organization.manage-appointments")
              : Capability.none,
        }),
      ).toThrow();
      expect(() =>
        organizationAccessAnnotations({
          ...accessOf(row),
          requirements: [{ id: "organization.manage-appointments" }],
        }),
      ).toThrow();
      expect(() =>
        organizationAccessAnnotations({ ...accessOf(row), exposure: "Internal" }),
      ).toThrow();
      expect(() =>
        organizationAccessAnnotations({
          ...accessOf(row),
          concealment: Concealment.notFound("Scope"),
        }),
      ).toThrow();
    }

    expect(() =>
      organizationAccessAnnotations({
        ...accessOf(cases[8]),
        canonicalScopeResolver: OrganizationMailingListsResolver,
      }),
    ).toThrow();
    expect(() =>
      organizationAccessAnnotations({
        ...accessOf(cases[9]),
        capabilities: Capability.one("organization.read-team-interest"),
      }),
    ).toThrow();
    expect(() =>
      organizationAccessAnnotations({
        ...accessOf(cases[10]),
        canonicalScopeResolver: OrganizationTeamCreateResolver,
      }),
    ).toThrow();
  });

  it("keeps schema identifiers, examples, repeated query fields and the existing create bodies", () => {
    const spec = OpenApi.fromApi(ExternalNativeApi);
    expect(spec.components.schemas.DepartmentJson).toMatchObject({
      description: "One native department directory row.",
      examples: [DepartmentExample],
    });
    expect(spec.components.schemas.TeamJson).toMatchObject({
      description: "One native team directory row.",
      examples: [TeamExample],
    });
    expect(spec.components.schemas.FieldOfStudyJson).toMatchObject({
      description: "One native field-of-study directory row.",
      examples: [FieldOfStudyExample],
    });
    expect(spec.components.schemas.TeamInterestResponse).toMatchObject({
      description: "Scoped team-interest rows.",
    });
    expect(spec.components.schemas.MailingListResponse).toMatchObject({
      description: "Scoped mailing-list projections.",
    });
    expect(
      Schema.decodeResult(OrganizationScopeQuerySchema)({
        department: ["1", "2"],
        semester: ["2026-vaar", "2026-hoest"],
      }),
    ).toEqual(Result.succeed({ department: ["1", "2"], semester: ["2026-vaar", "2026-hoest"] }));
    expect(Schema.decodeResult(MailingListQuerySchema)({ type: ["team", "all"] })).toEqual(
      Result.succeed({ type: ["team", "all"] }),
    );

    for (const endpoint of [createDepartment, createTeam, createFieldOfStudy])
      expect(endpoint.payload).toBeDefined();

    for (const path of ["/api/departments", "/api/teams", "/api/field-of-studies"])
      expect(spec.paths[path]?.post?.requestBody?.content["application/json"]).toBeDefined();
  });
});
