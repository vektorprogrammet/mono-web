import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Record as Rec, Array as Arr, Predicate, Schema } from "effect";

export const PREVIEW_APP = "vektor" as const;

export const PREVIEW_STAGE = "p20" as const;

export const PREVIEW_TARGET = "p20" as const;

export const PREVIEW_RESOURCE_PREFIX = "vektor-p20" as const;

export const PREVIEW_CONTAINER = "vektor-p20-container" as const;

export const PREVIEW_HOST = "p20.vektor.phibkro.org" as const;

export const PREVIEW_BASE_URL = `https://${PREVIEW_HOST}` as const;

export const FORBIDDEN_HOST = ["vektorprogrammet", "no"].join(".");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type App = "homepage" | "dashboard";

const BasicStateSchema = Schema.Literals([
  "empty",
  "populated",
  "loading-safe",
  "validation-safe",
  "authorization-denied",
  "not-found",
]);

export type BasicState = typeof BasicStateSchema.Type;

const RouteExpectationSchema = Schema.Struct({
  status: Schema.Number,
  basicState: BasicStateSchema,
  redirectTo: Schema.optionalKey(Schema.String),
});

export type RouteExpectation = typeof RouteExpectationSchema.Type;

const PreviewRouteSchema = Schema.Struct({
  id: Schema.String,
  app: Schema.Literals(["homepage", "dashboard"]),
  path: Schema.String,
  sourcePath: Schema.String,
  sourcePattern: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["page", "dynamic-fixture", "redirect"]),
  expected: RouteExpectationSchema,
  visual: Schema.Struct({ desktop: Schema.Boolean, mobile: Schema.Boolean }),
});

export type PreviewRoute = typeof PreviewRouteSchema.Type;

const SourceFileSchema = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
});

export type SourceFile = typeof SourceFileSchema.Type;

const SourceManifestSchema = Schema.Struct({
  files: Schema.Array(SourceFileSchema),
  digest: Schema.String,
});

export type SourceManifest = typeof SourceManifestSchema.Type;

const RouteContractSchema = Schema.Struct({
  schemaVersion: Schema.Literal("preview-route-contract/v1"),
  generatorVersion: Schema.Literal("2026-08-12"),
  target: Schema.Struct({
    app: Schema.Literal(PREVIEW_APP),
    stage: Schema.Literal(PREVIEW_STAGE),
    target: Schema.Literal(PREVIEW_TARGET),
    host: Schema.Literal(PREVIEW_HOST),
    resourcePrefix: Schema.Literal(PREVIEW_RESOURCE_PREFIX),
    container: Schema.Literal(PREVIEW_CONTAINER),
  }),
  sourceManifestDigest: Schema.String,
  sourceManifests: Schema.Struct({
    homepage: SourceManifestSchema,
    dashboard: SourceManifestSchema,
  }),
  routes: Schema.Array(PreviewRouteSchema),
  visualEvidence: Schema.Struct({
    desktop: Schema.Struct({ width: Schema.Literal(1440), height: Schema.Literal(900) }),
    mobile: Schema.Struct({ width: Schema.Literal(390), height: Schema.Literal(844) }),
  }),
  namedStates: Schema.Array(BasicStateSchema),
  contractDigest: Schema.String,
});

export type RouteContract = typeof RouteContractSchema.Type;

