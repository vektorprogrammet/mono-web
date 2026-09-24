import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalNativeApi, InternalNativeApi } from "../src/api.js";
import { NativeApiReleaseName, NativeApiReleaseVersion } from "../src/release.js";
import { OpenApi } from "effect/unstable/httpapi";
import { Array as Arr, Predicate, Schema } from "effect";
import assert from "node:assert/strict";

const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const outputPaths = {
  openapi: resolve(packageRoot, "openapi.json"),
  releaseManifest: resolve(packageRoot, "release-manifest.json"),
  sdkOperations: resolve(repositoryRoot, "packages/sdk/native-api-operations.json"),
  serverMetadata: resolve(repositoryRoot, "apps/backend/src/generated/native-api-metadata.json"),
} as const;

const relativePaths = {
  openapi: "packages/http-api/openapi.json",
  releaseManifest: "packages/http-api/release-manifest.json",
  sdkOperations: "packages/sdk/native-api-operations.json",
  serverMetadata: "apps/backend/src/generated/native-api-metadata.json",
} as const;

const check = process.argv.slice(2).includes("--check");

const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unexpectedArguments.length > 0) {
  throw new Error(`unknown arguments: ${unexpectedArguments.join(", ")}`);
}

const stable = (value: Schema.Json): Schema.Json => {
  if (value === null || Predicate.isBoolean(value) || Predicate.isString(value)) return value;

  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value)) throw new Error("OpenAPI contains a non-finite number");

    return value;
  }

  if (Arr.isArray<Schema.Json>(value)) return value.map(stable);

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
};

const encode = (value: Schema.Json): string => `${JSON.stringify(stable(value), null, 2)}\n`;

const sha256 = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");

type OperationProjection = {
  readonly access: Schema.Json;
  readonly group: string;
  readonly method: string;
  readonly operationId: string;
  readonly path: string;
  readonly statuses: ReadonlyArray<string>;
  readonly summary: string;
  readonly visibility: "external" | "internal";
};

const decodeAccessProjection = Schema.decodeUnknownSync(
  Schema.Struct({ "x-vektor-access": Schema.Json }),
);

const collectExternalOperations = (
  document: OpenApi.OpenAPISpec,
): ReadonlyArray<OperationProjection> => {
  const operations: Array<OperationProjection> = [];

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of methods) {
      const operation = pathItem[method];

      if (operation === undefined) continue;
      const operationId = operation.operationId;
      assert(
        operationId !== undefined && operationId.length > 0,
        `${method} ${path} has no operationId`,
      );
      const access = decodeAccessProjection(operation)["x-vektor-access"];
      operations.push({
        access,
        group: operationId.split(".", 1)[0]!,
        method: method.toUpperCase(),
        operationId,
        path,
        statuses: Object.keys(operation.responses).sort(),
        summary: operation.summary ?? operationId,
        visibility: "external",
      });
    }
  }

  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId));
};

const collectInternalOperations = (): ReadonlyArray<OperationProjection> => {
  return Object.values(InternalNativeApi.groups)

    .flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) => ({
        access: null,
        group: group.identifier,
        method: endpoint.method,
        operationId: `${group.identifier}.${endpoint.identifier}`,
        path: endpoint.path.replace(/:(\w+)/g, "{$1}"),
        statuses: [],
        summary: endpoint.identifier,
        visibility: "internal" as const,
      })),
    )
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
};

const readPackageVersion = async (path: string): Promise<string> => {
  const value = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
    await readFile(path, "utf8"),
  );

  return value.version;
};

const document = OpenApi.fromApi(ExternalNativeApi);

const openapi = document.openapi;

const info = document.info;

assert(openapi === "3.1.0", `expected OpenAPI 3.1.0, received ${String(openapi)}`);

assert(
  info !== null && (info === null || Predicate.isObjectOrArray(info)),
  "OpenAPI info is missing",
);

assert(info.version === NativeApiReleaseVersion, "OpenAPI and NativeApi release versions differ");

const externalOperations = collectExternalOperations(document);

const internalOperations = collectInternalOperations();

const operationIds = [...externalOperations, ...internalOperations].map(
  (operation) => operation.operationId,
);

