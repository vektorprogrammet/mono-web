import { readFile, writeFile } from "node:fs/promises";
import {
  ExternalNativeApi,
  NativeApiReleaseName,
  NativeApiReleaseVersion,
} from "@vektorprogrammet/http-api";
import { OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import assert from "node:assert/strict";

// Writes the ignored operation index that `@vektorprogrammet/sdk/operations` publishes.
// Turbo runs this `generate` task before type checks and builds; `prepack` runs it before packing.
const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const packageManifest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
)(await readFile(new URL("../package.json", import.meta.url), "utf8"));

assert(
  packageManifest.version === NativeApiReleaseVersion,
  "SDK package version is not synchronized",
);

const operations = Object.entries(OpenApi.fromApi(ExternalNativeApi).paths)
  .flatMap(([path, pathItem]) =>
    methods.flatMap((method) => {
      const operation = pathItem[method];

      if (operation === undefined) return [];

      return [
        {
          group: operation.operationId.split(".", 1)[0]!,
          method: method.toUpperCase(),
          operationId: operation.operationId,
          path,
        },
      ];
    }),
  )
  .sort((left, right) => left.operationId.localeCompare(right.operationId));

// Keys are written in sorted order, so JSON.stringify keeps the published encoding stable.
const operationIndex = {
  operations,
  release: { name: NativeApiReleaseName, version: NativeApiReleaseVersion },
  schemaVersion: 1,
  source: {
    contract: "@vektorprogrammet/http-api/ExternalNativeApi",
    projection: "effect/unstable/httpapi/HttpApiClient.make",
  },
};

await writeFile(
  new URL("../native-api-operations.json", import.meta.url),
  `${JSON.stringify(operationIndex, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `generated NativeApi ${NativeApiReleaseVersion} SDK operation index: ${operations.length} operations\n`,
);
