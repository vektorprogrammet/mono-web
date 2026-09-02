import { PUBLIC_SYSTEM_ACCESS } from "@vektorprogrammet/domain/authz";
import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import { Context, Schema } from "effect";
import { HttpApiClient, OpenApi } from "effect/unstable/httpapi";
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
    expectedAccess({
      credentials: ["BetterAuthCookie", "OAuthUserBearer", "OAuthServiceBearer"],
      principals: ["Person", "ServicePrincipal"],
      capability: "approveReceipt",
      resolver: "receipts.approval-queue",
      requirements: ["receipts.pending", "receipts.approver-relationship"],
      decisionTime: "SnapshotRead",
    }),
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

const publicConditionalOperations = [
  "organization.listDepartments",
  "organization.listTeams",
  "organization.listFieldOfStudies",
  "admissions.listOpenAdmissionPeriods",
  "admissions.listApplicationOptions",
  "content.listNews",
  "content.readNewsArticle",
] as const;

const privateConditionalOperations = [
  "profile.readOwnProfile",
  "admissions.listAdmissionPeriods",
  "recruitment.readInvitationResponse",
  "recruitment.readInterviewConduct",
  "content.readArticle",
] as const;

const createdMutationOperations = [
  "organization.createDepartment",
  "organization.createTeam",
  "organization.createFieldOfStudy",
  "admissions.submitApplication",
  "admissions.createAdmissionPeriod",
  "recruitment.createApplicationInterview",
  "receipts.submitReceipt",
  "content.createArticle",
] as const;

const entityMutationOperations = [
  "profile.updateOwnProfile",
  "admissions.reviseAdmissionPeriod",
  "recruitment.scheduleInterview",
  "recruitment.finalizeInterview",
  "recruitment.cancelInterview",
  "receipts.reviseReceipt",
  "receipts.withdrawReceipt",
  "receipts.refundReceipt",
  "receipts.rejectReceipt",
  "content.reviseArticle",
  "content.publishArticle",
  "content.unpublishArticle",
] as const;

const taggedNoContentMutationOperations = [
  "recruitment.confirmInvitation",
  "recruitment.rejectInvitation",
  "recruitment.requestNewInvitationTime",
] as const;

const plainNoContentMutationOperations = [
  "system.deleteSession",
  "system.deleteOwnedSession",
  "system.revokeOtherSessions",
  "system.revokeAllSessions",
] as const;

const privateReadOperations = [
  "system.readSession",
  "system.listSessions",
  "organization.listTeamInterest",
  "organization.listMailingLists",
  "directory.listPeople",
  "directory.listSchools",
  "recruitment.readAssignmentBoard",
  "recruitment.readSchedulingBoard",
  "receipts.listReceipts",
  "receipts.listReceiptsForApproval",
  "content.readContentWorkspace",
] as const;

const noStoreReadOperations = ["system.health", "admissions.readApplicationConfirmation"] as const;