assert(new Set(operationIds).size === operationIds.length, "operationId values must be unique");

assert(
  externalOperations.length ===
    Object.values(ExternalNativeApi.groups).reduce(
      (count, group) => count + Object.keys(group.endpoints).length,
      0,
    ),
  "OpenAPI operation count differs from its source contract",
);

assert(
  internalOperations.length === 1,
  `expected 1 internal operation, received ${internalOperations.length}`,
);

const [httpApiVersion, sdkVersion] = await Promise.all([
  readPackageVersion(resolve(packageRoot, "package.json")),
  readPackageVersion(resolve(repositoryRoot, "packages/sdk/package.json")),
]);

assert(httpApiVersion === NativeApiReleaseVersion, "HTTP API package version is not synchronized");

assert(sdkVersion === NativeApiReleaseVersion, "SDK package version is not synchronized");

const openapiBytes = encode(Schema.decodeUnknownSync(Schema.Json)(document));

const sdkOperationBytes = encode({
  schemaVersion: 1,
  release: {
    name: NativeApiReleaseName,
    version: NativeApiReleaseVersion,
  },
  source: {
    contract: "@vektorprogrammet/http-api/ExternalNativeApi",
    projection: "effect/unstable/httpapi/HttpApiClient.make",
  },
  operations: externalOperations.map(
    ({
      access: _access,
      statuses: _statuses,
      summary: _summary,
      visibility: _visibility,
      ...operation
    }) => operation,
  ),
});

const serverMetadataBytes = encode({
  schemaVersion: 1,
  release: {
    name: NativeApiReleaseName,
    version: NativeApiReleaseVersion,
  },
  source: {
    contract: "@vektorprogrammet/http-api/ExternalNativeApi + InternalNativeApi",
    projection: "NativeApi reflection + effect/unstable/httpapi/OpenApi.fromApi",
  },
  counts: {
    externalOperations: externalOperations.length,
    internalOperations: internalOperations.length,
    operations: externalOperations.length + internalOperations.length,
  },
  operations: [...externalOperations, ...internalOperations],
});

const releaseManifestBytes = encode({
  schemaVersion: 1,
  release: {
    name: NativeApiReleaseName,
    version: NativeApiReleaseVersion,
  },
  source: {
    contract: "@vektorprogrammet/http-api/ExternalNativeApi",
    effect: await readPackageVersion(fileURLToPath(import.meta.resolve("effect/package.json"))),
    generator: "packages/http-api/scripts/generate-openapi.ts",
  },
  counts: {
    externalOperations: externalOperations.length,
    internalOperations: internalOperations.length,
    operations: externalOperations.length + internalOperations.length,
  },
  artifacts: {
    openapi: {
      path: relativePaths.openapi,
      sha256: sha256(openapiBytes),
    },
    sdkOperations: {
      path: relativePaths.sdkOperations,
      sha256: sha256(sdkOperationBytes),
    },
    serverMetadata: {
      path: relativePaths.serverMetadata,
      sha256: sha256(serverMetadataBytes),
    },
  },
});

const outputs = [
  [outputPaths.openapi, openapiBytes],
  [outputPaths.sdkOperations, sdkOperationBytes],
  [outputPaths.serverMetadata, serverMetadataBytes],
  [outputPaths.releaseManifest, releaseManifestBytes],
] as const;

if (check) {
  const stale: Array<string> = [];

  for (const [path, bytes] of outputs) {
    const existing = await readFile(path, "utf8").catch(() => undefined);

    if (existing !== bytes) stale.push(path.slice(repositoryRoot.length + 1));
  }

  if (stale.length > 0) {
    throw new Error(`generated release artifacts are stale: ${stale.join(", ")}`);
  }

  process.stdout.write(
    `NativeApi ${NativeApiReleaseVersion}: ${externalOperations.length} external + ${internalOperations.length} internal operations are current\n`,
  );
} else {
  for (const [path, bytes] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, "utf8");
  }

  process.stdout.write(
    `generated NativeApi ${NativeApiReleaseVersion}: ${externalOperations.length} external + ${internalOperations.length} internal operations\n`,
  );
}