function canonical(value: Schema.Json): string {
  if (value === null || Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) return JSON.stringify(value);

  if (Arr.isArray<Schema.Json>(value)) return `[${value.map(canonical).join(",")}]`;

  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function hash(v: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(v).digest("hex")}`;
}

function repo(path: string): string {
  return relative(ROOT, path).split("\\").join("/");
}

function source(paths: readonly string[]): SourceManifest {
  const files = paths
    .map((path) => {
      const bytes = readFileSync(resolve(ROOT, path));

      return { path, bytes: bytes.byteLength, sha256: hash(bytes) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return { files, digest: hash(canonical(files)) };
}

function routeFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
    .map((e) => join(path, e.name))
    .sort();
}

function id(app: App, path: string): string {
  return `${app}-${path === "/" ? "root" : path.slice(1).replaceAll("/", "-")}`;
}

function expectation(app: App, path: string): RouteExpectation {
  return app === "homepage"
    ? { status: 200, basicState: "populated" }
    : path === "/login" || path === "/glemt-passord" || path.startsWith("/tilbakestill-passord/")
      ? { status: 200, basicState: "validation-safe" }
      : { status: 302, basicState: "authorization-denied", redirectTo: "/login" };
}

const dynamic = {
  "/kontakt/:department": ["aas", "bergen", "hovedstyret", "trondheim"],
  "/team/:department": ["aas", "bergen", "trondheim"],
};

const isDynamicPattern = Schema.is(Schema.Literals(Rec.keys(dynamic)));

type GeneratedPreviewRoute = { -readonly [Key in keyof PreviewRoute]: PreviewRoute[Key] };

function path(app: App, stem: string): string | null {
  if (app === "homepage") {
    if (stem === "_home" || stem === "_home._index") return stem.endsWith("_index") ? "/" : null;

    if (!stem.startsWith("_home.")) return null;
    const parts = stem.slice(6).split(".");
    const isIndex = parts.at(-1) === "_index";

    if (isIndex) parts.pop();

    if (!isIndex && parts.length === 1 && (parts[0] === "kontakt" || parts[0] === "team"))
      return null;

    return `/${parts.map((p) => (p.startsWith("$") ? `:${p.slice(1)}` : p)).join("/")}`;
  }

  if (stem === "_index") return "/";

  if (stem === "dashboard") return null;

  if (stem === "dashboard._index") return "/dashboard";

  if (stem === "login") return "/login";

  if (stem === "glemt-passord") return "/glemt-passord";

  if (stem === "logout") return "/logout";

  if (stem === "tilbakestill-passord.$code") return "/tilbakestill-passord/:code";

  if (!stem.startsWith("dashboard.")) return null;
  const parts = stem.slice(10).split(".");

  if (parts.at(-1) === "_index") parts.pop();

  return `/dashboard/${parts.map((p) => (p.startsWith("$") ? `:${p.slice(1)}` : p)).join("/")}`;
}

function build(app: App, files: readonly string[]): PreviewRoute[] {
  const out: PreviewRoute[] = [];

  for (const file of files) {
    const sourcePath = repo(file);
    const stem = file.slice(file.lastIndexOf("/") + 1).replace(/\.tsx$/u, "");
    const pattern = path(app, stem);

    if (!pattern) continue;

    const values = pattern.includes(":")
      ? app === "homepage"
        ? isDynamicPattern(pattern)
          ? dynamic[pattern]
          : []
        : ["preview-reset-code"]
      : [pattern];

    for (const value of values) {
      const route = pattern.includes(":") ? pattern.replace(/:[^/]+/u, value) : value;
      const expected = expectation(app, route);

      const generated: GeneratedPreviewRoute = {
        id: id(app, route),
        app,
        path: route,
        sourcePath,
        kind: pattern.includes(":")
          ? "dynamic-fixture"
          : expected.status === 302
            ? "redirect"
            : "page",
        expected,
        visual: { desktop: true, mobile: true },
      };

      if (pattern.includes(":")) generated.sourcePattern = pattern;
      out.push(generated);
    }
  }

  return out.sort((a, b) => a.app.localeCompare(b.app) || a.path.localeCompare(b.path));
}

const HOME_INPUTS = [
  "apps/homepage/src/routes.ts",
  "apps/homepage/src/nav-routes.ts",
  "apps/homepage/src/lib/dev-content.ts",
] as const;

const DASH_INPUTS = [
  "apps/dashboard/app/routes.ts",
  "apps/dashboard/app/lib/auth.server.ts",
] as const;

function digestBody(body: Omit<RouteContract, "contractDigest">): string {
  return hash(canonical(body));
}

/** Derives the preview route contract from the current route sources; no copy is committed. */
export function generateRouteContract(): RouteContract {
  const homeFiles = routeFiles(join(ROOT, "apps/homepage/src/routes"));
  const dashFiles = routeFiles(join(ROOT, "apps/dashboard/app/routes"));
  const homeSource = source([...HOME_INPUTS, ...homeFiles.map(repo)]);
  const dashSource = source([...DASH_INPUTS, ...dashFiles.map(repo)]);

  const body: Omit<RouteContract, "contractDigest"> = {
    schemaVersion: "preview-route-contract/v1",
    generatorVersion: "2026-08-12",
    target: {
      app: PREVIEW_APP,
      stage: PREVIEW_STAGE,
      target: PREVIEW_TARGET,
      host: PREVIEW_HOST,
      resourcePrefix: PREVIEW_RESOURCE_PREFIX,
      container: PREVIEW_CONTAINER,
    },
    sourceManifestDigest: hash(canonical({ homepage: homeSource, dashboard: dashSource })),
    sourceManifests: { homepage: homeSource, dashboard: dashSource },
    routes: [...build("homepage", homeFiles), ...build("dashboard", dashFiles)],
    visualEvidence: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } },
    namedStates: [
      "empty",
      "populated",
      "loading-safe",
      "validation-safe",
      "authorization-denied",
      "not-found",
    ],
  };

  return { ...body, contractDigest: digestBody(body) };
}

export function assertPreviewBaseUrl(value: string): URL {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hostname.toLowerCase() === FORBIDDEN_HOST
  )
    throw new Error("Unsafe preview base URL");
  url.hash = "";
  url.search = "";

  return url;
}
