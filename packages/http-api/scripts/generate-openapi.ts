import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Context } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { ExternalNativeApi, InternalNativeApi } from "../src/api.js";

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

const rawSpec = OpenApi.fromApi(ExternalNativeApi);
const spec: OpenApi.OpenAPISpec = {
  ...rawSpec,
  paths: Object.fromEntries(
    Object.entries(rawSpec.paths).map(([path, item]) => [
      path.replace(/:\{(\w+)\}/gu, ":$1"),
      item,
    ]),
  ),
};
type WithProvenance = {
  readonly "x-vektorprogrammet-provenance"?: unknown;
  readonly "x-tagGroups"?: unknown;
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
assert(operations.length === 52, `expected 52 public operations, found ${operations.length}`);
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
  Object.values(ExternalNativeApi.groups)
    .filter((group) => Context.get(group.annotations, OpenApi.Exclude) !== true)
    .flatMap((group) =>
      Object.values(group.endpoints).map(
        (endpoint) => `${group.identifier}.${endpoint.identifier}`,
      ),
    ),
);
assert(
  expectedPublicOperationIds.size === 52 &&
    operationIds.length === expectedPublicOperationIds.size &&
    operationIds.every((identifier) => expectedPublicOperationIds.has(identifier)),
  "every public operation id must be its stable fully-qualified group.endpoint identifier",
);
const internalOperationIds = Object.values(InternalNativeApi.groups.internal.endpoints).map(
  (endpoint) => `internal.${endpoint.identifier}`,
);
assert(
  internalOperationIds.every((identifier) => !operationIds.includes(identifier)),
  "internal operation ids must remain excluded from public OpenAPI",
);
assert(new Set(operationIds).size === operationIds.length, "operation ids must be unique");

const paths = spec.paths;
assert(paths["/api/departments"]?.get?.responses?.["200"] !== undefined, "public response schema");
const healthOperation = paths["/health"]?.get as
  | (Record<string, unknown> & { readonly security?: ReadonlyArray<unknown> })
  | undefined;
const healthAccess = healthOperation?.["x-vektor-access"];
assert(healthAccess !== undefined, "health AccessSpec projection");
assert(
  Array.isArray(healthOperation?.security) && healthOperation.security.length === 0,
  "credential-free health security projection",
);
assert(
  !/credentialValue|rawHeader|secret|tokenValue/iu.test(JSON.stringify(healthAccess)),
  "access projection must contain no credential material",
);
for (const [path, method] of [
  ["/api/session", "get"],
  ["/api/session", "delete"],
  ["/api/sessions", "get"],
  ["/api/sessions/{sessionId}", "delete"],
  ["/api/sessions:revoke-others", "post"],
  ["/api/sessions:revoke-all", "post"],
] as const) {
  const operation = paths[path]?.[method];
  assert(
    operation?.security?.[0]?.cookieHeader !== undefined,
    `${method} ${path} session security`,
  );
  assert(operation?.responses?.["401"] !== undefined, `${method} ${path} session 401 schema`);
}
assert(paths["/api/me/session"] === undefined, "obsolete session route must be absent");
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
const sessionScheme = spec.components?.securitySchemes?.cookieHeader;
assert(
  sessionScheme?.type === "apiKey" &&
    sessionScheme.in === "header" &&
    sessionScheme.name === "Cookie",
  "authoritatively resolved Cookie header security scheme",
);
const invitationScheme = spec.components?.securitySchemes?.invitationCapability;
assert(
  invitationScheme?.type === "apiKey" &&
    invitationScheme.name === "X-Recruitment-Invitation-Capability",
  "invitation capability security scheme",
);

// --- 0080 invariants: native API reference is the primary product ---

// Sidebar is resource-grouped: every tag belongs to exactly one x-tagGroups section.
const tagGroups = documentedSpec["x-tagGroups"];
type TagGroup = { readonly name?: unknown; readonly tags?: unknown };
assert(Array.isArray(tagGroups) && tagGroups.length === 6, "expected 6 x-tagGroups sections");
const groupedTags = new Set<string>();
for (const group of tagGroups as ReadonlyArray<TagGroup>) {
  assert(typeof group.name === "string" && group.name.length > 0, "tag group needs a name");
  assert(Array.isArray(group.tags) && group.tags.length > 0, "tag group needs tags");
  for (const tag of group.tags as ReadonlyArray<unknown>) {
    assert(typeof tag === "string", "grouped tag must be a string");
    assert(!groupedTags.has(tag), `tag "${tag}" is grouped more than once`);
    groupedTags.add(tag);
  }
}
const documentTags = (spec.tags ?? []).map((tag) => tag.name);
assert(documentTags.length > 0, "document must declare tags");
assert(
  documentTags.every((tag) => groupedTags.has(tag)) && documentTags.length === groupedTags.size,
  "every document tag must belong to exactly one x-tagGroups section",
);

// Every error response envelope carries a truthful example (TMDB-style docs).
const schemas = spec.components?.schemas ?? {};
for (const [name, schema] of Object.entries(schemas)) {
  const response = schema as { readonly examples?: unknown; readonly properties?: unknown };
  const isErrorEnvelope =
    name.endsWith("Response") &&
    typeof response.properties === "object" &&
    response.properties !== null &&
    "error" in response.properties &&
    !name.startsWith("internal.");
  if (!isErrorEnvelope) continue;
  assert(
    Array.isArray(response.examples) && response.examples.length > 0,
    `error envelope "${name}" must carry a truthful example`,
  );
}
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
