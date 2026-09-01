import { PUBLIC_SYSTEM_ACCESS } from "@vektorprogrammet/domain/authz";
import { Context } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { ExternalNativeApi, InternalNativeApi } from "../src/api.js";
import {
  annotateAccessSpec,
  assertAccessProjectionRegistryParity,
  reflectAccessSpec,
} from "../src/access.js";
import { HealthEndpoint } from "../src/system.js";

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

describe("native API reflection", () => {
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
        path: "/api/e2e/receipts/:receiptId/evidence",
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
      canonicalScopeResolver: "system.public",
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
    expect(spec.paths["/api/admin/departments"]?.post?.responses["201"]).toBeDefined();
    expect(
      spec.paths["/api/receipts/submit"]?.post?.requestBody?.content["multipart/form-data"],
    ).toBeDefined();
    expect(spec.paths["/api/receipts/submit"]?.post?.responses["422"]).toBeDefined();
    expect(
      spec.paths["/api/admin/recruitment/interviews/{interviewId}/finalize"]?.post?.responses[
        "409"
      ],
    ).toBeDefined();
    expect(spec.paths["/api/news/{slug}"]?.get?.responses["200"]).toBeDefined();
  });
});
