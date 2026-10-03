import {
  ExternalNativeApi,
  InternalNativeApi,
  NativeApiReleaseName,
  NativeApiReleaseVersion,
  ProfileApi,
} from "@vektorprogrammet/http-api";
import { describe, expect, it } from "@effect/vitest";
import { HttpApi, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import operationIndex from "../../native-api-operations.json" with { type: "json" };
import { createEffectClient } from "../effect-client.js";
import { createPromiseClient } from "../promise.js";

const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const operationTuples = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
) =>
  Object.entries(OpenApi.fromApi(api).paths)
    .flatMap(([path, pathItem]) =>
      methods.flatMap((method) => {
        const operation = pathItem[method];

        return operation === undefined
          ? []
          : [
              {
                group: operation.operationId.split(".", 1)[0]!,
                method: method.toUpperCase(),
                operationId: operation.operationId,
                path,
              },
            ];
      }),
    )
    .toSorted((left, right) => left.operationId.localeCompare(right.operationId));

describe("generated Profile operation index", () => {
  it("is the exact external API projection, without internal operations", () => {
    const projected = operationTuples(ExternalNativeApi);
    const ids = projected.map((operation) => operation.operationId);

    const internalIds = new Set(
      Object.values(InternalNativeApi.groups).flatMap((group) =>
        Object.keys(group.endpoints).map((key) => `${group.identifier}.${key}`),
      ),
    );

    expect(operationIndex.operations).toEqual(projected);
    expect(new Set(ids).size).toBe(ids.length);
    expect(projected).toHaveLength(107);
    expect(projected.filter((operation) => operation.group === "profile")).toHaveLength(2);
    expect(ids.every((id) => !internalIds.has(id))).toBe(true);
    expect(operationIndex.release).toEqual({
      name: NativeApiReleaseName,
      version: NativeApiReleaseVersion,
    });
    expect(operationIndex.source.contract).toBe("@vektorprogrammet/http-api/ExternalNativeApi");
  });

  it("keeps generated Profile endpoints, both clients and the index in lockstep", () => {
    const profileOnly = operationTuples(HttpApi.make("profile-index-test").add(ProfileApi));
    const indexed = operationIndex.operations.filter((operation) => operation.group === "profile");
    const endpointKeys = Object.keys(ProfileApi.endpoints).toSorted();

    expect(indexed).toEqual(profileOnly);
    expect(endpointKeys).toEqual(["readOwnProfile", "updateOwnProfile"]);
    expect(Object.keys(createEffectClient(undefined).profile).toSorted()).toEqual(endpointKeys);
    expect(Object.keys(createPromiseClient(undefined).profile).toSorted()).toEqual(endpointKeys);
  });
});
