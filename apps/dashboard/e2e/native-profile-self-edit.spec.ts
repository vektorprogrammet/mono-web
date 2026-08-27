import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const realRun = process.env.REAL_NATIVE_PROFILE_E2E === "1";
const evidencePath = process.env.PROFILE_E2E_BROWSER_EVIDENCE_PATH;
const apiOrigin = process.env.PROFILE_E2E_API_ORIGIN ?? "http://127.0.0.1:5195";
const person = {
  email: "profile-before-0064@example.invalid",
  password: "profile-e2e-0064-disposable-password",
};
const before = {
  firstName: "Ada",
  lastName: "Profile",
  email: person.email,
  phone: "+47 9000 0001",
  nameRevision: 0,
  contactRevision: 0,
};
const after = {
  firstName: "Ada Updated",
  lastName: "Profile Updated",
  email: "profile-after-0064@example.invalid",
  phone: "+47 9000 0002",
  nameRevision: 1,
  contactRevision: 1,
};

type LedgerEntry = {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly direction: "browser-to-proxy" | "proxy-to-native";
  readonly requestFields?: readonly string[];
  readonly requestRevisions?: readonly number[];
};

const openContext = async (browser: Browser, requests: LedgerEntry[], responses: LedgerEntry[]) => {
  const context = await browser.newContext();
  context.on("request", (request) => {
    const url = new URL(request.url());
    let fields: string[] | undefined;
    let revisions: number[] | undefined;
    try {
      const body = request.postDataJSON() as Record<string, unknown> | undefined;
      if (body !== undefined && typeof body === "object") {
        fields = Object.keys(body).sort();
        revisions = [body.expectedNameRevision, body.expectedContactRevision].filter(
          (value): value is number => typeof value === "number",
        );
      }
    } catch {
      // The ledger deliberately does not retain request body bytes.
    }
    requests.push({
      method: request.method(),
      path: url.pathname,
      status: 0,
      durationMs: 0,
      direction: "browser-to-proxy",
      ...(fields === undefined ? {} : { requestFields: fields }),
      ...(revisions === undefined ? {} : { requestRevisions: revisions }),
    });
  });
  context.on("response", (response) => {
    const url = new URL(response.url());
    responses.push({
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
      durationMs: 0,
      direction: "browser-to-proxy",
    });
  });
  const page = await context.newPage();
  return { context, page };
};

const signIn = async (page: Page) => {
  await page.goto(`/login?redirectTo=${encodeURIComponent("/dashboard/profile/rediger")}`);
  await page.getByLabel("E-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  await page.waitForURL((url) => url.pathname === "/dashboard/profile/rediger", {
    waitUntil: "commit",
    timeout: 20_000,
  });
  await expect
    .poll(async () =>
      (await page.context().cookies()).some(
        (cookie) => cookie.name === "better-auth.session_token",
      ),
    )
    .toBe(true);
};

const profileValues = (page: Page) =>
  Promise.all([
    page.getByLabel("Fornavn").inputValue(),
    page.getByLabel("Etternavn").inputValue(),
    page.getByLabel("E-post").inputValue(),
    page.getByLabel("Telefon").inputValue(),
  ]);

const assertAxe = async (page: Page, results: Record<string, number>, state: string) => {
  const accessibility = await new AxeBuilder({ page }).analyze();
  const blockingViolations = accessibility.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(blockingViolations).toEqual([]);
  results[state] = blockingViolations.length;
};

