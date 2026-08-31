import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Context } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { NativeApi } from "../src/api.js";

const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

const stable = (value: unknown): Json => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object") throw new Error(`OpenAPI contains unsupported ${typeof value}`);
  const source = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, stable(source[key])]),
  ) as Json;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`OpenAPI invariant failed: ${message}`);
}

const spec = OpenApi.fromApi(NativeApi);
type WithProvenance = {
  readonly "x-vektorprogrammet-provenance"?: unknown;
};
const documentedSpec = spec as OpenApi.OpenAPISpec & WithProvenance;
assert(spec.openapi === "3.1.0", "document must use OpenAPI 3.1.0");
assert(spec.info?.title === "Vektorprogrammet native preview API", "preview title must be exact");
assert(
  spec.servers === undefined || spec.servers.length === 0,
  "production server URLs are forbidden",
);

const operations: Array<OpenApi.OpenAPISpecOperation & WithProvenance> = [];
for (const [path, item] of Object.entries(spec.paths)) {
  assert(!path.startsWith("/api/auth"), "Better Auth must remain external");
  assert(!path.startsWith("/api/e2e"), "internal evidence must be excluded");
  for (const method of methods) {
    if (item[method] !== undefined) operations.push(item[method]);
  }
}
assert(operations.length === 47, `expected 47 public operations, found ${operations.length}`);
assert(
  documentedSpec["x-vektorprogrammet-provenance"] !== undefined,
  "document provenance must be present",
);
assert(
  operations.every(
    (operation) =>
      operation.tags.length > 0 && operation["x-vektorprogrammet-provenance"] !== undefined,
  ),
  "every operation needs stable tags and provenance",
);
const operationIds = operations.map((operation) => operation.operationId);
assert(
  operationIds.every((identifier): identifier is string => typeof identifier === "string"),
  "every operation needs an id",
);
const expectedPublicOperationIds = new Set(
  Object.values(NativeApi.groups)
    .filter((group) => Context.get(group.annotations, OpenApi.Exclude) !== true)
    .flatMap((group) =>
      Object.values(group.endpoints).map(
        (endpoint) => `${group.identifier}.${endpoint.identifier}`,
      ),
    ),
);
assert(
  expectedPublicOperationIds.size === 47 &&
    operationIds.length === expectedPublicOperationIds.size &&
    operationIds.every((identifier) => expectedPublicOperationIds.has(identifier)),
  "every public operation id must be its stable fully-qualified group.endpoint identifier",
);
const internalOperationIds = Object.values(NativeApi.groups.internal.endpoints).map(
  (endpoint) => `internal.${endpoint.identifier}`,
);
assert(
  internalOperationIds.every((identifier) => !operationIds.includes(identifier)),
  "internal operation ids must remain excluded from public OpenAPI",
);
assert(new Set(operationIds).size === operationIds.length, "operation ids must be unique");

const paths = spec.paths;
assert(paths["/api/departments"]?.get?.responses?.["200"] !== undefined, "public response schema");
assert(
  paths["/api/me/session"]?.get?.security?.[0]?.sessionCookie !== undefined,
  "session security",
);
assert(paths["/api/me/session"]?.get?.responses?.["401"] !== undefined, "session 401 schema");
assert(paths["/api/admin/departments"]?.post?.responses?.["201"] !== undefined, "admin create 201");
assert(
  paths["/api/receipts/submit"]?.post?.requestBody?.content?.["multipart/form-data"] !== undefined,
  "receipt multipart request",
);
assert(
  paths["/api/receipts/submit"]?.post?.responses?.["422"] !== undefined,
  "receipt decode error",
);
assert(
  paths["/api/admin/recruitment/interviews/{interviewId}/finalize"]?.post?.responses?.["409"] !==
    undefined,
  "recruitment conflict error",
);
assert(paths["/api/news/{slug}"]?.get?.responses?.["200"] !== undefined, "public news schema");
const sessionScheme = spec.components?.securitySchemes?.sessionCookie;
assert(sessionScheme?.type === "apiKey" && sessionScheme.in === "cookie", "cookie security scheme");
const invitationScheme = spec.components?.securitySchemes?.invitationCapability;
assert(
  invitationScheme?.type === "apiKey" &&
    invitationScheme.name === "X-Recruitment-Invitation-Capability",
  "invitation capability security scheme",
);

const bytes = `${JSON.stringify(stable(spec), null, 2)}\n`;
const outputPath = fileURLToPath(new URL("../openapi.json", import.meta.url));
const mode = process.argv.slice(2);
assert(mode.length <= 1 && (mode.length === 0 || mode[0] === "--check"), "expected only --check");

if (mode[0] === "--check") {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  assert(current === bytes, "packages/http-api/openapi.json is stale; run bun run generate");
  process.stdout.write("OpenAPI artifact is current\n");
} else {
  await writeFile(outputPath, bytes, "utf8");
  process.stdout.write("Generated packages/http-api/openapi.json\n");
}
