import { PUBLIC_SYSTEM_ACCESS } from "@vektorprogrammet/domain/authz";
import { Context, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { ExternalNativeApi, InternalNativeApi } from "../src/api.js";
import {
  annotateAccessSpec,
  assertAccessProjectionRegistryParity,
  projectVektorAccess,
  reflectAccessSpec,
  type VektorAccessProjection,
} from "../src/access.js";
import { HealthEndpoint } from "../src/system.js";
import {
  NativeProblemRegistry,
  PeopleDirectoryResponse,
  ProfileMergePatch,
  ProfileUpdateOwnProfileProblem,
  SystemHealthProblem,
} from "../src/index.js";

const endpointInventory = () =>
  Object.values(ExternalNativeApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => ({
      group: group.identifier,
      identifier: endpoint.identifier,
      method: endpoint.method,
      path: endpoint.path,
    })),
  );
const internalEndpointInventory = () =>
  Object.values(InternalNativeApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => ({
      group: group.identifier,
      identifier: endpoint.identifier,
      method: endpoint.method,
      path: endpoint.path,
    })),
  );

const documentedOperations = () => {
  const spec = OpenApi.fromApi(ExternalNativeApi);
  const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    methods.flatMap((method) => {
      const operation = item[method];
      return operation === undefined ? [] : [{ method, path, operation }];
    }),
  );
};

type ExpectedOperation = readonly [
  method: string,
  path: string,
  operationId: string,
  access: VektorAccessProjection,
];
const expectedAccess = (input: {
  readonly credentials: ReadonlyArray<string>;
  readonly principals: ReadonlyArray<string>;
  readonly capability?: string;
  readonly resolver: string;
  readonly requirements?: ReadonlyArray<string>;
  readonly concealment?: ReadonlyArray<string>;
  readonly decisionTime: "SnapshotRead" | "Transaction";
  readonly exposure?: "External" | "Internal";
}): VektorAccessProjection => ({
  exposure: input.exposure ?? "External",
  acceptedCredentials: input.credentials,
  principalKinds: input.principals,
  capabilities: input.capability === undefined ? { none: true } : { one: input.capability },
  requirements: (input.requirements ?? []).map((id) => ({ id })),
  canonicalScopeResolver: input.resolver,
  concealment:
    input.concealment === undefined
      ? { mode: "Reveal", stages: [] }
      : { mode: "NotFound", stages: [...input.concealment].sort() },
  decisionTime: input.decisionTime,
});
const anonymous = (
  resolver: string,
  decisionTime: "SnapshotRead" | "Transaction" = "SnapshotRead",
) =>
  expectedAccess({
    credentials: ["None"],
    principals: ["Anonymous"],
    resolver,
    decisionTime,
  });
const cookie = (
  resolver: string,
  requirements: ReadonlyArray<string>,
  decisionTime: "SnapshotRead" | "Transaction",
  concealment?: ReadonlyArray<string>,
) =>
  expectedAccess({
    credentials: ["BetterAuthCookie"],
    principals: ["Person"],
    resolver,
    requirements,
    concealment,
    decisionTime,
  });
const person = (
  capability: string,
  resolver: string,
  requirements: ReadonlyArray<string>,
  decisionTime: "SnapshotRead" | "Transaction",
) =>
  expectedAccess({
    credentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principals: ["Person"],
    capability,
    resolver,
    requirements,
    decisionTime,
  });
const invitation = (
  requirements: ReadonlyArray<string>,
  decisionTime: "SnapshotRead" | "Transaction",
) =>
  expectedAccess({
    credentials: ["ObjectCapability"],
    principals: ["CapabilityHolder"],
    capability: "recruitment.invitation-response",
    resolver: "recruitment.invitation-response-by-capability",
    requirements,
    concealment: ["CredentialFailure", "PrincipalKind", "Capability", "Scope", "Requirement"],
    decisionTime,
  });