const existingResourceMutationOperations = new Set<string>([
  ...entityMutationOperations,
  ...taggedNoContentMutationOperations,
]);
const reflectedOperations = () => {
  const externalPaths = new Map(
    documentedOperations().map(({ path, operation }) => [operation.operationId, path] as const),
  );
  return [
    ...Object.values(ExternalNativeApi.groups).flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) => ({ group, endpoint })),
    ),
    ...Object.values(InternalNativeApi.groups).flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) => ({ group, endpoint })),
    ),
  ].map(({ group, endpoint }): ExpectedOperation => {
    const operationId = `${group.identifier}.${endpoint.identifier}`;
    const publicPath = externalPaths.get(operationId);
    const reflected = reflectAccessSpec(endpoint);
    if (reflected._tag === "None") {
      throw new TypeError(`${operationId} has no AccessSpec`);
    }
    return [
      endpoint.method,
      publicPath?.replace(/\{(\w+)\}/g, ":$1") ?? endpoint.path,
      operationId,
      projectVektorAccess(reflected.value),
    ];
  });
};

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

  it("compiles escaped action paths once for OpenAPI and client URLs", () => {
    const spec = OpenApi.fromApi(ExternalNativeApi);
    const urls = HttpApiClient.urlBuilder(ExternalNativeApi);

    expect(spec.paths["/api/sessions:revoke-others"]?.post).toBeDefined();
    expect(spec.paths["/api/receipts/{receiptId}:withdraw"]?.post).toBeDefined();
    expect(spec.paths["/api/content/articles/{articleId}:publish"]?.post).toBeDefined();
    expect(
      Object.keys(spec.paths).some((path) => path.includes("([^:]+)") || path.includes("::")),
    ).toBe(false);
    expect(urls.system.revokeOtherSessions()).toBe("/api/sessions:revoke-others");
    expect(
      urls.receipts.withdrawReceipt({
        params: { receiptId: ReceiptId.make("receipt/with-colon:segment") },
      }),
    ).toBe("/api/receipts/receipt%2Fwith-colon%3Asegment:withdraw");
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

  it("freezes endpoint metadata, schemas, headers, and access projections programmatically", () => {
    const spec = OpenApi.fromApi(ExternalNativeApi);
    const operations = documentedOperations();
    const byId = new Map(
      operations.map(({ operation }) => [operation.operationId, operation] as const),
    );
    const categories = [
      ...publicConditionalOperations,
      ...privateConditionalOperations,
      ...createdMutationOperations,
      ...entityMutationOperations,
      ...taggedNoContentMutationOperations,
      ...plainNoContentMutationOperations,
      ...privateReadOperations,
      ...noStoreReadOperations,
    ];
    expect(categories).toHaveLength(52);
    expect(new Set(categories).size).toBe(52);
    expect([...byId.keys()].sort()).toEqual([...categories].sort());

    const operation = (operationId: string) => {
      const value = byId.get(operationId);
      if (value === undefined) throw new TypeError(`missing ${operationId}`);
      return value;
    };
    const assertSuccess = (
      operationId: string,
      status: "200" | "201" | "204" | "304",
      headers: ReadonlyArray<string>,
      body: boolean,
    ) => {
      const response = operation(operationId).responses[status];
      if (response === undefined) throw new TypeError(`${operationId} has no ${status}`);
      expect(Object.keys(response.headers ?? {}).sort()).toEqual([...headers].sort());
      expect(Object.keys(response.content ?? {})).toEqual(body ? ["application/json"] : []);
    };

    for (const operationId of [...publicConditionalOperations, ...privateConditionalOperations]) {
      assertSuccess(operationId, "200", ["cache-control", "etag", "vary"], true);
      assertSuccess(operationId, "304", ["cache-control", "etag", "vary"], false);
    }
    for (const operationId of createdMutationOperations) {
      assertSuccess(operationId, "201", ["cache-control", "etag", "location", "vary"], true);
    }
    for (const operationId of entityMutationOperations) {
      assertSuccess(operationId, "200", ["cache-control", "etag", "vary"], true);
    }
    for (const operationId of taggedNoContentMutationOperations) {
      assertSuccess(operationId, "204", ["cache-control", "etag", "vary"], false);
    }
    for (const operationId of plainNoContentMutationOperations) {
      assertSuccess(operationId, "204", ["cache-control", "vary"], false);
    }
    for (const operationId of [...privateReadOperations, ...noStoreReadOperations]) {
      assertSuccess(operationId, "200", ["cache-control", "vary"], true);
    }

    const tags = new Map<string, string>([
      ["admissions", "Admissions"],
      ["content", "Content and news"],
      ["directory", "Directories"],
      ["organization", "Organization"],
      ["profile", "Profile"],
      ["receipts", "Receipts"],
      ["recruitment", "Recruitment"],
      ["system", "System"],
    ]);
    for (const [operationId, documented] of byId) {
      const group = operationId.slice(0, operationId.indexOf("."));
      const tag = tags.get(group);
      if (tag === undefined) throw new TypeError(`unknown group ${group}`);
      expect(documented.tags).toEqual([tag]);
      expect(documented.summary?.trim().length).toBeGreaterThan(0);
      expect(documented.description?.trim().length).toBeGreaterThan(0);
      for (const [status, response] of Object.entries(documented.responses)) {
        if (Number(status) < 400) {
          if (status !== "201") expect(response.headers).not.toHaveProperty("location");
          continue;
        }
        expect(Object.keys(response.content ?? {})).toEqual(["application/problem+json"]);
        const headers = Object.keys(response.headers ?? {});
        expect(headers).toEqual(expect.arrayContaining(["cache-control", "vary"]));
        if (status === "401") expect(headers).toContain("www-authenticate");
        if (status === "429" || status === "503") expect(headers).toContain("retry-after");
        if (status === "500") expect(headers).not.toContain("retry-after");
      }
    }

    const conditional = new Set<string>([
      ...publicConditionalOperations,
      ...privateConditionalOperations,
    ]);
    const mutations = new Set<string>([
      ...createdMutationOperations,
      ...entityMutationOperations,
      ...taggedNoContentMutationOperations,
      ...plainNoContentMutationOperations,
    ]);
    for (const operationId of categories) {
      const headerParameters = (operation(operationId).parameters ?? [])
        .filter((parameter) => "in" in parameter && parameter.in === "header")
        .map((parameter) => ("name" in parameter ? parameter.name.toLowerCase() : ""))
        .sort();
      if (conditional.has(operationId)) {
        expect(headerParameters).toEqual(["if-match", "if-none-match"]);
      } else if (mutations.has(operationId)) {
        expect(headerParameters).toEqual(
          existingResourceMutationOperations.has(operationId)
            ? ["idempotency-key", "if-match"]
            : ["idempotency-key"],
        );
      } else {
        expect(headerParameters).toEqual([]);
      }
    }

    for (const operationId of [
      "profile.updateOwnProfile",
      "admissions.reviseAdmissionPeriod",
      "content.reviseArticle",
    ]) {
      expect(Object.keys(operation(operationId).requestBody?.content ?? {})).toEqual([
        "application/merge-patch+json",
      ]);
    }
    for (const operationId of ["receipts.submitReceipt", "receipts.reviseReceipt"]) {
      const multipart = operation(operationId).requestBody?.content["multipart/form-data"];
      if (multipart === undefined) throw new TypeError(`${operationId} has no multipart body`);
      const requestSchema = multipart.schema;
      if (
        requestSchema === undefined ||
        !("$ref" in requestSchema) ||
        typeof requestSchema.$ref !== "string"
      ) {
        throw new TypeError(`${operationId} multipart schema is not a component reference`);
      }
      const componentName = requestSchema.$ref.slice(requestSchema.$ref.lastIndexOf("/") + 1);
      expect(JSON.stringify(spec.components.schemas[componentName])).toContain('"format":"binary"');
    }
    expect(operation("receipts.listReceiptsForApproval").security).toEqual([
      { cookieHeader: [] },
      { oauthUserBearer: [] },
      { oauthServiceBearer: [] },
    ]);
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
