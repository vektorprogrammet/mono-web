import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { HOMEPAGE_PLAYWRIGHT_INPUTS } from "../../playwright.config";
import { DEV_CONTENT_SOURCE } from "../../src/lib/dev-content";
import { countServiceWorkerRegistrations } from "../../browser/service-worker-state";

export const LOCAL_HOST = HOMEPAGE_PLAYWRIGHT_INPUTS.host;
export const LOOPBACK_ORIGIN = HOMEPAGE_PLAYWRIGHT_INPUTS.origin;
export const BASE_URL = LOOPBACK_ORIGIN;
export const VIEWPORT = HOMEPAGE_PLAYWRIGHT_INPUTS.viewport;
export const EVIDENCE_DIR =
  process.env.HOMEPAGE_EVIDENCE_DIR ?? join(tmpdir(), "monoweb-homepage-dev-0011", "evidence");
export const SCREENSHOT_DIR = process.env.HOMEPAGE_SCREENSHOT_DIR ?? EVIDENCE_DIR;

const ALLOWED_ORIGINS: Record<string, true> = {
  [LOOPBACK_ORIGIN]: true,
};

const EVIDENCE_HEADERS = [
  "allow",
  "location",
  "cache-control",
  "content-type",
  "x-mono-web-host",
  "x-mono-web-stage",
  "x-robots-tag",
] as const;

type EvidenceHeaders = Record<string, string>;

export type HomepageBuildLiterals = {
  readonly commit: string;
  readonly dataSource: typeof DEV_CONTENT_SOURCE;
  readonly contentDigest: `sha256:${string}`;
  readonly routeDigest: `sha256:${string}`;
};

type EvidenceCheck = {
  checked: boolean;
  passed: boolean;
};

type ServiceWorkerCheck = {
  checked: boolean;
  absent: boolean;
};

type LedgerEntry = {
  readonly method: string;
  readonly resourceType: string;
  readonly path: string;
  readonly status: number;
  readonly redirect: boolean;
  readonly headers: EvidenceHeaders;
};

type ManualProbe = LedgerEntry;

export type HomepageDiagnostics = {
  readonly fixtureInputs: typeof HOMEPAGE_PLAYWRIGHT_INPUTS;
  readonly forbiddenRequests: string[];
  readonly failedResponses: string[];
  readonly responses: LedgerEntry[];
  readonly probes: ManualProbe[];
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
  readonly hydration: EvidenceCheck;
  readonly clientNavigation: EvidenceCheck;
  readonly serviceWorkers: ServiceWorkerCheck;
  buildLiterals: HomepageBuildLiterals | null;
};
export const test = base.extend<{ diagnostics: HomepageDiagnostics }>({
  diagnostics: async ({ page }, use) => {
    const diagnostics: HomepageDiagnostics = {
      fixtureInputs: HOMEPAGE_PLAYWRIGHT_INPUTS,
      forbiddenRequests: [],
      failedResponses: [],
      responses: [],
      probes: [],
      pageErrors: [],
      consoleErrors: [],
      hydration: { checked: false, passed: false },
      clientNavigation: { checked: false, passed: false },
      serviceWorkers: { checked: false, absent: false },
      buildLiterals: null,
    };
    await installNetworkGuard(page, diagnostics);
    try {
      await use(diagnostics);
    } finally {
      exportSanitizedEvidence(diagnostics);
    }
  },
});

export { expect };
function redactedPath(rawUrl: string): string {
  const url = new URL(rawUrl, LOOPBACK_ORIGIN);
  if (url.origin === LOOPBACK_ORIGIN) return url.pathname || "/";
  if (url.protocol === "data:") return "data:";
  if (url.protocol === "blob:") return "blob:";
  return "external-origin";
}

function allowlistedHeaders(headers: Record<string, string>): EvidenceHeaders {
  const selected: EvidenceHeaders = {};
  for (const name of EVIDENCE_HEADERS) {
    const match = Object.entries(headers).find(([headerName]) => headerName.toLowerCase() === name);
    if (match !== undefined) selected[name] = match[1];
  }
  return selected;
}

function responseEntry(
  method: string,
  resourceType: string,
  path: string,
  status: number,
  redirect: boolean,
  headers: Record<string, string>,
): LedgerEntry {
  return {
    method: method.toUpperCase(),
    resourceType,
    path: redactedPath(path),
    status,
    redirect,
    headers: allowlistedHeaders(headers),
  };
}
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function recordBuildLiterals(
  diagnostics: HomepageDiagnostics,
  value: unknown,
): HomepageBuildLiterals {
  if (value === null || typeof value !== "object") {
    throw new Error("Health response has no build provenance");
  }
  const candidate = value as Record<string, unknown>;
  const commit = candidate.commit;
  const dataSource = candidate.dataSource;
  const contentDigest = candidate.contentDigest;
  const routeDigest = candidate.routeDigest;
  if (
    typeof commit !== "string" ||
    !COMMIT_PATTERN.test(commit) ||
    dataSource !== DEV_CONTENT_SOURCE ||
    typeof contentDigest !== "string" ||
    !DIGEST_PATTERN.test(contentDigest) ||
    typeof routeDigest !== "string" ||
    !DIGEST_PATTERN.test(routeDigest)
  ) {
    throw new Error("Health response has invalid build provenance");
  }
  const buildLiterals: HomepageBuildLiterals = {
    commit,
    dataSource: DEV_CONTENT_SOURCE,
    contentDigest: contentDigest as `sha256:${string}`,
    routeDigest: routeDigest as `sha256:${string}`,
  };
  diagnostics.buildLiterals = buildLiterals;
  return buildLiterals;
}

