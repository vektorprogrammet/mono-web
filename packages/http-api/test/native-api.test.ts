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
  [
    "GET",
    "/api/substitutes/scopes",
    "substitutes.listScopes",
    person("substitutes.read", "substitutes.application-scope", [], "SnapshotRead"),
  ],
  [
    "GET",
    "/api/substitutes",
    "substitutes.readPool",
    person("substitutes.read", "substitutes.application-scope", [], "SnapshotRead"),
  ],
  [
    "GET",
    "/api/substitutes/:applicationId",
    "substitutes.readEntry",
    person("substitutes.read", "substitutes.application-scope", [], "SnapshotRead"),
  ],
  [
    "POST",
    "/api/substitutes/:applicationId:activate",
    "substitutes.activate",
    person("substitutes.manage", "substitutes.application-scope", [], "Transaction"),
  ],
  [
    "POST",
    "/api/substitutes/:applicationId:edit",
    "substitutes.edit",
    person("substitutes.manage", "substitutes.application-scope", [], "Transaction"),
  ],
  [
    "POST",
    "/api/substitutes/:applicationId:deactivate",
    "substitutes.deactivate",
    person("substitutes.manage", "substitutes.application-scope", [], "Transaction"),
  ],

  [
    "POST",
    "/api/contact-messages",
    "contact.submitContactMessage",
    expectedAccess({
      credentials: ["ObjectCapability"],
      principals: ["CapabilityHolder"],
      capability: "contact.submit",
      resolver: "contact.department-recipient",
      decisionTime: "SnapshotRead",
    }),
  ],
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
    "GET",
    "/api/receipts/:receiptId/file",
    "receipts.readReceiptFile",
    person("receipts.read-owned", "receipts.by-id", ["receipts.owner"], "SnapshotRead"),
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

const expectedExternalCount = expectedOperations.filter(
  ([, , , access]) => access.exposure === "External",
).length;
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
  "substitutes.readEntry",
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
  "substitutes.activate",
  "substitutes.edit",
  "substitutes.deactivate",
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
  "substitutes.listScopes",
  "substitutes.readPool",
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
  it("equals the explicit operation matrix without a gap or legacy authority", () => {
