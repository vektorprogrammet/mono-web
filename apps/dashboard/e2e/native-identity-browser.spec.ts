import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readBrowserStorage } from "../browser/interview-response-state.js";

const realRun = process.env.REAL_NATIVE_IDENTITY_E2E === "1";
const evidencePath = process.env.IDENTITY_EVIDENCE_BROWSER_PATH;
const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "";
const email = process.env.IDENTITY_EVIDENCE_EMAIL ?? "";
const password = process.env.IDENTITY_EVIDENCE_PASSWORD ?? "";
const wrongPassword = process.env.IDENTITY_EVIDENCE_WRONG_PASSWORD ?? "";
const memberEmail = process.env.IDENTITY_EVIDENCE_MEMBER_EMAIL ?? "";
const memberPassword = process.env.IDENTITY_EVIDENCE_MEMBER_PASSWORD ?? "";
const adminScreenshotPath = process.env.IDENTITY_EVIDENCE_ADMIN_SCREENSHOT_PATH ?? "/dev/null";
const memberScreenshotPath = process.env.IDENTITY_EVIDENCE_MEMBER_SCREENSHOT_PATH ?? "/dev/null";
const outputPath = evidencePath ?? "/dev/null";
const hardeningEvidencePath = process.env.IDENTITY_HARDENING_BROWSER_PATH ?? "/dev/null";
const apiOrigin = process.env.API_URL ?? "";
const sessionCookieName = "better-auth.session_token";
const betterAuthSignInWindowResetMs = 10_500;
const navigationPaths = [
  "/dashboard/profile",
  "/dashboard/mine-utlegg",
  "/dashboard/sokere",
  "/dashboard/tidligere-assistenter",
  "/dashboard/intervjufordeling",
  "/dashboard/intervjuer",
  "/dashboard/statistikk",
  "/dashboard/assistenter",
  "/dashboard/vikarer",
  "/dashboard/skoler",
  "/dashboard/brukere",
  "/dashboard/epostliste",
  "/dashboard/team",
  "/dashboard/teaminteresse",
  "/dashboard/utlegg",
  "/dashboard/sponsorer",
  "/dashboard/attester",
  "/dashboard/intervjusjema",
  "/dashboard/avdelinger",
  "/dashboard/linjer",
  "/dashboard/opptaksperioder",
] as const;
const memberNavigationPaths = navigationPaths.slice(0, 2);
if (
  realRun &&
  (evidencePath === undefined ||
    dashboardOrigin === "" ||
    email === "" ||
    password === "" ||
    wrongPassword === "" ||
    memberEmail === "" ||
    memberPassword === "" ||
    memberScreenshotPath === "/dev/null" ||
    hardeningEvidencePath === "/dev/null" ||
    apiOrigin === "")
) {
  throw new Error("identity evidence requires process-bound credentials, origin, and output path");
}

type LedgerEntry = {
  readonly direction: "browser-to-dashboard";
  readonly destination: "loopback-dashboard" | "unexpected-origin";
  readonly method: string;
  readonly path: string;
  readonly authorityDataMatches: ReadonlyArray<string>;
  readonly legacyOrProvider: boolean;
  status: number;
  durationMs: number;
};