export function recordClientNavigation(diagnostics: HomepageDiagnostics, passed: boolean): void {
  diagnostics.clientNavigation.checked = true;
  diagnostics.clientNavigation.passed = passed;
}

export async function installNetworkGuard(
  page: Page,
  diagnostics: HomepageDiagnostics,
): Promise<void> {
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    const request = response.request();
    const entry = responseEntry(
      request.method(),
      request.resourceType(),
      response.url(),
      response.status(),
      request.redirectedFrom() !== null,
      response.headers(),
    );
    diagnostics.responses.push(entry);
    if (
      ALLOWED_ORIGINS[new URL(response.url()).origin] === true &&
      (response.status() < 200 || response.status() >= 400)
    ) {
      diagnostics.failedResponses.push(`${response.status()} ${entry.path}`);
    }
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const allowed =
      url.protocol === "data:" || url.protocol === "blob:" || ALLOWED_ORIGINS[url.origin] === true;
    if (!allowed) {
      diagnostics.forbiddenRequests.push(redactedPath(route.request().url()));
      await route.abort("blockedbyclient");
      return;
    }
    if (url.origin === LOOPBACK_ORIGIN) {
      const response = await route.fetch({
        headers: { ...route.request().headers(), host: LOCAL_HOST },
      });
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });
}

export async function recordProbe(
  diagnostics: HomepageDiagnostics,
  method: string,
  path: string,
  response: { status(): number; headers(): Record<string, string> },
  resourceType = "fetch",
): Promise<void> {
  diagnostics.probes.push(
    responseEntry(method, resourceType, path, response.status(), false, response.headers()),
  );
}

export async function assertHealthyPage(
  page: Page,
  diagnostics: HomepageDiagnostics,
): Promise<void> {
  await page.waitForLoadState("networkidle");
  diagnostics.hydration.checked = true;
  try {
    await page.waitForFunction("window.__MONO_WEB_HYDRATED__ === true");
    diagnostics.hydration.passed = true;
  } catch (error) {
    diagnostics.hydration.passed = false;
    throw error;
  }
  const allEntries = [...diagnostics.responses, ...diagnostics.probes];
  const currentPath = new URL(page.url()).pathname;
  expect(diagnostics.responses.length).toBeGreaterThan(0);
  expect(allEntries.length).toBeGreaterThan(0);
  expect(
    allEntries.some(
      ({ resourceType, path }) => resourceType === "document" && path === currentPath,
    ),
  ).toBe(true);
  expect(diagnostics.responses.every(({ status }) => status >= 200 && status < 400)).toBe(true);
  expect(diagnostics.forbiddenRequests).toEqual([]);
  expect(diagnostics.failedResponses).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  const serviceWorkerRegistrations = await page.evaluate(countServiceWorkerRegistrations);
  diagnostics.serviceWorkers.checked = true;
  diagnostics.serviceWorkers.absent = serviceWorkerRegistrations === 0;
  expect(diagnostics.serviceWorkers.absent).toBe(true);
}

export async function assertProvenance(
  response: { headers(): Record<string, string> } | null,
  path: string,
): Promise<void> {
  expect(response, `response for ${path}`).not.toBeNull();
  const headers = response?.headers() ?? {};
  expect(headers["x-mono-web-stage"]).toBe(HOMEPAGE_PLAYWRIGHT_INPUTS.stage);
  expect(headers["x-mono-web-host"]).toBe(LOCAL_HOST);
  expect(headers["x-robots-tag"]).toBe("noindex");
}

function sortEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((left, right) => {
    const leftKey = [
      left.path,
      left.method,
      left.resourceType,
      String(left.status),
      String(left.redirect),
      JSON.stringify(left.headers),
    ].join("\u0000");
    const rightKey = [
      right.path,
      right.method,
      right.resourceType,
      String(right.status),
      String(right.redirect),
      JSON.stringify(right.headers),
    ].join("\u0000");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function exportSanitizedEvidence(diagnostics: HomepageDiagnostics): void {
  const build = diagnostics.buildLiterals;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const responses = sortEntries(diagnostics.responses);
  const probes = sortEntries(diagnostics.probes);
  writeFileSync(
    join(EVIDENCE_DIR, "network-ledger.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        origin: diagnostics.fixtureInputs.origin,
        responses,
        probes,
        forbiddenRequestPaths: [...diagnostics.forbiddenRequests].sort(),
        consoleErrors: diagnostics.consoleErrors.map(() => "redacted-error").sort(),
        pageErrors: diagnostics.pageErrors.map(() => "redacted-error").sort(),
        hydration: diagnostics.hydration,
        clientNavigation: diagnostics.clientNavigation,
        serviceWorkers: diagnostics.serviceWorkers,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (build === null) return;
  writeFileSync(
    join(EVIDENCE_DIR, "provenance.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        origin: diagnostics.fixtureInputs.origin,
        stage: diagnostics.fixtureInputs.stage,
        host: diagnostics.fixtureInputs.host,
        viewport: diagnostics.fixtureInputs.viewport,
        dataSource: build.dataSource,
        commit: build.commit,
        contentDigest: build.contentDigest,
        routeDigest: build.routeDigest,
        responseCount: responses.length,
        probeCount: probes.length,
        requiredProbes: ["GET /health", "GET /__0011_missing__", "POST /health"],
        probes,
        forbiddenRequestCount: diagnostics.forbiddenRequests.length,
        pageErrorCount: diagnostics.pageErrors.length,
        consoleErrorCount: diagnostics.consoleErrors.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
