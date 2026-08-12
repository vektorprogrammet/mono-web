import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertHealthyPage,
  assertProvenance,
  BASE_URL,
  LOOPBACK_ORIGIN,
  LOCAL_HOST,
  recordBuildLiterals,
  recordClientNavigation,
  recordProbe,
  SCREENSHOT_DIR,
  test,
  expect,
} from "./fixtures/homepage-dev";

test("local DEV CONTENT homepage journey", async ({ page, diagnostics }) => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const home = await page.goto("/");
  await assertProvenance(home, "/");
  await assertHealthyPage(page, diagnostics);
  await expect(page).toHaveTitle(/DEV CONTENT/);
  await expect(page.getByTestId("dev-content-banner")).toContainText("DEV CONTENT");
  await expect(page.getByTestId("dev-content-banner")).toContainText("p000");
  await expect(page.getByText("Abelprisen (DEV)")).toBeVisible();
  await expect(page.getByText("Assistenter").first()).toBeVisible();
  await page.waitForFunction("window.__MONO_WEB_HYDRATED__ === true");
  let documentRequests = 0;
  const onRequest = (request: { resourceType(): string }) => {
    if (request.resourceType() === "document") documentRequests += 1;
  };
  page.on("request", onRequest);
  const documentRequestsBeforeTeamNavigation = documentRequests;
  await page.screenshot({ path: join(SCREENSHOT_DIR, "home.png") });

  let navigationPassed = false;
  try {
    await page.getByRole("link", { name: "Team", exact: true }).first().click();
    await page.waitForURL(`${BASE_URL}/team`);
    navigationPassed = true;
  } finally {
    recordClientNavigation(diagnostics, navigationPassed);
  }
  const team = await page.request.get(`${LOOPBACK_ORIGIN}/team`, {
    headers: { Host: LOCAL_HOST },
  });
  await recordProbe(diagnostics, "GET", "/team", team, "document");
  await assertProvenance(team, "/team");
  await assertHealthyPage(page, diagnostics);
  await expect(page.getByTestId("dev-content-banner")).toContainText(LOCAL_HOST);
  await expect(page.getByText("Våre team")).toBeVisible();
  await expect(page.getByText("Styret").first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOT_DIR, "team.png") });
  expect(documentRequests).toBe(documentRequestsBeforeTeamNavigation);
  page.off("request", onRequest);
  await page.waitForFunction("window.__MONO_WEB_HYDRATED__ === true");

  const asset = await page.request.get(`${LOOPBACK_ORIGIN}/images/vektor-logo.svg`, {
    headers: { Host: LOCAL_HOST },
  });
  await recordProbe(diagnostics, "GET", "/images/vektor-logo.svg", asset, "image");
  await assertProvenance(asset, "/images/vektor-logo.svg");
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toContain("image/svg+xml");
  const contact = await page.goto("/kontakt/trondheim");
  await assertProvenance(contact, "/kontakt/trondheim");
  await assertHealthyPage(page, diagnostics);
  await expect(page.getByText("kontakt-trondheim@example.invalid")).toBeVisible();
  await expect(page.getByText("DEV CONTENT, Trondheim").first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOT_DIR, "kontakt-trondheim.png") });

  const pageChecks = [
    ["/om-oss", "Om Vektorprogrammet"],
    ["/assistenter", "Assistenter"],
    ["/foreldre", "Informasjon for foreldre"],
  ] as const;
  for (const [path, content] of pageChecks) {
    const response = await page.goto(path);
    await assertProvenance(response, path);
    await assertHealthyPage(page, diagnostics);
    await expect(page.getByText(content).first()).toBeVisible();
  }

  const health = await page.request.get(`${LOOPBACK_ORIGIN}/health`, {
    headers: { Host: LOCAL_HOST },
  });
  await recordProbe(diagnostics, "GET", "/health", health);
  expect(health.status()).toBe(200);
  const healthBody = await health.json();
  const buildLiterals = recordBuildLiterals(diagnostics, healthBody);
  expect(buildLiterals.dataSource).toBe("dev-content");
  expect(buildLiterals.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(buildLiterals.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(buildLiterals.routeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(health.headers()["cache-control"]).toBe("no-store");
  expect(health.headers()["x-mono-web-stage"]).toBe("p000");
  expect(health.headers()["x-mono-web-host"]).toBe(LOCAL_HOST);

  const missing = await page.request.get(`${LOOPBACK_ORIGIN}/__0011_missing__`, {
    headers: { Host: LOCAL_HOST },
  });
  await recordProbe(diagnostics, "GET", "/__0011_missing__", missing);
  expect(missing.status()).toBe(404);
  expect(missing.headers()["x-mono-web-stage"]).toBe("p000");

  const method = await page.request.post(`${LOOPBACK_ORIGIN}/health`, {
    headers: { Host: LOCAL_HOST },
  });
  await recordProbe(diagnostics, "POST", "/health", method);
  expect(method.status()).toBe(405);
  expect(method.headers().allow).toBe("GET");

  expect(diagnostics.probes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: "/team", status: 200 }),
      expect.objectContaining({ method: "GET", path: "/images/vektor-logo.svg", status: 200 }),
      expect.objectContaining({ method: "GET", path: "/health", status: 200 }),
      expect.objectContaining({ method: "GET", path: "/__0011_missing__", status: 404 }),
      expect.objectContaining({ method: "POST", path: "/health", status: 405 }),
    ]),
  );
  expect(
    [...diagnostics.responses, ...diagnostics.probes].every(({ path }) => !/[?#]/.test(path)),
  ).toBe(true);
  const allowedHeaders: Record<string, true> = {
    allow: true,
    location: true,
    "cache-control": true,
    "content-type": true,
    "x-mono-web-host": true,
    "x-mono-web-stage": true,
    "x-robots-tag": true,
  };
  for (const entry of [...diagnostics.responses, ...diagnostics.probes]) {
    expect(entry.method).toMatch(/^[A-Z]+$/);
    expect(entry.resourceType).toBeTruthy();
    expect(entry.path).toMatch(/^\/|^(data:|blob:|external-origin)$/);
    expect(entry.path).not.toMatch(/[?#]|https?:\/\/|[\\]/);
    expect(entry.status).toEqual(expect.any(Number));
    expect(typeof entry.redirect).toBe("boolean");
    expect(Object.keys(entry.headers).every((name) => allowedHeaders[name] === true)).toBe(true);
  }
  expect(diagnostics.fixtureInputs.viewport).toEqual({ width: 1440, height: 900 });

  expect(diagnostics.forbiddenRequests).toEqual([]);
  expect(diagnostics.failedResponses).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.hydration).toEqual({ checked: true, passed: true });
  expect(diagnostics.clientNavigation).toEqual({ checked: true, passed: true });
  expect(diagnostics.serviceWorkers).toEqual({ checked: true, absent: true });
  expect(diagnostics.buildLiterals).toEqual({
    commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    dataSource: "dev-content",
    contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    routeDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
  });
});