const expectedOperations: ReadonlyArray<ExpectedOperation> = [
  ["GET", "/health", "system.health", anonymous("system.health")],
  [
    "GET",
    "/api/session",
    "system.readSession",
    cookie("identity.current-session", [], "SnapshotRead"),
  ],
  [
    "DELETE",
    "/api/session",
    "system.deleteSession",
    cookie("identity.current-session", [], "Transaction"),
  ],
  [
    "GET",
    "/api/sessions",
    "system.listSessions",
    cookie("identity.owned-sessions", ["sessions.owner"], "SnapshotRead"),
  ],
  [
    "DELETE",
    "/api/sessions/:sessionId",
    "system.deleteOwnedSession",
    cookie("identity.session-by-id", ["sessions.owner"], "Transaction", ["Requirement"]),
  ],
  [
    "POST",
    "/api/sessions:revoke-others",
    "system.revokeOtherSessions",
    cookie("identity.current-session", [], "Transaction"),
  ],
  [
    "POST",
    "/api/sessions:revoke-all",
    "system.revokeAllSessions",
    cookie("identity.current-session", [], "Transaction"),
  ],
  [
    "GET",
    "/api/profile",
    "profile.readOwnProfile",
    person("profile.read-self", "profile.current-person", ["profile.owner"], "SnapshotRead"),
  ],
  [
    "PATCH",
    "/api/profile",
    "profile.updateOwnProfile",
    person("profile.update-self", "profile.current-person", ["profile.owner"], "Transaction"),
  ],
  [
    "GET",
    "/api/departments",
    "organization.listDepartments",
    anonymous("organization.public-departments"),
  ],
  ["GET", "/api/teams", "organization.listTeams", anonymous("organization.public-teams")],
  [
    "GET",
    "/api/field-of-studies",
    "organization.listFieldOfStudies",
    anonymous("organization.public-field-of-studies"),
  ],
  [
    "GET",
    "/api/team-interest-registrations",
    "organization.listTeamInterest",
    person(
      "organization.read-team-interest",
      "organization.team-interest-registrations",
      [],
      "SnapshotRead",
    ),
  ],
  [
    "GET",
    "/api/mailing-lists",
    "organization.listMailingLists",
    person("organization.read-mailing-lists", "organization.mailing-lists", [], "SnapshotRead"),
  ],
  [
    "POST",
    "/api/departments",
    "organization.createDepartment",
    person("organization.create-department", "organization.department-create", [], "Transaction"),
  ],
  [
    "POST",
    "/api/teams",
    "organization.createTeam",
    person("organization.create-team", "organization.team-create", [], "Transaction"),
  ],
  [
    "POST",
    "/api/field-of-studies",
    "organization.createFieldOfStudy",
    person(
      "organization.create-field-of-study",
      "organization.field-of-study-create",
      [],
      "Transaction",
    ),
  ],
  [
    "GET",
    "/api/people",
    "directory.listPeople",
    person("profile.read-directory", "profile.people-directory", [], "SnapshotRead"),
  ],
  [
    "GET",
    "/api/schools",
    "directory.listSchools",
    person("schools.read-directory", "schools.directory", [], "SnapshotRead"),
  ],
  [
    "GET",
    "/api/open-admission-periods",
    "admissions.listOpenAdmissionPeriods",
    anonymous("admissions.public-open-periods"),
  ],
  [
    "GET",
    "/api/application-options",
    "admissions.listApplicationOptions",
    anonymous("admissions.public-application-options"),
  ],
  [
    "POST",
    "/api/applications",
    "admissions.submitApplication",
    anonymous("admissions.application-create", "Transaction"),
  ],
  [
    "GET",
    "/api/applications/:applicationId",
    "admissions.readApplicationConfirmation",
    anonymous("admissions.public-application-by-id"),
  ],
  [
    "GET",
    "/api/admission-periods",
    "admissions.listAdmissionPeriods",
    person("admissions.read-periods", "admissions.management-periods", [], "SnapshotRead"),
  ],
  [
    "POST",
    "/api/admission-periods",
    "admissions.createAdmissionPeriod",
    person("admissions.create-period", "admissions.period-create", [], "Transaction"),
  ],
  [
    "PATCH",
    "/api/admission-periods/:admissionPeriodId",
    "admissions.reviseAdmissionPeriod",
    person("admissions.revise-period", "admissions.period-by-id", [], "Transaction"),
  ],
  [
    "GET",
    "/api/recruitment/invitation-response",
    "recruitment.readInvitationResponse",
    invitation([], "SnapshotRead"),
  ],
  [
    "POST",
    "/api/recruitment/invitation-response:confirm",
    "recruitment.confirmInvitation",
    invitation(["recruitment.invitation-pending"], "Transaction"),
  ],
  [
    "POST",
    "/api/recruitment/invitation-response:reject",
    "recruitment.rejectInvitation",
    invitation(["recruitment.invitation-pending"], "Transaction"),
  ],
  [
    "POST",
    "/api/recruitment/invitation-response:request-new-time",
    "recruitment.requestNewInvitationTime",
    invitation(["recruitment.invitation-pending"], "Transaction"),
  ],
  [
    "GET",
    "/api/recruitment/application-assignments",
    "recruitment.readAssignmentBoard",
    person(
      "reviewApplicants",
      "recruitment.application-assignments",
      ["organization.single-department-leader"],
      "SnapshotRead",
    ),
  ],
  [
    "GET",
    "/api/recruitment/interviews",
    "recruitment.readSchedulingBoard",
    person(
      "recruitment.read-interviews",
      "recruitment.interviews",
      ["organization.single-department-member"],
      "SnapshotRead",
    ),
  ],
  [
    "POST",
    "/api/recruitment/applications/:applicationId/interviews",
    "recruitment.createApplicationInterview",
    person(
      "reviewApplicants",
      "recruitment.application-by-id",
      ["organization.single-department-leader", "recruitment.interviewer-eligible"],
      "Transaction",
    ),
  ],
  [
    "POST",
    "/api/recruitment/interviews/:interviewId:schedule",
    "recruitment.scheduleInterview",
    person(
      "recruitment.schedule-interview",
      "recruitment.interview-by-id",
      ["recruitment.assigned-interviewer-or-leader"],
      "Transaction",
    ),
  ],
  [
    "GET",
    "/api/recruitment/interviews/:interviewId",
    "recruitment.readInterviewConduct",
    person(
      "recruitment.conduct-interview",
      "recruitment.interview-by-id",
      ["recruitment.assigned-interviewer"],
      "SnapshotRead",
    ),
  ],
  [
    "POST",
    "/api/recruitment/interviews/:interviewId:finalize",
    "recruitment.finalizeInterview",
    person(
      "recruitment.conduct-interview",
      "recruitment.interview-by-id",
      ["recruitment.assigned-interviewer"],
      "Transaction",
    ),
  ],
  [
    "POST",
    "/api/recruitment/interviews/:interviewId:cancel",
    "recruitment.cancelInterview",
    person(
      "recruitment.conduct-interview",
      "recruitment.interview-by-id",
      ["recruitment.assigned-interviewer"],
      "Transaction",
    ),
  ],
  [
    "POST",
    "/api/receipts",
    "receipts.submitReceipt",
    person("submitReceipt", "receipts.create", [], "Transaction"),
  ],
  [
    "PATCH",
    "/api/receipts/:receiptId",
    "receipts.reviseReceipt",
    person(
      "receipts.manage-owned",
      "receipts.by-id",
      ["receipts.owner", "receipts.pending"],
      "Transaction",
    ),
  ],
  [
    "POST",
    "/api/receipts/:receiptId:withdraw",
    "receipts.withdrawReceipt",
    person(
      "receipts.manage-owned",
      "receipts.by-id",
      ["receipts.owner", "receipts.pending"],
      "Transaction",
    ),
  ],
  [
    "GET",
    "/api/receipts",
    "receipts.listReceipts",
    person("receipts.read-owned", "receipts.owned", ["receipts.owner"], "SnapshotRead"),
  ],
  [
    "GET",
    "/api/receipt-approval-queue",
    "receipts.listReceiptsForApproval",
    person(
      "approveReceipt",
      "receipts.approval-queue",
      ["receipts.pending", "receipts.approver-relationship"],
      "SnapshotRead",
    ),
  ],
  [
    "POST",
    "/api/receipts/:receiptId:refund",
    "receipts.refundReceipt",
    person(
      "approveReceipt",
      "receipts.by-id",
      ["receipts.pending", "receipts.approver-relationship"],
      "Transaction",
    ),
  ],
  [
    "POST",
    "/api/receipts/:receiptId:reject",
    "receipts.rejectReceipt",
    person(
      "approveReceipt",
      "receipts.by-id",
      ["receipts.pending", "receipts.approver-relationship"],
      "Transaction",
    ),
  ],
  [
    "GET",
    "/api/content/articles",
    "content.readContentWorkspace",
    person("content.read-workspace", "content.articles", [], "SnapshotRead"),
  ],
  [
    "POST",
    "/api/content/articles",
    "content.createArticle",
    person("content.create-article", "content.article-create", [], "Transaction"),
  ],
  [
    "GET",
    "/api/content/articles/:articleId",
    "content.readArticle",
    person("content.read-article", "content.article-by-id", [], "SnapshotRead"),
  ],
  [
    "PATCH",
    "/api/content/articles/:articleId",
    "content.reviseArticle",
    person(
      "content.revise-article",
      "content.article-by-id",
      ["content.draft", "content.owner"],
      "Transaction",
    ),
  ],
  [
    "POST",
    "/api/content/articles/:articleId:publish",
    "content.publishArticle",
    person(
      "content.publish-article",
      "content.article-by-id",
      ["content.publishable"],
      "Transaction",
    ),
  ],
  [
    "POST",
    "/api/content/articles/:articleId:unpublish",
    "content.unpublishArticle",
    person(
      "content.publish-article",
      "content.article-by-id",
      ["content.unpublishable"],
      "Transaction",
    ),
  ],
  ["GET", "/api/news", "content.listNews", anonymous("content.public-news")],
  ["GET", "/api/news/:slug", "content.readNewsArticle", anonymous("content.public-news-by-slug")],
  [
    "GET",
    "/api/receipt-lifecycle-evidence-records/:receiptId",
    "internal.readReceiptEvidence",
    expectedAccess({
      exposure: "Internal",
      credentials: ["BetterAuthCookie"],
      principals: ["Person"],
      capability: "receipts.read-internal-evidence",
      resolver: "receipts.by-id",
      requirements: ["internal-evidence.enabled", "receipts.owner"],
      decisionTime: "SnapshotRead",
    }),
  ],
];

