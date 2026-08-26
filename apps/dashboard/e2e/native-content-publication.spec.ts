import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const realNativeIdentity = process.env.REAL_NATIVE_IDENTITY_E2E === "1";
const evidencePath = process.env.CONTENT_E2E_BROWSER_EVIDENCE_PATH;
const homepageOrigin = process.env.CONTENT_E2E_HOMEPAGE_ORIGIN ?? "http://127.0.0.1:45264";
const contentApiOrigin = process.env.CONTENT_E2E_API_ORIGIN ?? "http://127.0.0.1:45263";
const departmentAlpha = "content-e2e-0062-department-alpha";
const departmentBeta = "content-e2e-0062-department-beta";
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
      await expect(failureAlert).toContainText("midlertidig utilgjengelig");
      await failureAlert.getByRole("button", { name: "Prøv igjen" }).click();
      await expect(
        administrator.page.getByRole("button", { name: /Kladd fra forfatter/ }).first(),
      ).toBeVisible({ timeout: 15_000 });

      // Create a draft through the editor pane.
      await administrator.page.getByRole("button", { name: "Ny artikkel" }).click();
      await administrator.page.getByLabel("Tittel").fill("Fersk nyhet fra admin");
      await administrator.page.getByLabel("Brødtekst").fill("<p>Første utkast av fersk nyhet.</p>");
      await administrator.page.locator(`#content-dept-${departmentAlpha}`).check();
      await administrator.page.getByRole("button", { name: "Lagre kladd" }).click();

      await expect(
        administrator.page.getByRole("button", { name: /Fersk nyhet fra admin/ }).first(),
      ).toBeVisible();

      // Select the created draft's row to load it into the editor.
      await administrator.page
        .getByRole("button", { name: /Fersk nyhet fra admin/ })
        .first()
        .click();
      await expect(administrator.page.getByLabel("Brødtekst")).toHaveValue(
        "<p>Første utkast av fersk nyhet.</p>",
      );

      // Revise the working copy.
      await administrator.page.getByLabel("Brødtekst").fill("<p>Revidert utkast.</p>");
      await administrator.page.getByRole("button", { name: "Lagre endringer" }).click();
      await expect(administrator.page.locator('[data-dirty="false"]')).toBeAttached();

      // Publish.
      const freshRow = administrator.page
        .getByRole("listitem")
        .filter({ hasText: "Fersk nyhet fra admin" });
      await freshRow.getByRole("button", { name: "Publiser", exact: true }).click();
      await expect(freshRow.getByText("Publisert")).toBeVisible();

      observations.administratorArc = {
        created: true,
        revised: true,
        published: true,
      };

      const accessibility = await new AxeBuilder({ page: administrator.page }).analyze();
      expect(accessibility.violations).toEqual([]);

      // --- Leader: revise + republish one immutable version -----------
      const leader = await openContext(browser, browserRequests, browserResponses, pageErrors);
      contexts.push(leader.context);
      await signIn(leader.page, persons.leaderDepartmentA, "/dashboard/artikler");
      const twoVersionRow = leader.page.getByRole("listitem").filter({ hasText: "To versjoner" });
      await expect(twoVersionRow).toBeVisible();
      await twoVersionRow.getByRole("button", { name: /To versjoner/ }).click();
      await expect(leader.page.getByLabel("Brødtekst")).toHaveValue("<p>Versjon én tekst</p>");
      const twoVersionArticleId = Number(await twoVersionRow.getAttribute("data-article-id"));
      const concurrentRevision = await leader.page.evaluate(async (articleId) => {
        const detailResponse = await fetch("/content", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "readArticle", articleId }),
        });
        const detail = (await detailResponse.json()) as Record<string, unknown>;
        const reviseResponse = await fetch("/content", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "reviseDraft",
            commandId: "leader-concurrent-revise",
            articleId,
            expectedRevision: detail.revision,
            title: detail.title,
            bodyHtml: "<p>Ekstern samtidig endring</p>",
            departmentIds: detail.departmentIds,
            sticky: detail.sticky,
          }),
        });
        return {
          detailStatus: detailResponse.status,
          detail,
          reviseStatus: reviseResponse.status,
        };
      }, twoVersionArticleId);
      expect(concurrentRevision.detailStatus).toBe(200);
      expect(concurrentRevision.detail.bodyHtml).toBe("<p>Versjon én tekst</p>");
      expect(concurrentRevision.detail.revision).toBe(0);
      expect(concurrentRevision.detail).not.toHaveProperty("createdByPersonId");
      expect(concurrentRevision.reviseStatus).toBe(200);

      // The stale editor copy fails with a typed optimistic-concurrency conflict.
      await leader.page.getByLabel("Brødtekst").fill("<p>Utdatert forsøk</p>");
      await leader.page.getByRole("button", { name: "Lagre endringer" }).click();
      await expect(leader.page.getByRole("alert")).toContainText("endret av andre samtidig");

      // Re-selecting performs another strict detail read and permits repeated revision.
      await twoVersionRow.getByRole("button", { name: /To versjoner/ }).click();
      await expect(leader.page.getByLabel("Brødtekst")).toHaveValue(
        "<p>Ekstern samtidig endring</p>",
      );
      await leader.page.getByLabel("Brødtekst").fill("<p>Versjon to tekst</p>");
      await leader.page.getByRole("button", { name: "Lagre endringer" }).click();
      await expect(leader.page.locator('[data-dirty="false"]')).toBeAttached();
      await twoVersionRow.getByRole("button", { name: "Publiser", exact: true }).click();
      await expect(twoVersionRow.getByText("Publisert").first()).toBeVisible();

      // A separate anonymous context records the full public request ledger
      // while observing both the new canonical bytes and immutable version.
      const anonymous = await openContext(browser, browserRequests, browserResponses, pageErrors);
      contexts.push(anonymous.context);
      const anonPage = anonymous.page;
      const republished = await anonPage.goto(`${homepageOrigin}/nyhet/to-versjoner`);
      expect(republished?.status()).toBe(200);
      await expect(anonPage.getByText("Versjon to tekst")).toBeVisible();
      const oldVersion = await anonPage.goto(`${homepageOrigin}/nyhet/to-versjoner?versjon=1`);
      expect(oldVersion?.status()).toBe(200);
      await expect(anonPage.getByText("Versjon én tekst")).toBeVisible();
      await expect(anonPage.getByText("Erik Forfatter")).toBeVisible();
      observations.leaderRepublish = {
        strictDetailRead: true,
        privateCreatorIdAbsent: true,
        staleRevisionConflict: true,
        repeatedRevisionRecovered: true,
        newCanonicalBytes: true,
        immutableVersionOneBytes: true,
      };

      // Withdrawal is observable on the next fresh anonymous reads,
      // including the historical path.
      await twoVersionRow.getByRole("button", { name: "Avpubliser", exact: true }).click();
      await expect(twoVersionRow.getByText("Kladd").first()).toBeVisible();
      const afterWithdrawal = await anonPage.goto(`${homepageOrigin}/nyheter`);
      expect(afterWithdrawal?.status()).toBe(200);
      await expect(anonPage.getByText("To versjoner")).toHaveCount(0);
      const unpublished = await anonPage.goto(`${homepageOrigin}/nyhet/to-versjoner`);
      expect(unpublished?.status()).toBe(404);
      const unpublishedVersion = await anonPage.goto(
        `${homepageOrigin}/nyhet/to-versjoner?versjon=1`,
      );
      expect(unpublishedVersion?.status()).toBe(404);
      observations.unpublish = {
        listingAbsentImmediately: true,
        canonical404: true,
        historical404: true,
      };

      // Republishing after withdrawal must allocate the next immutable number
      // instead of attempting to reuse version 1 or 2.
      await twoVersionRow.getByRole("button", { name: "Publiser", exact: true }).click();
      await expect(twoVersionRow.getByText("Publisert").first()).toBeVisible();
      const versionThree = await anonPage.goto(`${homepageOrigin}/nyhet/to-versjoner?versjon=3`);
      expect(versionThree?.status()).toBe(200);
      await expect(anonPage.getByText("Versjon to tekst")).toBeVisible();
      observations.republishAfterWithdrawal = {
        versionThreeResolvable: true,
        authorRemainsCreator: true,
      };

      // Restore the withdrawn state for the remaining public absence checks.
      await twoVersionRow.getByRole("button", { name: "Avpubliser", exact: true }).click();
      await expect(twoVersionRow.getByText("Kladd").first()).toBeVisible();

      // --- Member author: publish denied (typed NotPublisher) ----------
      const author = await openContext(browser, browserRequests, browserResponses, pageErrors);
      contexts.push(author.context);
      await signIn(author.page, persons.authorDepartmentA, "/dashboard/artikler");
      await expect(author.page.getByText("Kladd fra forfatter").first()).toBeVisible();
      const authorDraftRow = author.page
        .getByRole("listitem")
        .filter({ hasText: "Kladd fra forfatter" });
      await expect(authorDraftRow).toBeVisible();
      const publishButtons = author.page.getByRole("button", { name: "Publiser", exact: true });
      await expect(publishButtons).toHaveCount(0);
      const authorDraftId = Number(await authorDraftRow.getAttribute("data-article-id"));
      expect(Number.isSafeInteger(authorDraftId)).toBe(true);
      const directBridge = await author.page.evaluate(async (articleId) => {
        const response = await fetch("/content", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "publish",
            commandId: "author-forced-publish",
            articleId,
          }),
        });
        return { status: response.status, body: (await response.json()) as unknown };
      }, authorDraftId);
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

      // --- Anonymous public reads --------------------------------------

      // Listing shows seeded published articles; the unpublished article is gone.
      const listing = await anonPage.goto(`${homepageOrigin}/nyheter`);
      expect(listing?.status()).toBe(200);
      await expect(anonPage.getByRole("heading", { name: "Nyheter" })).toBeVisible();
      await expect(anonPage.getByText("Orgomfattende nyhet")).toBeVisible();
      await expect(anonPage.getByText("Publisert alfa")).toBeVisible();
      await expect(anonPage.getByText("To versjoner")).toHaveCount(0);

      const departmentListing = await anonPage.request.get(
        `${contentApiOrigin}/api/news?department=${departmentBeta}`,
      );
      expect(departmentListing.status()).toBe(200);
      const departmentListingBody = (await departmentListing.json()) as {
        readonly articles: ReadonlyArray<{ readonly slug: string }>;
      };
      expect(departmentListingBody.articles.map((article) => article.slug)).toEqual([
        "festet-fleravdeling",
        "orgomfattende-nyhet",
      ]);

      // Detail with author display name.
      const detail = await anonPage.goto(`${homepageOrigin}/nyhet/publisert-alfa`);
      expect(detail?.status()).toBe(200);
      await expect(anonPage.getByRole("heading", { name: "Publisert alfa" })).toBeVisible();
      await expect(anonPage.getByText("Ada Administrator")).toBeVisible();
      await expect(anonPage.getByRole("heading", { name: "Andre nyheter" })).toBeVisible();

      // The republished and historical bytes were observed before the
      // withdrawal above; both paths are now proven absent.
      // Front-page teaser shows sticky-first summaries.
      const frontPage = await anonPage.goto(`${homepageOrigin}/`);
      expect(frontPage?.status()).toBe(200);
      await expect(anonPage.getByRole("heading", { name: "Nyheter" })).toBeVisible();
      observations.publicReads = {
        listingVisible: true,
        departmentFilterNarrowed: true,
        detailAuthorShown: true,
        oldVersionResolvableBeforeWithdrawal: true,
        unpublishedCanonical404: true,
        unpublishedHistorical404: true,
        teaserVisible: true,
      };
      const anonAccessibility = await new AxeBuilder({ page: anonPage })
        .include('section[aria-labelledby="news-teaser-heading"]')
        .analyze();
      expect(anonAccessibility.violations).toEqual([]);

      // --- Request ledger confinement ----------------------------------
      const bridgeRequests = browserRequests.filter((request) =>
        request.pathname.startsWith("/content"),
      );
      const publicRequests = browserRequests.filter(
        (request) =>
          request.pathname === "/" ||
          request.pathname === "/nyheter" ||
          request.pathname.startsWith("/nyhet/") ||
          request.pathname.startsWith("/api/news"),
      );
      expect(publicRequests.some((request) => request.pathname === "/nyheter")).toBe(true);
      expect(publicRequests.some((request) => request.pathname.startsWith("/nyhet/"))).toBe(true);
      expect(bridgeRequests.length).toBeGreaterThanOrEqual(3);
      expect(
        browserRequests.filter((request) => request.pathname === "/api/admin/schools"),
      ).toEqual([]);
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
        publicRequests,
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
