import { Context } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { NativeApi } from "../src/api.js";

const endpointInventory = () =>
  Object.values(NativeApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => ({
      group: group.identifier,
      identifier: endpoint.identifier,
      method: endpoint.method,
      path: endpoint.path,
    })),
  );

const documentedOperations = () => {
  const spec = OpenApi.fromApi(NativeApi);
  const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    methods.flatMap((method) => {
      const operation = item[method];
      return operation === undefined ? [] : [{ method, path, operation }];
    }),
  );
};

describe("NativeApi reflection", () => {
  it("contains 53 unique method/path authorities without a handwritten route list", () => {
    const inventory = endpointInventory();
    const authorities = inventory.map(({ method, path }) => `${method} ${path}`);

    expect(inventory).toHaveLength(53);
    expect(new Set(authorities).size).toBe(53);
    expect(inventory.filter(({ group }) => group === "internal")).toHaveLength(1);
  });

  it("excludes only the internal evidence group from the public projection", () => {
    const internal = NativeApi.groups.internal;
    const operations = documentedOperations();

    expect(Context.get(internal.annotations, OpenApi.Exclude)).toBe(true);
    expect(operations).toHaveLength(52);
    expect(operations.some(({ path }) => path.startsWith("/api/e2e"))).toBe(false);
    expect(operations.some(({ path }) => path.startsWith("/api/auth"))).toBe(false);
  });

  it("derives stable fully-qualified group.endpoint operation ids", () => {
    const spec = OpenApi.fromApi(NativeApi);
    const actual = documentedOperations()
      .map(({ operation }) => operation.operationId)
      .sort();
    const expected = endpointInventory()
      .filter(({ group }) => group !== "internal")
      .map(({ group, identifier }) => `${group}.${identifier}`)
      .sort();
    const internal = endpointInventory()
      .filter(({ group }) => group === "internal")
      .map(({ group, identifier }) => `${group}.${identifier}`);

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
    const spec = OpenApi.fromApi(NativeApi);
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
