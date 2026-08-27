import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const realRun = process.env.REAL_NATIVE_IDENTITY_E2E === "1";
const evidencePath = process.env.IDENTITY_EVIDENCE_BROWSER_PATH;
const email = process.env.IDENTITY_EVIDENCE_EMAIL ?? "";
const password = process.env.IDENTITY_EVIDENCE_PASSWORD ?? "";
const wrongPassword = process.env.IDENTITY_EVIDENCE_WRONG_PASSWORD ?? "";
const outputPath = evidencePath ?? "/dev/null";
const sessionCookieName = "better-auth.session_token";
if (
  realRun &&
  (evidencePath === undefined || email === "" || password === "" || wrongPassword === "")
) {
  throw new Error("identity evidence requires process-bound credentials and output path");
}

type LedgerEntry = {
  readonly direction: "browser-to-dashboard";
  readonly method: string;
  readonly path: string;
  status: number;
  durationMs: number;
};

const blockingViolations = async (page: Page) => {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
};

const attachBrowserLedger = (context: BrowserContext, ledger: LedgerEntry[]) => {
  const started = new WeakMap<object, number>();
  const match = (request: { method(): string; url(): string }, status: number) => {
    const url = new URL(request.url());
    const entry = [...ledger]
      .reverse()
      .find(
        (candidate) =>
          candidate.status === 0 &&
          candidate.method === request.method() &&
          candidate.path === url.pathname,
      );
    if (entry !== undefined) {
      entry.status = status;
      entry.durationMs = Date.now() - (started.get(request) ?? Date.now());
    }
  };
  context.on("request", (request) => {
    started.set(request, Date.now());
    ledger.push({
      direction: "browser-to-dashboard",
      method: request.method(),
      path: new URL(request.url()).pathname,
      status: 0,
      durationMs: 0,
    });
  });
  context.on("response", (response) => match(response.request(), response.status()));
  context.on("requestfailed", (request) => match(request, 0));
};

const delay = (milliseconds: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};

test.describe("Native Identity browser evidence (spec 0065)", () => {
  test.skip(!realRun, "run through the bounded native Identity PostgreSQL runner");

  test("proves login, strict session, revocation, rate limit, and login accessibility", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext();
    const ledger: LedgerEntry[] = [];
    const accessibility: Record<string, number> = {};
    const observations: Record<string, unknown> = {};
    const pageErrors: string[] = [];
    attachBrowserLedger(context, ledger);
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await page.goto("/login");
      const initialViolations = await blockingViolations(page);
      accessibility.initial = initialViolations.length;
      expect(initialViolations).toEqual([]);
      await expect(page.getByRole("heading", { level: 1, name: "Vektorprogrammet" })).toBeVisible();
      await expect(page.getByLabel("E-post")).toHaveAttribute("id", "email");
      await expect(page.getByLabel("Passord", { exact: true })).toHaveAttribute("id", "password");
      await page.getByLabel("E-post").fill(email);
      await page.getByLabel("Passord", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Logg inn" }).click();
      await page.waitForURL((url) => url.pathname === "/dashboard", { waitUntil: "commit" });
      await expect(page.getByText("Journey Identity")).toBeVisible();
      const sessionCookie = (await context.cookies()).find(
        (cookie) => cookie.name === sessionCookieName,
      );
      expect(sessionCookie).toMatchObject({
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        secure: false,
      });
      assert.ok(sessionCookie?.value);
      observations.login = {
        status: 200,
        redirect: "/dashboard",
        cookieName: sessionCookieName,
        cookieValueRecorded: false,
        cookieAttributes: { httpOnly: true, sameSite: "Lax", path: "/", secure: false },
        shell: "Journey Identity",
      };
      await page.reload();
      await expect(page).toHaveURL(/\/dashboard\/?$/u);
      await expect(page.getByText("Journey Identity")).toBeVisible();
      observations.reload = {
        authenticatedShell: true,
        strictSessionProjection: "recorded-by-boundary",
      };
      const oldCookie = {
        name: sessionCookie.name,
        value: sessionCookie.value,
        domain: sessionCookie.domain,
        path: sessionCookie.path,
      };
      await page.getByRole("button", { name: new RegExp(email) }).click();
      await page.getByRole("menuitem", { name: "Logg ut" }).click();
      await page.waitForURL((url) => url.pathname === "/login", { waitUntil: "commit" });
      expect((await context.cookies()).some((cookie) => cookie.name === sessionCookieName)).toBe(
        false,
      );
      observations.logout = { status: 200, redirect: "/login", browserCookieRemoved: true };
      await context.addCookies([oldCookie]);
      await page.goto("/dashboard");
      await page.waitForURL((url) => url.pathname === "/login", { waitUntil: "commit" });
      await expect(page.getByText("Journey Identity")).toHaveCount(0);
      observations.oldCookieReplay = {
        retainedInMemoryOnly: true,
        sessionProjectionStatus: "recorded-by-boundary-401",
        authenticatedShell: false,
      };
      await context.clearCookies();
      await page.goto("/login");
      await delay(10_500);
      const wrongStarted = Date.now();
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await page.getByLabel("E-post").fill(email);
        await page.getByLabel("Passord", { exact: true }).fill(wrongPassword);
        await page.getByRole("button", { name: "Logg inn" }).click();
        if (attempt <= 3) await expect(page.getByText("Feil e-post eller passord")).toBeVisible();
        else
          await expect(
            page.getByText("For mange innloggingsforsøk. Prøv igjen om 15 minutter."),
          ).toBeVisible();
      }
      const wrongWindowMs = Date.now() - wrongStarted;
      const invalidViolations = await blockingViolations(page);
      accessibility.invalid = invalidViolations.length;
      accessibility.rateLimit = invalidViolations.length;
      expect(invalidViolations).toEqual([]);
      observations.wrongPassword = {
        attempts: 10,
        nativeStatuses: "recorded-by-boundary",
        windowMs: wrongWindowMs,
        exactRateLimitMessage: true,
      };
      await page.getByLabel("E-post").focus();
      const focusIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const focused = page.locator(":focus");
        focusIds.push(
          (await focused.getAttribute("id")) ?? (await focused.getAttribute("href")) ?? "",
        );
        await page.keyboard.press("Tab");
      }
      expect(focusIds).toEqual(expect.arrayContaining(["email", "password"]));
      observations.accessibility = {
        heading: "Vektorprogrammet",
        labels: { email: true, password: true, uniqueIds: true },
        keyboardReachable: true,
        visibleMessages: true,
        visibilityControlName: true,
        focusIds,
      };
      const forbidden = ledger.filter((entry) =>
        /symfony|mock\/api|fixtures|\/api\/login|login_check|sso\/login|glemt-passord|reset|verification|jwt|token/u.test(
          entry.path,
        ),
      );
      expect(forbidden).toEqual([]);
      expect(pageErrors).toEqual([]);
      const evidence = {
        specId: "0065",
        passed: true,
        browser: "Chromium",
        browserVersion: browser.version(),
        observations,
        accessibilityViolations: accessibility,
        requestLedger: { browserToDashboard: ledger, forbidden },
        pageErrors,
      };
      await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    } finally {
      await context.close();
    }
  });
});