const reflectedOperations = () =>
  [
    ...Object.values(ExternalNativeApi.groups).flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) => ({ group, endpoint })),
    ),
    ...Object.values(InternalNativeApi.groups).flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) => ({ group, endpoint })),
    ),
  ].map(({ group, endpoint }): ExpectedOperation => {
    const reflected = reflectAccessSpec(endpoint);
    if (reflected._tag === "None") {
      throw new TypeError(`${group.identifier}.${endpoint.identifier} has no AccessSpec`);
    }
    return [
      endpoint.method,
      endpoint.path.replaceAll("::", ":"),
      `${group.identifier}.${endpoint.identifier}`,
      projectVektorAccess(reflected.value),
    ];
  });

describe("native API reflection", () => {
  it("equals the frozen 53-row matrix without a gap or legacy authority", () => {
    const actual = reflectedOperations();
    const authorities = actual.map(([method, path]) => `${method} ${path}`);
    const operationIds = actual.map(([, , operationId]) => operationId);

    expect(actual).toEqual(expectedOperations);
    expect(actual).toHaveLength(53);
    expect(new Set(authorities).size).toBe(53);
    expect(new Set(operationIds).size).toBe(53);
    expect(authorities.some((authority) => /\/api\/admin(?:\/|$)/u.test(authority))).toBe(false);
    expect(
      authorities.some((authority) =>
        /\/api\/(?:me|field_of_studies|receipts\/submit|e2e)(?:\/|$)/u.test(authority),
      ),
    ).toBe(false);
    expect(
      authorities.some((authority) => /::|\/(?:revise|publish|unpublish)$/u.test(authority)),
    ).toBe(false);
  });
  it("keeps 52 external authorities and one internal authority on separate roots", () => {
    const external = endpointInventory();
    const internal = internalEndpointInventory();
    const externalAuthorities = external.map(({ method, path }) => `${method} ${path}`);

    expect(external).toHaveLength(52);
    expect(new Set(externalAuthorities).size).toBe(52);
    expect(external.map(({ group }) => group)).not.toContain("internal");
    expect(internal).toEqual([
      {
        group: "internal",
        identifier: "readReceiptEvidence",
        method: "GET",
        path: "/api/receipt-lifecycle-evidence-records/:receiptId",
      },
    ]);
  });

  it("generates public OpenAPI from only the external root", () => {
    const operations = documentedOperations();

    expect(Context.get(InternalNativeApi.groups.internal.annotations, OpenApi.Exclude)).toBe(true);
    expect(operations).toHaveLength(52);
    expect(operations.some(({ path }) => path.startsWith("/api/e2e"))).toBe(false);
    expect(operations.some(({ path }) => path.startsWith("/api/auth"))).toBe(false);
  });

  it("projects one declared AccessSpec without credential leakage or a second registry", () => {
    const spec = OpenApi.fromApi(ExternalNativeApi);
    const health = spec.paths["/health"]?.get as Record<string, unknown> | undefined;
    const reflected = reflectAccessSpec(HealthEndpoint);

    expect(health?.["x-vektor-access"]).toEqual({
      exposure: "External",
      acceptedCredentials: ["None"],
      principalKinds: ["Anonymous"],
      capabilities: { none: true },
      requirements: [],
      canonicalScopeResolver: "system.health",
      concealment: { mode: "Reveal", stages: [] },
      decisionTime: "SnapshotRead",
    });
    expect(health?.security).toEqual([]);
    expect(reflected._tag).toBe("Some");
    if (reflected._tag === "Some") {
      expect(reflected.value).toEqual(PUBLIC_SYSTEM_ACCESS);
    }
    expect(() => annotateAccessSpec(HealthEndpoint, PUBLIC_SYSTEM_ACCESS)).toThrow(
      /multiple AccessSpec annotations/u,
    );
  });

  it("keeps access projection registries aligned with the domain roots", () => {
    expect(() => assertAccessProjectionRegistryParity()).not.toThrow();
  });

  it("derives stable fully-qualified group.endpoint operation ids", () => {
    const spec = OpenApi.fromApi(ExternalNativeApi);
    const actual = documentedOperations()
      .map(({ operation }) => operation.operationId)
      .sort();
    const expected = endpointInventory()
      .map(({ group, identifier }) => `${group}.${identifier}`)
      .sort();
    const internal = internalEndpointInventory().map(
      ({ group, identifier }) => `${group}.${identifier}`,
    );

    expect(actual).toEqual(expected);
    expect(actual).toEqual(
      expect.arrayContaining([
        "system.health",
        "organization.listDepartments",
        "profile.readOwnProfile",
        "organization.createDepartment",
        "admissions.createAdmissionPeriod",
        "recruitment.readSchedulingBoard",
        "receipts.submitReceipt",
        "content.listNews",
      ]),
    );
    expect(internal).toEqual(["internal.readReceiptEvidence"]);
    expect(actual).not.toContain(internal[0]);
    expect(spec.paths["/api/departments"]?.get?.operationId).toBe("organization.listDepartments");
  });

  it("derives unique operation ids and representative request, response, and error schemas", () => {
    const spec = OpenApi.fromApi(ExternalNativeApi);
    const operations = documentedOperations();
    const operationIds = operations.map(({ operation }) => operation.operationId);
    const provenanceSpec = spec as typeof spec & {
      readonly "x-vektorprogrammet-provenance"?: unknown;
    };
    const operationProvenance = operations.map(
      ({ operation }) =>
        (
          operation as typeof operation & {
            readonly "x-vektorprogrammet-provenance"?: unknown;
          }
        )["x-vektorprogrammet-provenance"],
    );

    expect(new Set(operationIds).size).toBe(operations.length);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Vektorprogrammet native preview API");
    expect(spec.servers ?? []).toEqual([]);
    expect(provenanceSpec["x-vektorprogrammet-provenance"]).toBeDefined();
    expect(operationProvenance.every((provenance) => provenance !== undefined)).toBe(true);
    expect(operations.every(({ operation }) => operation.tags.length > 0)).toBe(true);
    expect(spec.paths["/api/session"]?.get?.security[0]?.cookieHeader).toEqual([]);
    expect(spec.paths["/api/departments"]?.get?.responses["200"]).toBeDefined();
    expect(spec.paths["/api/session"]?.get?.responses["401"]).toBeDefined();
    expect(spec.paths["/api/departments"]?.post?.responses["201"]).toBeDefined();
    expect(
      spec.paths["/api/receipts"]?.post?.requestBody?.content["multipart/form-data"],
    ).toBeDefined();
    expect(spec.paths["/api/receipts"]?.post?.responses["422"]).toBeDefined();
    expect(
      spec.paths["/api/recruitment/interviews/{interviewId}:finalize"]?.post?.responses["409"],
    ).toBeDefined();
    expect(spec.paths["/api/news/{slug}"]?.get?.responses["200"]).toBeDefined();
  });
});

