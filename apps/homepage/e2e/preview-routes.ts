import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Record as Rec, Schema } from "effect";

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

const RouteExpectationSchema = Schema.Struct({
  status: Schema.Number,
  basicState: BasicStateSchema,
  redirectTo: Schema.optionalKey(Schema.String),
});

type RouteExpectation = typeof RouteExpectationSchema.Type;

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

type PreviewRoute = typeof PreviewRouteSchema.Type;

function repo(path: string): string {
  return relative(ROOT, path).split("\\").join("/");
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

/** Derives the preview smoke routes from the current homepage and dashboard route files. */
export function previewRoutes(): PreviewRoute[] {
  return [
    ...build("homepage", routeFiles(join(ROOT, "apps/homepage/src/routes"))),
    ...build("dashboard", routeFiles(join(ROOT, "apps/dashboard/app/routes"))),
  ];
}
