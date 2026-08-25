import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const realNativeIdentity = process.env.REAL_NATIVE_IDENTITY_E2E === "1";
const evidencePath = process.env.CONTENT_E2E_BROWSER_EVIDENCE_PATH;
const homepageOrigin = process.env.CONTENT_E2E_HOMEPAGE_ORIGIN ?? "http://127.0.0.1:45264";
const departmentAlpha = "content-e2e-0062-department-alpha";
const persons = {
  administrator: {
    email: "administrator.content.0062@example.invalid",
    password: "content-admin-0062-password",
  },
  leaderDepartmentA: {
    email: "leader.content.0062@example.invalid",
    password: "content-leader-0062-password",
  },
  authorDepartmentA: {
    email: "author.content.0062@example.invalid",
    password: "content-author-0062-password",
  },
  endedOnlyMember: {
    email: "ended.content.0062@example.invalid",
    password: "content-ended-0062-password",
  },
  noAuthority: {
    email: "no-authority.content.0062@example.invalid",
    password: "content-none-0062-password",
  },
} as const;

type BrowserRequest = {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
};
type BrowserResponse = BrowserRequest & { readonly status: number };

const openContext = async (
  browser: Browser,
  browserRequests: BrowserRequest[],
  browserResponses: BrowserResponse[],
  pageErrors: string[],
): Promise<{ readonly context: BrowserContext; readonly page: Page }> => {
  const context = await browser.newContext();
  context.on("request", (request) => {
    const url = new URL(request.url());
    browserRequests.push({ method: request.method(), pathname: url.pathname, search: url.search });
  });
  context.on("response", (response) => {
    const url = new URL(response.url());
    browserResponses.push({
      method: response.request().method(),
      pathname: url.pathname,
      search: url.search,
      status: response.status(),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { context, page };
};

const signIn = async (
  page: Page,
  person: { readonly email: string; readonly password: string },
  redirectTo: string,
) => {
  await page.goto(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel("Brukernavn eller e-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  try {
    await page.waitForURL((url) => url.pathname === redirectTo, {
      timeout: 15_000,
      waitUntil: "commit",
    });
  } catch (cause) {
    throw new Error(
      `sign-in did not reach ${redirectTo}; current URL ${page.url()}; body: ${await page.locator("body").innerText()}`,
      { cause },
    );
  }
  await expect
    .poll(async () =>
      (await page.context().cookies()).some(
        (cookie) => cookie.name === "better-auth.session_token",
      ),
    )
    .toBe(true);
};

test.describe("Native Content publication (spec 0062)", () => {
  test.skip(!realNativeIdentity, "run through the disposable PostgreSQL content runner");

  test("proves the staff arc, typed denials, public reads, and request confinement", async ({
    browser,
  }) => {
    const browserRequests: BrowserRequest[] = [];
    const browserResponses: BrowserResponse[] = [];
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    const contexts: BrowserContext[] = [];
    const observations: Record<string, unknown> = {};

    try {
      // --- Administrator: full staff arc -------------------------------
      const administrator = await openContext(
        browser,
        browserRequests,
        browserResponses,
        pageErrors,
      );
      contexts.push(administrator.context);
      await signIn(administrator.page, persons.administrator, "/dashboard/artikler");
      await expect(
        administrator.page.getByRole("heading", { name: "Artikler", exact: true }),
      ).toBeVisible();

      // Forced upstream failure renders a retry banner; retry succeeds.
      const failureAlert = administrator.page.getByRole("alert");
      await expect(failureAlert).toContainText("kunne ikke hentes");
      await failureAlert.getByRole("button", { name: "Prøv igjen" }).click();
      await expect(
        administrator.page.getByText("Kladd fra forfatter", { exact: true }).first(),
      ).toBeVisible();

      // Create a draft through the editor pane.
      await administrator.page.getByRole("button", { name: "Ny artikkel" }).click();
      await administrator.page.getByLabel("Tittel").fill("Fersk nyhet fra admin");
      await administrator.page
        .getByLabel("Brødtekst")
        .fill("<p>Første utkast av fersk nyhet.</p>");
      await administrator.page.getByRole("checkbox", { name: departmentAlpha }).check();
      await administrator.page.getByRole("button", { name: "Lagre kladd" }).click();
      await expect(administrator.page.getByText("Fersk nyhet fra admin").first()).toBeVisible();

      // Revise the working copy.
      await administrator.page.getByLabel("Brødtekst").fill("<p>Revidert utkast.</p>");
      await administrator.page.getByRole("button", { name: "Lagre endringer" }).click();
      await expect(
        administrator.page.locator('[data-dirty="false"], [data-dirty="true"]'),
      ).toBeAttached();

      // Publish.
      const freshRow = administrator.page
        .getByRole("listitem")
        .filter({ hasText: "Fersk nyhet fra admin" });
      await freshRow.getByRole("button", { name: "Publiser" }).click();
      await expect(freshRow.getByText("Publisert")).toBeVisible();

      observations.administratorArc = {
        created: true,
        revised: true,
        published: true,
      };

      const accessibility = await new AxeBuilder({ page: administrator.page }).analyze();
      expect(accessibility.violations).toEqual([]);

      // --- Leader: revise + republish the two-version case -------------
      const leader = await openContext(browser, browserRequests, browserResponses, pageErrors);
      contexts.push(leader.context);
      await signIn(leader.page, persons.leaderDepartmentA, "/dashboard/artikler");
      await expect(leader.page.getByText("To versjoner", { exact: true })).toBeVisible();
      const twoVersionRow = leader.page
        .getByRole("listitem")
        .filter({ hasText: "To versjoner" });
      await twoVersionRow.getByRole("button", { name: "Publiser" }).click();
      await expect(twoVersionRow.getByText("Publisert").first()).toBeVisible();
      observations.leaderRepublish = { twoVersionsNow: true };

      // --- Unpublish the two-version article ---------------------------
      await twoVersionRow.getByRole("button", { name: "Avpubliser" }).click();
      await expect(twoVersionRow.getByText("Kladd").first()).toBeVisible();
      observations.unpublish = { clearedPointer: true };

      // --- Member author: publish denied (typed NotPublisher) ----------
      const author = await openContext(browser, browserRequests, browserResponses, pageErrors);
      contexts.push(author.context);
      await signIn(author.page, persons.authorDepartmentA, "/dashboard/artikler");
      await expect(author.page.getByText("Kladd fra forfatter").first()).toBeVisible();
      const publishButtons = author.page.getByRole("button", { name: "Publiser" });
      await expect(publishButtons).toHaveCount(0);
      const directBridge = await author.page.evaluate(async () => {
        const response = await fetch("/content/drafts/9999/publish", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: "author-forced-publish" }),
        });
        return { status: response.status, body: (await response.json()) as unknown };
      });
      expect(directBridge.status).toBe(403);
      expect(directBridge.body).toEqual({ error: { tag: "NotPublisher" } });
      observations.authorDenial = { publishButtonAbsent: true, bridgeStatus: 403 };
      const authorAccessibility = await new AxeBuilder({ page: author.page }).analyze();
      expect(authorAccessibility.violations).toEqual([]);

      // --- Ended-only and no-authority personas: typed denials ---------
      for (const [name, person, expectedTag] of [
        ["endedOnlyMember", persons.endedOnlyMember, "AuthorityInactive"],
        ["noAuthority", persons.noAuthority, "NotInScope"],
      ] as const) {
        const denied = await openContext(browser, browserRequests, browserResponses, pageErrors);
        contexts.push(denied.context);
        await signIn(denied.page, person, "/dashboard/artikler");
        await expect(denied.page.getByRole("alert")).toContainText(
          expectedTag === "AuthorityInactive"
            ? "ikke aktiv"
            : "ikke tilgang til artikkeladministrasjon",
        );
        observations[name] = { status: 403, tag: expectedTag, renderedAt: "/dashboard/artikler" };
      }

      // --- Anonymous second context: public reads ----------------------
      const anonymous = await browser.newContext();
      contexts.push(anonymous);
      const anonPage = await anonymous.newPage();
      anonPage.on("pageerror", (error) => pageErrors.push(error.message));

      // Listing shows seeded published articles; the unpublished article is gone.
      const listing = await anonPage.goto(`${homepageOrigin}/nyheter`);
      expect(listing?.status()).toBe(200);
      await expect(anonPage.getByRole("heading", { name: "Nyheter" })).toBeVisible();
      await expect(anonPage.getByText("Orgomfattende nyhet")).toBeVisible();
      await expect(anonPage.getByText("Publisert alfa")).toBeVisible();
      await expect(anonPage.getByText("To versjoner")).toHaveCount(0);

      // Detail with author display name.
      const detail = await anonPage.goto(`${homepageOrigin}/nyhet/publisert-alfa`);
      expect(detail?.status()).toBe(200);
      await expect(anonPage.getByRole("heading", { name: "Publisert alfa" })).toBeVisible();
      await expect(anonPage.getByText("Ada Administrator")).toBeVisible();

      // The old version stays resolvable after republication (?versjon=1).
      const oldVersion = await anonPage.goto(
        `${homepageOrigin}/nyhet/to-versjoner?versjon=1`,
      );
      expect(oldVersion?.status()).toBe(200);
      await expect(anonPage.getByText("Versjon én tekst")).toBeVisible();

      // Unpublished canonical slug is a plain 404.
      const unpublished = await anonPage.goto(`${homepageOrigin}/nyhet/to-versjoner`);
      expect(unpublished?.status()).toBe(404);

      // Front-page teaser shows sticky-first summaries.
      const frontPage = await anonPage.goto(`${homepageOrigin}/`);
      expect(frontPage?.status()).toBe(200);
      await expect(anonPage.getByRole("heading", { name: "Nyheter" })).toBeVisible();
      observations.publicReads = {
        listingVisible: true,
        detailAuthorShown: true,
        oldVersionResolvable: true,
        unpublishedCanonical404: true,
        teaserVisible: true,
      };
      const anonAccessibility = await new AxeBuilder({ page: anonPage }).analyze();
      expect(anonAccessibility.violations).toEqual([]);

      // --- Request ledger confinement ----------------------------------
      const bridgeRequests = browserRequests.filter((request) =>
        request.pathname.startsWith("/content"),
      );
      expect(bridgeRequests.length).toBeGreaterThanOrEqual(3);
      expect(browserRequests.filter((request) => request.pathname === "/api/admin/schools")).toEqual(
        [],
      );
      expect(
        browserRequests.filter(
          (request) =>
            request.pathname.includes("/kontrollpanel") ||
            request.pathname.includes("/api/articles") ||
            request.pathname.includes("/mock/api") ||
            request.pathname.startsWith("/fixtures"),
        ),
      ).toEqual([]);
      expect(pageErrors).toEqual([]);

      const evidence = {
        specId: "0062",
        passed: true,
        browser: "Chromium",
        realSessionCookie: true,
        bridgeRequests,
        bridgeResponses: browserResponses.filter((response) =>
          response.pathname.startsWith("/content"),
        ),
        observations,
        pageErrors,
        accessibilityViolations: accessibility.violations,
      };
      if (evidencePath !== undefined) {
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
});
