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
const httpApiPackagePath = join(repositoryRoot, "packages/http-api/package.json");
const outputPath = join(generatedRoot, "src/pages/reference/native-api/index.mdx");
const repositoryUrl = "https://github.com/vektorprogrammet/mono-web";
const publicOperationCount = 47;
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
    if (path.startsWith("/api/auth/") || path.startsWith("/api/e2e/")) {
      throw new Error(`Public OpenAPI contains an excluded path: ${path}`);
    }

    for (const [method, candidate] of Object.entries(pathItem)) {
      if (httpMethods[method] !== true) continue;
      const operation = z.object({ operationId: z.string().min(1) }).parse(candidate);
      operations.push({ method, operationId: operation.operationId, path });
    }
  }

  return operations;
};

const makeSureOperationsArePublic = (operations: ReadonlyArray<Operation>): void => {
  if (operations.length !== publicOperationCount) {
    throw new Error(
      `Expected ${publicOperationCount} public OpenAPI operations, found ${operations.length}.`,
    );
  }

  const identifiers = new Set<string>();
  for (const operation of operations) {
    if (identifiers.has(operation.operationId)) {
      throw new Error(`Duplicate OpenAPI operationId: ${operation.operationId}`);
    }
    identifiers.add(operation.operationId);
  }
};

const page = (packageName: string, packageVersion: string): string => `---
title: Native API reference
description: Generated reference for the 47 public operations in the native Vektorprogrammet HTTP API.
showAskAi: false
---

import { OpenApi } from "vocs";

# Native API reference

This reference contains **47 public native operations** from the canonical OpenAPI document.
Better Auth routes and the internal receipt evidence route are not part of this document.
This operation total is documentation scope, not a legacy parity claim.

Start with [Authentication & authorization](/reference/native-api/authentication) and the [Getting started](/reference/native-api/getting-started) walkthrough, or read [Routes & API](/reference/routes-and-api) for route families, capability owners, and transport boundaries.

## Provenance

- Source: [\`packages/http-api/openapi.json\`](${repositoryUrl}/blob/main/packages/http-api/openapi.json)
- Package: \`${packageName}@${packageVersion}\`
- Freshness gate: \`bun run --cwd packages/http-api generate:check\`
- Renderer: Vocs 2.8.5 native OpenAPI integration

The Vocs pages below come directly from the OpenAPI document.
Edit the Effect HttpApi contract and regenerate the document to change an operation.

<OpenApi.Endpoints path="/reference/native-api" />
`;

const main = async (): Promise<void> => {
  const document = OpenApiDocumentSchema.parse(await readJson(openApiPath));
  const packageJson = PackageSchema.parse(await readJson(httpApiPackagePath));
  const operations = collectOperations(document.paths);
  makeSureOperationsArePublic(operations);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, page(packageJson.name, packageJson.version));

  const output = relative(generatedRoot, outputPath).split(sep).join("/");
  process.stdout.write(`generated ${output} from ${operations.length} operations\n`);
};

await main();