describe("frozen v0.2 boundary schemas", () => {
  const strict = { onExcessProperty: "error" } as const;

  it("keeps merge-patch absence distinct from null and unknown fields", () => {
    expect(Schema.decodeUnknownSync(ProfileMergePatch)({ firstName: "Ada" }, strict)).toEqual({
      firstName: "Ada",
    });
    expect(Schema.decodeUnknownSync(ProfileMergePatch)({}, strict)).toEqual({});
    expect(Schema.decodeUnknownSync(ProfileMergePatch)({ email: null }, strict)).toEqual({
      email: null,
    });
    expect(() =>
      Schema.decodeUnknownSync(ProfileMergePatch)({ personId: "person-1" }, strict),
    ).toThrow();
  });

  it("cuts the directory response over to people names without an alias", () => {
    const response = { activePeople: [], inactivePeople: [], nextCursor: null };
    expect(Schema.decodeUnknownSync(PeopleDirectoryResponse)(response, strict)).toEqual(response);
    expect(() =>
      Schema.decodeUnknownSync(PeopleDirectoryResponse)(
        { activeUsers: [], inactiveUsers: [], nextCursor: null },
        strict,
      ),
    ).toThrow();
  });

  it("keeps endpoint problem variants correlated and validation extensions mandatory", () => {
    const problem = {
      ...NativeProblemRegistry["internal.error"],
      code: "internal.error",
    } as const;
    expect(Schema.decodeUnknownSync(SystemHealthProblem)(problem, strict)).toEqual(problem);
    expect(() =>
      Schema.decodeUnknownSync(SystemHealthProblem)(
        { ...problem, detail: "database password leaked" },
        strict,
      ),
    ).toThrow();

    const validationProblem = {
      ...NativeProblemRegistry["validation.failed"],
      code: "validation.failed",
      validation: {
        errors: [
          {
            pointer: "/firstName",
            code: "invalid",
            message: "The value is invalid.",
          },
        ],
        truncated: false,
      },
    } as const;
    expect(
      Schema.decodeUnknownSync(ProfileUpdateOwnProfileProblem)(validationProblem, strict),
    ).toEqual(validationProblem);
    const { validation: _, ...validationCore } = validationProblem;
    expect(() =>
      Schema.decodeUnknownSync(ProfileUpdateOwnProfileProblem)(validationCore, strict),
    ).toThrow();
  });
});