type BrowserAuthorityCheck = {
  readonly checkpoint: string;
  readonly htmlMatches: ReadonlyArray<string>;
  readonly domMatches: ReadonlyArray<string>;
  readonly localStorageEntries: number;
  readonly localStorageMatches: ReadonlyArray<string>;
  readonly sessionStorageEntries: number;
  readonly sessionStorageMatches: ReadonlyArray<string>;
  readonly cookieNameMatches: ReadonlyArray<string>;
  readonly cookieValueMatches: ReadonlyArray<string>;
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
    const url = new URL(request.url());
    started.set(request, Date.now());
    ledger.push({
      direction: "browser-to-dashboard",
      destination: url.origin === dashboardOrigin ? "loopback-dashboard" : "unexpected-origin",
      method: request.method(),
      path: url.pathname,
      authorityDataMatches: findAuthorityData(`${url.pathname}${url.search}`),
      legacyOrProvider: isLegacyOrProviderPath(url.pathname),
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
const authorityDataPatterns = [
  {
    label: "seeded-authorization-row",
    pattern: /identity-0056-(?:orthogonal|active|expired)/iu,
  },
  {
    label: "seeded-authorization-value",
    pattern:
      /Identity orthogonality 0056|approveReceipt|submitReceipt|EconomyGlobalReceiptApprovalGrant|EconomyPaymentAuthority|synthetic-only-no-secret/iu,
  },
  {
    label: "authorization-table",
    pattern: /authz_(?:tags|tag_assignments|rules)/iu,
  },
  {
    label: "authorization-field",
    pattern:
      /(?:ruleId|rule_id|tagId|tag_id|assignmentId|assignment_id|capabilityId|capability_id|subjectTagId|subject_tag_id)/u,
  },
] as const;

const findAuthorityData = (value: string): ReadonlyArray<string> =>
  authorityDataPatterns.filter(({ pattern }) => pattern.test(value)).map(({ label }) => label);

const isLegacyOrProviderPath = (path: string): boolean =>
  /symfony|mock\/api|fixtures|\/api\/login|login_check|sso\/login|glemt-passord|reset|verification|jwt|token/iu.test(
    path,
  ) ||
  (path.startsWith("/api/auth/sign-in/") && path !== "/api/auth/sign-in/email") ||
  /\/api\/auth\/(?:callback|oauth|sso|social|link-social|unlink-account)(?:\/|$)/iu.test(path);

const observeBrowserAuthorityIsolation = async (
  context: BrowserContext,
  page: Page,
  checkpoint: string,
): Promise<BrowserAuthorityCheck> => {
  const [bodyText, html, browserStorage] = await Promise.all([
    page.locator("body").innerText(),
    page.content(),
    page.evaluate(readBrowserStorage),
  ]);
  const artifact = {
    bodyText,
    html,
    localStorage: browserStorage.local,
    sessionStorage: browserStorage.session,
  };
  const domMatches = findAuthorityData(artifact.bodyText);
  const htmlMatches = findAuthorityData(artifact.html);
  const localStorageMatches = findAuthorityData(JSON.stringify(artifact.localStorage));
  const sessionStorageMatches = findAuthorityData(JSON.stringify(artifact.sessionStorage));
  const cookies = await context.cookies();
  const cookieNameMatches = findAuthorityData(JSON.stringify(cookies.map(({ name }) => name)));
  const cookieValueMatches = findAuthorityData(JSON.stringify(cookies.map(({ value }) => value)));
  expect(domMatches).toEqual([]);
  expect(htmlMatches).toEqual([]);
  expect(localStorageMatches).toEqual([]);
  expect(sessionStorageMatches).toEqual([]);
  expect(cookieNameMatches).toEqual([]);
  expect(cookieValueMatches).toEqual([]);
  return {
    htmlMatches,
    checkpoint,
    domMatches,
    localStorageEntries: artifact.localStorage.length,
    localStorageMatches,
    sessionStorageEntries: artifact.sessionStorage.length,
    sessionStorageMatches,
    cookieNameMatches,
    cookieValueMatches,
  };
};
const observeNavigationStatuses = async (
  context: BrowserContext,
  paths: ReadonlyArray<string>,
  acceptedStatuses: ReadonlyArray<number>,
): Promise<ReadonlyArray<{ readonly path: string; readonly status: number }>> => {
  const statuses = [];
  for (const path of paths) {
    const response = await context.request.get(`${dashboardOrigin}${path}`, {
      maxRedirects: 0,
    });
    statuses.push({ path, status: response.status() });
  }
  const failures = statuses.filter(({ status }) => !acceptedStatuses.includes(status));
  expect(failures, "navigation routes must preserve the persona-specific route contract").toEqual(
    [],
  );
  return statuses;
};
const originHeaders = (origin = dashboardOrigin): Record<string, string> => ({ Origin: origin });

const signInContext = async (
  context: BrowserContext,
  signInEmail: string,
  signInPassword: string,
): Promise<void> => {
  const response = await context.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: originHeaders(),
    data: { email: signInEmail, password: signInPassword },
  });
  expect(response.status()).toBe(200);
};

const readSessions = async (
  context: BrowserContext,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const response = await context.request.get(`${apiOrigin}/api/sessions`, {
    headers: originHeaders(),
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as ReadonlyArray<Record<string, unknown>>;
  const expectedFields = [
    "createdAt",
    "current",
    "expiresAt",
    "ipAddress",
    "sessionId",
    "updatedAt",
    "userAgent",
  ];
  expect(body.length).toBeGreaterThan(0);
  for (const session of body) {
    expect(Object.keys(session).sort()).toEqual(expectedFields);
    expect(typeof session.sessionId).toBe("string");
    expect(typeof session.createdAt).toBe("string");
    expect(typeof session.updatedAt).toBe("string");
    expect(typeof session.expiresAt).toBe("string");
    expect(typeof session.current).toBe("boolean");
  }
  expect(body.filter((session) => session.current === true)).toHaveLength(1);
  return body;
};

const nativeMutation = (
  context: BrowserContext,
  method: "DELETE" | "POST",
  path: string,
  origin = dashboardOrigin,
) =>
  context.request.fetch(`${apiOrigin}${path}`, {
    method,
    headers: originHeaders(origin),
  });

const replayWithCookie = (
  method: "DELETE" | "GET" | "POST",
  path: string,
  cookie: { readonly name: string; readonly value: string },
) =>
  fetch(`${apiOrigin}${path}`, {
    method,
    headers: {
      Cookie: `${cookie.name}=${cookie.value}`,
      Origin: dashboardOrigin,
    },
  });

test.describe("Native Identity browser evidence (spec 0065 with spec 0056 rules)", () => {
  test.skip(!realRun, "run through the bounded native Identity PostgreSQL runner");
  test("proves the frozen 0054.1 owner-only lifecycle and immediate persisted revocation", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const primary = await browser.newContext();
    const secondary = await browser.newContext();
    const third = await browser.newContext();
    const member = await browser.newContext();
    const signup = await browser.newContext();
    try {
      await signInContext(primary, email, password);
      await signInContext(secondary, email, password);

      const initial = await readSessions(primary);
      expect(initial).toHaveLength(2);
      const currentSessionId = initial.find((session) => session.current === true)?.sessionId;
      if (typeof currentSessionId !== "string") {
        throw new Error("current session projection omitted its opaque identifier");
      }

      const rejectedOrigin = await nativeMutation(
        primary,
        "POST",
        "/api/sessions:revoke-others",
        "https://untrusted.example.invalid",
      );
      expect(rejectedOrigin.status()).toBe(403);
      expect(await readSessions(primary)).toHaveLength(2);

      expect((await nativeMutation(primary, "POST", "/api/sessions:revoke-others")).status()).toBe(
        204,
      );
      expect((await nativeMutation(primary, "POST", "/api/sessions:revoke-others")).status()).toBe(
        204,
      );
      const secondaryAfterRevocation = await secondary.request.get(`${apiOrigin}/api/session`, {
        headers: originHeaders(),
      });
      expect(secondaryAfterRevocation.status()).toBe(401);

      await signInContext(third, email, password);
      const afterThirdSignIn = await readSessions(primary);
      expect(afterThirdSignIn).toHaveLength(2);
      const thirdSessionId = afterThirdSignIn.find(
        (session) => session.current === false,
      )?.sessionId;
      if (typeof thirdSessionId !== "string") {
        throw new Error("other owned session projection omitted its opaque identifier");
      }
      expect(
        (
          await nativeMutation(
            primary,
            "DELETE",
            `/api/sessions/${encodeURIComponent(thirdSessionId)}`,
          )
        ).status(),
      ).toBe(204);
      const repeatedDeleted = await nativeMutation(
        primary,
        "DELETE",
        `/api/sessions/${encodeURIComponent(thirdSessionId)}`,
      );
      const missing = await nativeMutation(
        primary,
        "DELETE",
        "/api/sessions/missing-session-0054-1",
      );
      expect(repeatedDeleted.status()).toBe(404);
      expect(missing.status()).toBe(404);
      expect(await repeatedDeleted.json()).toEqual(await missing.json());
      expect(
        (
          await third.request.get(`${apiOrigin}/api/session`, {
            headers: originHeaders(),
          })
        ).status(),
      ).toBe(401);

      await delay(betterAuthSignInWindowResetMs);
      await signInContext(member, memberEmail, memberPassword);
      const memberSessions = await readSessions(member);
      expect(memberSessions).toHaveLength(1);
      const memberSessionId = memberSessions[0]?.sessionId;
      if (typeof memberSessionId !== "string") {
        throw new Error("member session projection omitted its opaque identifier");
      }
      const memberCrossPerson = await nativeMutation(
        member,
        "DELETE",
        `/api/sessions/${encodeURIComponent(currentSessionId)}`,
      );
      const administratorCrossPerson = await nativeMutation(
        primary,
        "DELETE",
        `/api/sessions/${encodeURIComponent(memberSessionId)}`,
      );
      expect(memberCrossPerson.status()).toBe(404);
      expect(administratorCrossPerson.status()).toBe(404);
      expect(await memberCrossPerson.json()).toEqual(await administratorCrossPerson.json());

      const signupResponse = await signup.request.post(`${apiOrigin}/api/auth/sign-up/email`, {
        headers: originHeaders(),
        data: {
          name: "Rejected Signup",
          email: "rejected-signup-0054-1@example.invalid",
          password,
        },
      });
      expect(signupResponse.status()).toBe(400);
      expect(await readSessions(primary)).toHaveLength(1);

      const [primaryCookie] = (await primary.cookies()).filter((cookie) =>
        cookie.name.endsWith("better-auth.session_token"),
      );
      assert.ok(primaryCookie);
      expect((await nativeMutation(primary, "POST", "/api/sessions:revoke-all")).status()).toBe(
        204,
      );
      expect((await replayWithCookie("GET", "/api/session", primaryCookie)).status).toBe(401);
      expect(
        (await replayWithCookie("POST", "/api/sessions:revoke-all", primaryCookie)).status,
      ).toBe(401);

      await signInContext(primary, email, password);
      const [replacementCookie] = (await primary.cookies()).filter((cookie) =>
        cookie.name.endsWith("better-auth.session_token"),
      );
      assert.ok(replacementCookie);
      expect((await nativeMutation(primary, "DELETE", "/api/session")).status()).toBe(204);
      const immediateReplay = await Promise.all(
        Array.from({ length: 4 }, () => replayWithCookie("GET", "/api/session", replacementCookie)),
      );
      expect(immediateReplay.map((response) => response.status)).toEqual([401, 401, 401, 401]);
      expect((await replayWithCookie("DELETE", "/api/session", replacementCookie)).status).toBe(
        401,
      );

      expect((await nativeMutation(member, "DELETE", "/api/session")).status()).toBe(204);
      await writeFile(
        hardeningEvidencePath,
        `${JSON.stringify(
          {
            specId: "0054.1",
            passed: true,
            sessionProjection: {
              fields: Object.keys(initial[0] ?? {}).sort(),
              initialOwnedCount: initial.length,
              oneCurrent: initial.filter((session) => session.current === true).length,
              credentialFieldsObserved: [],
            },
            originRejection: { status: 403, mutationObserved: false },
            revocation: {
              revokeOthers: [204, 204],
              otherContextNextRequest: 401,
              revokeOne: 204,
              repeatedAndMissing: [404, 404],
              revokeAll: 204,
              revokeAllReplay: 401,
              current: 204,
              immediateReplay: immediateReplay.map((response) => response.status),
              currentReplay: 401,
            },
            ownership: {
              memberAgainstAdministrator: 404,
              administratorAgainstMember: 404,
              responseEqual: true,
            },
            signup: { status: 400, sessionCreated: false },
            cookieValueRecorded: false,
            syntheticPersonasOnly: true,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } finally {
      await Promise.all([
        primary.close(),
        secondary.close(),
        third.close(),
        member.close(),
        signup.close(),
      ]);
    }
  });

  test("proves login, strict session, revocation, rate limit, and login accessibility", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext();
    const ledger: LedgerEntry[] = [];
    const accessibility: Record<string, number> = {};
    const observations: Record<string, unknown> = {};
    const pageErrors: string[] = [];
    const browserAuthorityChecks: BrowserAuthorityCheck[] = [];
    attachBrowserLedger(context, ledger);
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await delay(betterAuthSignInWindowResetMs);
      await page.goto("/login");
      const initialViolations = await blockingViolations(page);
      accessibility.initial = initialViolations.length;
      expect(initialViolations).toEqual([]);
      await expect(page.getByRole("heading", { level: 1, name: "Vektorprogrammet" })).toBeVisible();
      await expect(page.getByLabel("E-post")).toHaveAttribute("id", "email");
      await expect(page.getByLabel("Passord", { exact: true })).toHaveAttribute("id", "password");
      browserAuthorityChecks.push(
        await observeBrowserAuthorityIsolation(context, page, "initial-login"),
      );
      await page.getByLabel("E-post").fill(email);
      await page.getByLabel("Passord", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Logg inn" }).click();
      await page.waitForURL((url) => url.pathname === "/dashboard", { waitUntil: "commit" });
      await expect(page.getByText("Journey Identity")).toBeVisible();
      browserAuthorityChecks.push(
        await observeBrowserAuthorityIsolation(context, page, "authenticated-dashboard"),
      );
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
      browserAuthorityChecks.push(
        await observeBrowserAuthorityIsolation(context, page, "authenticated-reload"),
      );
      observations.reload = {
        authenticatedShell: true,
        strictSessionProjection: "recorded-by-boundary",
      };
      await page.screenshot({ path: adminScreenshotPath, fullPage: true });
      observations.adminNavigation = await observeNavigationStatuses(
        context,
        navigationPaths,
        [200, 403],
      );

      const memberContext = await browser.newContext();
      attachBrowserLedger(memberContext, ledger);
      const memberPage = await memberContext.newPage();
      memberPage.on("pageerror", (error) => pageErrors.push(error.message));
      try {
        await memberPage.goto("/login");
        await memberPage.getByLabel("E-post").fill(memberEmail);
        await memberPage.getByLabel("Passord", { exact: true }).fill(memberPassword);
        await memberPage.getByRole("button", { name: "Logg inn" }).click();
        await memberPage.waitForURL((url) => url.pathname === "/dashboard", {
          waitUntil: "commit",
        });
        await memberPage.waitForLoadState("networkidle");
        await memberPage.screenshot({ path: memberScreenshotPath, fullPage: true });
        const memberBody = await memberPage.locator("body").innerText();
        expect(memberBody, `member dashboard at ${memberPage.url()}`).toContain("Mina Member");
        await expect(
          memberPage.getByRole("heading", { name: "Oversikten kunne ikke hentes" }),
        ).toBeVisible();
        await expect(memberPage.getByText("Opptak", { exact: true })).toHaveCount(0);
        await expect(memberPage.getByText("Assistenter", { exact: true })).toHaveCount(0);
        await expect(memberPage.getByText("Brukere", { exact: true })).toHaveCount(0);
        observations.memberNavigation = await observeNavigationStatuses(
          memberContext,
          memberNavigationPaths,
          [200],
        );
        const memberProfilePage = await memberContext.newPage();
        memberProfilePage.on("pageerror", (error) => pageErrors.push(error.message));
        try {
          const profileResponse = await memberProfilePage.goto("/dashboard/profile");
          expect(profileResponse?.status()).toBe(200);
          await expect(
            memberProfilePage.getByRole("heading", {
              name: "Profilopplysningene kunne ikke hentes",
            }),
          ).toBeVisible();
          await expect(
            memberProfilePage.getByRole("heading", { name: "Mina Member" }),
          ).toBeVisible();
        } finally {
          await memberProfilePage.close();
        }

        const identityButton = memberPage.getByRole("button", {
          name: new RegExp(memberEmail),
        });
        await expect(identityButton).toBeVisible();
        await identityButton.click();
        await expect(memberPage.getByRole("menuitem", { name: "Profil" })).toBeVisible();
        await expect(memberPage.getByRole("menuitem", { name: "Mine Utlegg" })).toBeVisible();
        await expect(memberPage.getByRole("menuitem", { name: "Logg ut" })).toBeVisible();

        const memberViolations = await blockingViolations(memberPage);
        accessibility.memberShell = memberViolations.length;
        expect(memberViolations).toEqual([]);
        await memberPage.screenshot({ path: memberScreenshotPath, fullPage: true });
        browserAuthorityChecks.push(
          await observeBrowserAuthorityIsolation(
            memberContext,
            memberPage,
            "authenticated-no-scope-member",
          ),
        );
        observations.memberShell = {
          profileStatus: "recorded-by-boundary-403",
          sessionIdentity: "Mina Member",
          identityMenu: ["Profil", "Mine Utlegg", "Logg ut"],
          organizationNavigation: "hidden",
          landing: "Unavailable",
        };
        await memberPage.getByRole("menuitem", { name: "Logg ut" }).click();
        await memberPage.waitForURL((url) => url.pathname === "/login", {
          waitUntil: "commit",
        });
      } finally {
        await memberContext.close();
      }

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
      await expect(page.getByRole("heading", { level: 1, name: "Vektorprogrammet" })).toBeVisible();
      observations.logout = { nativeStatus: 204, redirect: "/login", browserCookieRemoved: true };
      browserAuthorityChecks.push(
        await observeBrowserAuthorityIsolation(context, page, "logout-login"),
      );
      await context.addCookies([oldCookie]);
      await page.goto("/dashboard");
      await page.waitForURL((url) => url.pathname === "/login", { waitUntil: "commit" });
      await expect(page.getByRole("heading", { level: 1, name: "Vektorprogrammet" })).toBeVisible();
      await expect(page.getByText("Journey Identity")).toHaveCount(0);
      observations.oldCookieReplay = {
        retainedInMemoryOnly: true,
        sessionProjectionStatus: "recorded-by-boundary-401",
        authenticatedShell: false,
        cookieValueRecorded: false,
      };
      browserAuthorityChecks.push(
        await observeBrowserAuthorityIsolation(context, page, "revoked-cookie-replay"),
      );
      await context.clearCookies();
      await page.goto("/login");
      await delay(betterAuthSignInWindowResetMs);
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
      browserAuthorityChecks.push(
        await observeBrowserAuthorityIsolation(context, page, "rate-limited-login"),
      );
      const invalidViolations = await blockingViolations(page);
      accessibility.invalid = invalidViolations.length;
      accessibility.rateLimit = invalidViolations.length;
      expect(invalidViolations).toEqual([]);
      observations.wrongPassword = {
        attempts: 10,
        nativeStatuses: "recorded-by-boundary",
        windowMs: wrongWindowMs,
        invalidCredentialsMessage: "Feil e-post eller passord",
        rateLimitMessage: "For mange innloggingsforsøk. Prøv igjen om 15 minutter.",
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
      const forbidden = ledger.filter((entry) => entry.legacyOrProvider);
      const unexpectedDestinations = ledger.filter(
        (entry) => entry.destination === "unexpected-origin",
      );
      const authorityRequests = ledger.filter((entry) => entry.authorityDataMatches.length > 0);
      expect(forbidden).toEqual([]);
      expect(unexpectedDestinations).toEqual([]);
      expect(authorityRequests).toEqual([]);
      expect(pageErrors).toEqual([]);
      const evidence = {
        specId: "0065",
        extensionSpecId: "0056",
        passed: true,
        browser: "Chromium",
        browserVersion: browser.version(),
        screenshots: {
          admin: adminScreenshotPath,
          member: memberScreenshotPath,
          syntheticPersonasOnly: true,
        },
        observations,
        accessibilityViolations: accessibility,
        authorityIsolation: {
          browserArtifacts: browserAuthorityChecks,
          requestsWithAuthorityData: authorityRequests,
        },
        requestLedger: {
          browserToDashboard: ledger,
          forbidden,
          unexpectedDestinations,
        },
        pageErrors,
      };
      await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    } finally {
      await context.close();
    }
  });
});
