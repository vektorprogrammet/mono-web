import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  DEV_CONTENT,
  DEV_CONTENT_SOURCE,
  DEV_ROUTE_CENSUS,
  type DevContent,
  type DevRouteCensus,
} from "./src/lib/dev-content.ts";

export type AssetManifestEntry = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
};

export type RouteSourceManifestEntry = {
  readonly source: string;
  readonly byteLength: number;
  readonly sha256: string;
};

export type RouteContentProjection = {
  readonly path: string;
  readonly projection: unknown;
  readonly assetPaths: readonly string[];
  readonly assets: readonly AssetManifestEntry[];
};

export type HomepageDigestInputs = {
  readonly assetManifest: readonly AssetManifestEntry[];
  readonly routeSourceManifest: readonly RouteSourceManifestEntry[];
  readonly routeContentProjectionManifest: readonly RouteContentProjection[];
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStrings(left, right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Digest input contains unsupported undefined value");
  return serialized;
}

export function digestCanonicalJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${canonicalJson(value)}\n`, "utf8")
    .digest("hex")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      if (entry.isFile()) return [path];
      throw new Error(`Unsupported file entry: ${path}`);
    })
    .sort(compareStrings);
}
export const ROUTE_SOURCE_ROOTS = ["src/api", "src/routes"] as const;

function sourceManifestEntry(
  projectRoot: string,
  absolutePath: string,
): RouteSourceManifestEntry {
  const bytes = readFileSync(absolutePath);
  return {
    source: projectRelativePath(projectRoot, absolutePath),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export function buildRouteSourceManifest(projectRoot: string): readonly RouteSourceManifestEntry[] {
  return ROUTE_SOURCE_ROOTS.flatMap((sourceRoot) =>
    listFiles(resolve(projectRoot, sourceRoot)).map((absolutePath) =>
      sourceManifestEntry(projectRoot, absolutePath),
    ),
  ).sort((left, right) => compareStrings(left.source, right.source));
}


function projectRelativePath(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).split(sep).join("/");
}

export function buildApprovedAssetManifest(projectRoot: string): readonly AssetManifestEntry[] {
  const assetRoot = resolve(projectRoot, "public/images");
  return listFiles(assetRoot).map((absolutePath) => {
    const bytes = readFileSync(absolutePath);
    return {
      path: projectRelativePath(projectRoot, absolutePath),
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    };
  });
}


function collectAssetPaths(value: unknown): readonly string[] {
  const paths = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (candidate.startsWith("/images/")) paths.add(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const item of Object.values(candidate)) visit(item);
    }
  };
  visit(value);
  return Array.from(paths).sort(compareStrings);
}

function assetUrlForManifestPath(path: string): string {
  return `/${path.replace(/^public\//, "")}`;
}

function routeProjection(path: string, content: DevContent, census: DevRouteCensus): unknown {
  if (path === "/") {
    return {
      source: DEV_CONTENT_SOURCE,
      sponsors: content.sponsors,
      statistics: content.statistics,
      teams: content.teams,
      departments: content.departments,
      people: census.people,
    };
  }
  if (path === "/team") {
    return { teams: content.teams, departments: content.departments, people: census.people };
  }
  if (path === "/team/:department") {
    return { teams: content.teams, people: census.people };
  }
  if (path.startsWith("/team/")) {
    const team = content.teams.find((item) => item.url === path);
    if (!team) throw new Error(`Missing DEV CONTENT team for route ${path}`);
    return {
      team,
      people: census.people.filter((person) => person.teamId === team.id),
    };
  }
  if (path === "/kontakt" || path === "/kontakt/:department") {
    return { departments: content.departments };
  }
  if (path.startsWith("/kontakt/")) {
    const department = content.departments.find(
      (item) => `/kontakt/${item.id}` === path,
    );
    if (!department) throw new Error(`Missing DEV CONTENT department for route ${path}`);
    return { department };
  }
  if (path === "/nyheter") return { source: "native-backend:/api/news" };
  if (path.startsWith("/nyhet/")) return { source: "native-backend:/api/news" };
  if (path === "/om-oss") return { sponsors: content.sponsors, statistics: content.statistics };
  if (path === "/assistenter") return { statistics: content.statistics };
  return { source: DEV_CONTENT_SOURCE };
}

export function buildRouteContentProjectionManifest(
  content: DevContent = DEV_CONTENT,
  census: DevRouteCensus = DEV_ROUTE_CENSUS,
  assetManifest: readonly AssetManifestEntry[] = [],
): readonly RouteContentProjection[] {
  return census.paths.map((path) => {
    const projection = routeProjection(path, content, census);
    const assetPaths = collectAssetPaths(projection);
    const assets = assetManifest.filter((entry) =>
      assetPaths.includes(assetUrlForManifestPath(entry.path)),
    );
    return { path, projection, assetPaths, assets };
  });
}

export function buildHomepageDigestInputs(projectRoot: string): HomepageDigestInputs {
  const assetManifest = buildApprovedAssetManifest(projectRoot);
  return {
    assetManifest,
    routeSourceManifest: buildRouteSourceManifest(projectRoot),
    routeContentProjectionManifest: buildRouteContentProjectionManifest(
      DEV_CONTENT,
      DEV_ROUTE_CENSUS,
      assetManifest,
    ),
  };
}

export function computeContentDigest(
  content: DevContent,
  assetManifest: readonly AssetManifestEntry[],
): string {
  return digestCanonicalJson({ DEV_CONTENT: content, assetManifest });
}

export function computeRouteDigest(
  census: DevRouteCensus,
  inputs: Pick<HomepageDigestInputs, "assetManifest" | "routeSourceManifest" | "routeContentProjectionManifest">,
): string {
  return digestCanonicalJson({
    DEV_ROUTE_CENSUS: census,
    assetManifest: inputs.assetManifest,
    routeContentProjectionManifest: inputs.routeContentProjectionManifest,
    routeSourceManifest: inputs.routeSourceManifest,
  });
}

export function computeHomepageDigests(projectRoot: string): {
  readonly contentDigest: string;
  readonly routeDigest: string;
  readonly inputs: HomepageDigestInputs;
} {
  const inputs = buildHomepageDigestInputs(projectRoot);
  return {
    contentDigest: computeContentDigest(DEV_CONTENT, inputs.assetManifest),
    routeDigest: computeRouteDigest(DEV_ROUTE_CENSUS, inputs),
    inputs,
  };
}