test.describe("Native Profile self-edit (spec 0064)", () => {
  test.skip(!realRun, "run through the disposable PostgreSQL Profile runner");

  test("proves one authenticated edit, stale conflict, strict HTTP, replay, and confinement", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const requests: LedgerEntry[] = [];
    const responses: LedgerEntry[] = [];
    const accessibility: Record<string, number> = {};
    const observations: Record<string, unknown> = {};
    const contexts: BrowserContext[] = [];
    const pageErrors: string[] = [];
    let context: BrowserContext | undefined;
    try {
      const unauthenticatedGet = await request.get(`${apiOrigin}/api/me`);
      const unauthenticatedPut = await request.put(`${apiOrigin}/api/me`, {
        headers: { "content-type": "application/json" },
        data: {},
      });
      expect(unauthenticatedGet.status()).toBe(401);
      expect(await unauthenticatedGet.json()).toEqual({ error: { tag: "UnauthenticatedActor" } });
      expect(unauthenticatedPut.status()).toBe(401);
      expect(await unauthenticatedPut.json()).toEqual({ error: { tag: "UnauthenticatedActor" } });
      observations.unauthenticated = { get: 401, put: 401, typed: true };

      const opened = await openContext(browser, requests, responses);
      context = opened.context;
      contexts.push(context);
      opened.page.on("pageerror", (error) => pageErrors.push(error.message));
      const page = opened.page;
      await signIn(page);
      const sessionCookie = (await context.cookies()).find(
        (cookie) => cookie.name === "better-auth.session_token",
      );
      expect(sessionCookie).toBeDefined();
      observations.login = {
        renderedNativeForm: true,
        sessionCookieName: "better-auth.session_token",
        cookieValueRecorded: false,
      };

      await expect(page.getByRole("heading", { level: 1, name: "Rediger profil" })).toBeVisible();
      const inputs = [
        page.getByLabel("Fornavn"),
        page.getByLabel("Etternavn"),
        page.getByLabel("E-post"),
        page.getByLabel("Telefon"),
      ];
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      for (const input of inputs) {
        await expect(input).toBeVisible();
        await expect(input).toHaveAttribute("id", /.+/u);
        await expect(input).toHaveAttribute("aria-describedby", /.+/u);
      }
      expect(await profileValues(page)).toEqual([
        before.firstName,
        before.lastName,
        before.email,
        before.phone,
      ]);
      await assertAxe(page, accessibility, "initial");
      observations.initial = {
        heading: "Rediger profil",
        values: before,
        labels: 4,
        uniqueIds: true,
      };

      await inputs[0].fill("");
      await inputs[1].fill("");
      await inputs[2].fill("ikke-en-e-post");
      await inputs[3].fill("ugyldig");
      await page.getByRole("button", { name: "Lagre endringer" }).click();
      await expect(
        page.getByRole("alert").filter({ hasText: "Feltet må fylles ut." }).first(),
      ).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: "E-post" }).first()).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: "Telefon" }).first()).toBeVisible();
      await assertAxe(page, accessibility, "invalid");
      observations.invalid = { fieldErrors: true, alertSemantics: true };
      await page.reload();

      await expect(page.getByRole("heading", { level: 1, name: "Rediger profil" })).toBeVisible();
      await inputs[0].fill(after.firstName);
      await inputs[1].fill(after.lastName);
      await inputs[2].fill(after.email);
      await inputs[3].fill(after.phone);
      const saveButton = page.getByRole("button", { name: "Lagre endringer" });
      const saveClick = saveButton.click();
      await expect(page.locator("form").first()).toHaveAttribute("aria-busy", "true");
      await expect(inputs[0]).toBeDisabled();
      await saveClick;
      await expect(page.getByRole("status")).toContainText("Profilen er lagret");
      expect(await profileValues(page)).toEqual([
        after.firstName,
        after.lastName,
        after.email,
        after.phone,
      ]);
      await assertAxe(page, accessibility, "success");
      observations.browserCommit = { values: after, freshRead: true, statusSemantics: true };

      const malformed = await context.request.put(`${apiOrigin}/api/me`, {
        headers: { "content-type": "application/json" },
        data: {
          _tag: "UpdateOwnProfile",
          commandId: "profile-malformed-0064",
          expectedNameRevision: after.nameRevision,
          expectedContactRevision: after.contactRevision,
          firstName: after.firstName,
          lastName: after.lastName,
          email: after.email,
          phone: after.phone,
          role: "ROLE_TEAM_MEMBER",
        },
      });
      expect(malformed.status()).toBe(422);
      expect(await malformed.json()).toEqual({ error: { tag: "ProfileDecodeError" } });
      observations.malformed = { status: 422, typed: true, mutation: false };

      const controlledCommand = {
        _tag: "UpdateOwnProfile",
        commandId: "profile-controlled-0064",
        expectedNameRevision: 1,
        expectedContactRevision: 1,
        firstName: "Ada Controlled",
        lastName: "Profile Controlled",
        email: "profile-controlled-0064@example.invalid",
        phone: "+47 9000 0003",
      };
      const controlled = await context.request.put(`${apiOrigin}/api/me`, {
        data: controlledCommand,
      });
      expect(controlled.status()).toBe(200);
      const controlledBody = (await controlled.json()) as Record<string, unknown>;
      expect(controlledBody.nameRevision).toBe(2);
      expect(controlledBody.contactRevision).toBe(2);
      observations.controlledConcurrentWrite = { status: 200, revisions: [2, 2] };

      await page.getByLabel("Fornavn").fill("Ada Stale Attempt");
      await page.getByRole("button", { name: "Lagre endringer" }).click();
      await expect(page.getByRole("alert")).toContainText("Profilen er endret");
      await assertAxe(page, accessibility, "staleConflict");
      observations.staleConflict = {
        status: 409,
        typedAlert: true,
        browserRevisionRemainedStale: true,
      };
      await page.reload();
      expect(await profileValues(page)).toEqual([
        controlledCommand.firstName,
        controlledCommand.lastName,
        controlledCommand.email,
        controlledCommand.phone,
      ]);
      observations.postConflictReload = {
        values: { ...controlledBody, role: undefined },
        revisions: [2, 2],
      };

      const httpConflict = {
        _tag: "UpdateOwnProfile",
        commandId: "profile-http-conflict-0064",
        expectedNameRevision: 2,
        expectedContactRevision: 2,
        firstName: "Ada HTTP Winner",
        lastName: "Profile HTTP Winner",
        email: "profile-http-winner-0064@example.invalid",
        phone: "+47 9000 0004",
      };
      const httpWinner = await context.request.put(`${apiOrigin}/api/me`, { data: httpConflict });
      expect(httpWinner.status()).toBe(200);
      const httpConflictChanged = await context.request.put(`${apiOrigin}/api/me`, {
        data: { ...httpConflict, firstName: "Ada HTTP Different" },
      });
      expect(httpConflictChanged.status()).toBe(409);
      expect(await httpConflictChanged.json()).toEqual({
        error: { tag: "ProfileCommandConflict" },
      });
      observations.sameIdConflict = { status: 409, typed: true, dataUnchanged: true };

      const authenticatedGet = await context.request.get(`${apiOrigin}/api/me`);
      expect(authenticatedGet.status()).toBe(200);
      const authenticatedBody = (await authenticatedGet.json()) as Record<string, unknown>;
      expect(Object.keys(authenticatedBody).sort()).toEqual([
        "contactRevision",
        "email",
        "firstName",
        "lastName",
        "nameRevision",
        "personId",
        "phone",
        "role",
      ]);
      expect(authenticatedBody.nameRevision).toBe(3);
      expect(authenticatedBody.contactRevision).toBe(3);
      observations.strictHttp = {
        get: 200,
        put: 200,
        responseFields: Object.keys(authenticatedBody).sort(),
        sdkRoutes: ["/api/me"],
      };

      await inputs[0].focus();
      const keyboardIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const focused = page.locator(":focus");
        keyboardIds.push(
          (await focused.getAttribute("id")) ?? (await focused.getAttribute("href")) ?? "",
        );
        await page.keyboard.press("Tab");
      }
      expect(keyboardIds).toContain("profile-first-name");
      expect(keyboardIds).toContain("profile-last-name");
      expect(keyboardIds).toContain("profile-email");
      expect(keyboardIds).toContain("profile-phone");
      expect(keyboardIds.some((id) => id.includes("dashboard/profile"))).toBe(true);
      observations.keyboard = { reachedInputs: true, reachedCancel: true, sequence: keyboardIds };
      expect(pageErrors).toEqual([]);

      const forbiddenPaths = requests.filter((entry) =>
        /symfony|mock\/api|fixtures|\/api\/me\/profile/u.test(entry.path),
      );
      expect(forbiddenPaths).toEqual([]);
      const evidence = {
        specId: "0064",
        passed: true,
        browser: "Chromium",
        realSessionCookie: true,
        observations,
        accessibilityViolations: accessibility,
        requestLedger: { requests, responses, forbiddenPaths },
        pageErrors,
      };
      if (evidencePath !== undefined)
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    } finally {
      await Promise.all(contexts.map((entry) => entry.close()));
    }
  });
});
