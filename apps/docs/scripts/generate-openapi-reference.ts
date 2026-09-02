import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(docsRoot, "../..");
const generatedRoot = process.env.DOCS_GENERATED_ROOT
  ? resolve(process.env.DOCS_GENERATED_ROOT)
  : docsRoot;
const openApiPath = join(repositoryRoot, "packages/http-api/openapi.json");
const releaseManifestPath = join(repositoryRoot, "packages/http-api/release-manifest.json");
const serverMetadataPath = join(
  repositoryRoot,
  "apps/backend/src/generated/native-api-metadata.json",
);
const httpApiPackagePath = join(repositoryRoot, "packages/http-api/package.json");
const outputPath = join(generatedRoot, "src/pages/reference/native-api/index.mdx");
const repositoryUrl = "https://github.com/vektorprogrammet/mono-web";
const httpMethods: Readonly<Record<string, true>> = {
  delete: true,
  get: true,
  head: true,
  options: true,
  patch: true,
  post: true,
  put: true,
  trace: true,
};

const OpenApiDocumentSchema = z.object({
  openapi: z.literal("3.1.0"),
  info: z.object({
    title: z.string(),
    version: z.string(),
  }),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

const PackageSchema = z.object({
  name: z.string(),
  version: z.string(),
});

const ReleaseManifestSchema = z.object({
  artifacts: z.object({
    openapi: z.object({ path: z.string(), sha256: z.string().length(64) }),
    sdkOperations: z.object({ path: z.string(), sha256: z.string().length(64) }),
    serverMetadata: z.object({ path: z.string(), sha256: z.string().length(64) }),
  }),
  counts: z.object({
    externalOperations: z.number().int().nonnegative(),
    internalOperations: z.number().int().nonnegative(),
    operations: z.number().int().nonnegative(),
  }),
  release: z.object({
    name: z.string(),
    version: z.string(),
  }),
});

const ServerMetadataSchema = z.object({
  counts: z.object({
    externalOperations: z.number().int().nonnegative(),
    internalOperations: z.number().int().nonnegative(),
    operations: z.number().int().nonnegative(),
  }),
  operations: z.array(
    z.object({
      operationId: z.string().min(1),
      path: z.string().min(1),
      visibility: z.enum(["external", "internal"]),
    }),
  ),
  release: z.object({ version: z.string() }),
});

type Operation = {
  readonly method: string;
  readonly operationId: string;
  readonly path: string;
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

const collectOperations = (
  paths: z.infer<typeof OpenApiDocumentSchema>["paths"],
): ReadonlyArray<Operation> => {
  const operations: Array<Operation> = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (path.startsWith("/api/auth/")) {
      throw new Error(`Public OpenAPI contains an excluded Better Auth path: ${path}`);
    }

    for (const [method, candidate] of Object.entries(pathItem)) {
      if (httpMethods[method] !== true) continue;
      const operation = z.object({ operationId: z.string().min(1) }).parse(candidate);
      operations.push({ method, operationId: operation.operationId, path });
    }
  }

  return operations;
};

const makeSureOperationsMatchRelease = (
  operations: ReadonlyArray<Operation>,
  manifest: z.infer<typeof ReleaseManifestSchema>,
  serverMetadata: z.infer<typeof ServerMetadataSchema>,
): void => {
  if (manifest.counts.externalOperations !== 52 || manifest.counts.internalOperations !== 1) {
    throw new Error("The release manifest must contain 52 external and one internal operation.");
  }
  if (manifest.counts.operations !== 53) {
    throw new Error("The release manifest must contain 53 total operations.");
  }
  if (operations.length !== manifest.counts.externalOperations) {
    throw new Error(
      `Expected ${manifest.counts.externalOperations} public OpenAPI operations, found ${operations.length}.`,
    );
  }
  if (
    serverMetadata.counts.externalOperations !== manifest.counts.externalOperations ||
    serverMetadata.counts.internalOperations !== manifest.counts.internalOperations ||
    serverMetadata.counts.operations !== manifest.counts.operations
  ) {
    throw new Error("Server metadata and release-manifest operation counts differ.");
  }

  const identifiers = new Set<string>();
  for (const operation of operations) {
    if (identifiers.has(operation.operationId)) {
      throw new Error(`Duplicate OpenAPI operationId: ${operation.operationId}`);
    }
    identifiers.add(operation.operationId);
  }

  const externalMetadata = serverMetadata.operations.filter(
    (operation) => operation.visibility === "external",
  );
  const internalMetadata = serverMetadata.operations.filter(
    (operation) => operation.visibility === "internal",
  );
  const externalIdentifiers = new Set(externalMetadata.map((operation) => operation.operationId));
  if (
    externalIdentifiers.size !== identifiers.size ||
    [...identifiers].some((identifier) => !externalIdentifiers.has(identifier))
  ) {
    throw new Error("Public OpenAPI and external server metadata operations differ.");
  }
  if (internalMetadata.length !== manifest.counts.internalOperations) {
    throw new Error("Internal server metadata operation count differs from the release manifest.");
  }

  const publicPaths = new Set(operations.map((operation) => operation.path));
  for (const operation of internalMetadata) {
    if (identifiers.has(operation.operationId) || publicPaths.has(operation.path)) {
      throw new Error(`Public OpenAPI contains internal operation ${operation.operationId}.`);
    }
  }
};

const page = (
  packageName: string,
  packageVersion: string,
  publicOperationCount: number,
  internalOperationCount: number,
): string => `---
title: Native API reference
description: Generated reference for the ${publicOperationCount} public operations in the native Vektorprogrammet HTTP API.
showAskAi: false
---

import { OpenApi } from "vocs";

# Native API reference

This reference contains **${publicOperationCount} public native operations** from the canonical OpenAPI document.
Better Auth routes are not part of this document.
The **${internalOperationCount} internal operation** remains on its separate ingress and is not part of this public reference.
This operation total is documentation scope, not a legacy parity claim.

Start with [Authentication & authorization](/reference/native-api/authentication) and the [Getting started](/reference/native-api/getting-started) walkthrough, or read [Routes & API](/reference/routes-and-api) for route families, capability owners, and transport boundaries.

## Provenance

- OpenAPI source: [\`packages/http-api/openapi.json\`](${repositoryUrl}/blob/main/packages/http-api/openapi.json)
- Release manifest: [\`packages/http-api/release-manifest.json\`](${repositoryUrl}/blob/main/packages/http-api/release-manifest.json)
- Package: \`${packageName}@${packageVersion}\`
- Freshness gate: \`bun run --cwd packages/http-api generate:check\`
- Renderer: Vocs 2.8.5 native OpenAPI integration

The Vocs pages below come directly from the OpenAPI document.
Edit the Effect HttpApi contract and regenerate the document to change an operation.

<OpenApi.Endpoints path="/reference/native-api" />
`;

const main = async (): Promise<void> => {
  const [document, packageJson, manifest, serverMetadata] = await Promise.all([
    readJson(openApiPath).then((value) => OpenApiDocumentSchema.parse(value)),
    readJson(httpApiPackagePath).then((value) => PackageSchema.parse(value)),
    readJson(releaseManifestPath).then((value) => ReleaseManifestSchema.parse(value)),
    readJson(serverMetadataPath).then((value) => ServerMetadataSchema.parse(value)),
  ]);
  if (
    document.info.version !== manifest.release.version ||
    packageJson.version !== manifest.release.version ||
    serverMetadata.release.version !== manifest.release.version
  ) {
    throw new Error("OpenAPI, package, server metadata, and release-manifest versions differ.");
  }
  if (
    manifest.artifacts.openapi.path !== "packages/http-api/openapi.json" ||
    manifest.artifacts.sdkOperations.path !== "packages/sdk/native-api-operations.json" ||
    manifest.artifacts.serverMetadata.path !==
      "apps/backend/src/generated/native-api-metadata.json"
  ) {
    throw new Error("The release manifest contains an unexpected artifact path.");
  }

  const operations = collectOperations(document.paths);
  makeSureOperationsMatchRelease(operations, manifest, serverMetadata);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    page(
      packageJson.name,
      packageJson.version,
      manifest.counts.externalOperations,
      manifest.counts.internalOperations,
    ),
  );

  const output = relative(generatedRoot, outputPath).split(sep).join("/");
  process.stdout.write(`generated ${output} from ${operations.length} operations\n`);
};

await main();
