import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { ExternalNativeApi, InternalNativeApi } from "../src/api.js";
import { NativeApiReleaseVersion } from "../src/release.js";
import { OpenApi } from "effect/unstable/httpapi";
import { Array as Arr, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect";
import assert from "node:assert/strict";

// Writes the ignored OpenAPI projection of ExternalNativeApi and checks its release invariants.
// Turbo runs this `generate` task before type checks and builds; never commit its output.
const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const unexpectedArguments = process.argv.slice(2);

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

const document = OpenApi.fromApi(ExternalNativeApi);

assert(
  document.openapi === "3.1.0",
  `expected OpenAPI 3.1.0, received ${String(document.openapi)}`,
);

assert(
  document.info.version === NativeApiReleaseVersion,
  "OpenAPI and NativeApi release versions differ",
);

const externalOperationIds = Object.entries(document.paths).flatMap(([path, pathItem]) =>
  methods.flatMap((method) => {
    const operation = pathItem[method];

    if (operation === undefined) return [];
    assert(operation.operationId.length > 0, `${method} ${path} has no operationId`);

    return [operation.operationId];
  }),
);

const internalOperationIds = Object.values(InternalNativeApi.groups).flatMap((group) =>
  Object.values(group.endpoints).map((endpoint) => `${group.identifier}.${endpoint.identifier}`),
);

const operationIds = [...externalOperationIds, ...internalOperationIds];

assert(new Set(operationIds).size === operationIds.length, "operationId values must be unique");

assert(
  externalOperationIds.length ===
    Object.values(ExternalNativeApi.groups).reduce(
      (count, group) => count + Object.keys(group.endpoints).length,
      0,
    ),
  "OpenAPI operation count differs from its source contract",
);

assert(
  internalOperationIds.length === 1,
  `expected 1 internal operation, received ${internalOperationIds.length}`,
);

await Effect.runPromise(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = yield* path.fromFileUrl(new URL("../openapi.json", import.meta.url));

    const json = yield* Schema.decodeUnknownEffect(Schema.Json)(document);

    yield* fileSystem.writeFileString(target, encode(json));
  }).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer))),
);

process.stdout.write(
  `generated NativeApi ${NativeApiReleaseVersion} OpenAPI: ${externalOperationIds.length} external operations; ${internalOperationIds.length} internal operation excluded\n`,
);
