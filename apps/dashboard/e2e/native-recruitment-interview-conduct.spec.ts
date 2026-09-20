import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";

const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";
const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8799";
const enabled = process.env.REAL_NATIVE_CONDUCT_E2E === "1";
const applicantA = process.env.CONDUCT_E2E_APPLICANT_A ?? "Sofie Gjennomfører";
const applicantB = process.env.CONDUCT_E2E_APPLICANT_B ?? "Olav Konflikt";
const leaderEmail = process.env.CONDUCT_E2E_LEADER_EMAIL ?? "lina.conduct@example.invalid";
const leaderPassword =
  process.env.CONDUCT_E2E_LEADER_PASSWORD ?? "journey-conduct-secret-0123456789";
const applicantEmail = process.env.CONDUCT_E2E_APPLICANT_EMAIL ?? "sofie.conduct@example.invalid";
const applicantPassword =
  process.env.CONDUCT_E2E_APPLICANT_PASSWORD ?? "journey-conduct-applicant-secret-0123456789";
const evidencePath = process.env.CONDUCT_E2E_BROWSER_EVIDENCE_PATH;
const screenshotDirectory = process.env.CONDUCT_E2E_SCREENSHOT_DIRECTORY;
const questionPrefix = "interview-schema-native-conduct-0063-";
const questionIds = {
  text: `${questionPrefix}q0`,
  list: `${questionPrefix}q1`,
  radio: `${questionPrefix}q2`,
  check: `${questionPrefix}q3`,
} as const;

type Operation = { readonly operation: string; readonly pathname: string; readonly method: string };

const operationFor = (request: Request): string | undefined => {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/recruitment")
    return undefined;
  try {
    const payload: unknown = request.postDataJSON();
    return typeof payload === "object" &&
      payload !== null &&
      "operation" in payload &&
      typeof payload.operation === "string"
      ? payload.operation
      : undefined;
  } catch {
    return undefined;
  }
};

const observe = (
  context: BrowserContext,
  pageErrors: string[],
  operations: Operation[],
  browserRequests: string[],
) => {
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") || /^\/interview(?:$|\/)/u.test(url.pathname))
      browserRequests.push(url.pathname);
    const operation = operationFor(request);
    if (operation !== undefined)
      operations.push({ operation, pathname: url.pathname, method: request.method() });
  });
  context.on("page", (page) => {
    page.on("pageerror", (error) => pageErrors.push(error.message));
  });
};

const signIn = async (
  page: Page,
  email: string = leaderEmail,
  password: string = leaderPassword,
) => {
  await page.goto("/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn" }).click();
  try {
    await page.waitForURL(/\/dashboard\/?$/, { timeout: 15_000 });
  } catch (error) {
    throw new Error(
      `native login did not redirect: ${page.url()} ${await page.locator("body").innerText()}`,
      {
        cause: error,
      },
    );
  }
};

const assertNoApplicantPrivateFields = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) assertNoApplicantPrivateFields(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(/email|phone|recommendation|answers|capability|interviewer|score/iu);
    assertNoApplicantPrivateFields(child);
  }
};

const cardFor = (page: Page, name: string) => page.getByRole("article").filter({ hasText: name });
const responseFor = (page: Page, operation: string) =>
  page.waitForResponse((response) => operationFor(response.request()) === operation);

const fillAnswersAndScores = async (page: Page) => {
  await page
    .locator(`#question-${questionIds.text}`)
    .fill("Jeg liker å bygge gode løsninger sammen med andre.");
  await page.locator(`#question-${questionIds.list}-1`).check();
  await page.locator(`#question-${questionIds.radio}-0`).check();
  await page.locator(`#question-${questionIds.check}-0`).check();
  await page.locator(`#question-${questionIds.check}-2`).check();
  await page.locator("#score-explanatoryPower").selectOption("7");
  await page.locator("#score-roleModel").selectOption("8");
  await page.locator("#score-suitability").selectOption("9");
  await page.locator("#interviewer-recommendation").selectOption("Ja");
};

const openConduct = async (page: Page, applicant: string) => {
  const card = cardFor(page, applicant);
  await expect(card).toContainText("Planlagt");
  await expect(card).toContainText("Akseptert");
  const read = responseFor(page, "readInterviewConduct");
  await card.getByRole("button", { name: "Åpne intervju" }).click();
  const response = await read;
  expect(response.status()).toBe(200);
  await expect(page.getByRole("heading", { name: `Intervju med ${applicant}` })).toBeVisible();
  await expect(
    page.getByText("1. Fortell kort om motivasjonen din.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2. Hvilket arbeidsområde interesserer deg mest?", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("3. Hvordan foretrekker du å lære?", { exact: true })).toBeVisible();
  await expect(page.getByText("4. Hvilke styrker tar du med deg?", { exact: true })).toBeVisible();
  return card;
};

test.describe("Native recruitment interview conduct (spec 0063)", () => {
  test("logs in natively, finalizes after fresh reads, rejects a stale concurrent submit, and cancels a second interview", async ({
    browser,
  }) => {
    test.skip(!enabled, "run through the disposable native conduct runner");
    test.setTimeout(60_000);
    if (evidencePath === undefined || evidencePath.length === 0)
      throw new Error("CONDUCT_E2E_BROWSER_EVIDENCE_PATH is required");

    const operations: Operation[] = [];
    const pageErrors: string[] = [];
    const browserRequests: string[] = [];
    let firstContextClosed = false;
    let applicantProgressObserved = false;
    let accessibilityViolations = 0;

    const firstContext = await browser.newContext({
      baseURL: dashboardOrigin,
      viewport: { width: 1440, height: 900 },
    });
    observe(firstContext, pageErrors, operations, browserRequests);
    const page = await firstContext.newPage();
    let staleContext: BrowserContext | undefined;
    let applicantContext: BrowserContext | undefined;
    try {
      await signIn(page);
      await expect(page.context().cookies()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "better-auth.session_token" })]),
      );
      await page.goto("/dashboard/intervjuer");
      await expect(
        page.getByRole("heading", { level: 1, name: "Planlegg intervjuer" }),
      ).toBeVisible();
      await expect(cardFor(page, applicantA)).toContainText("Lina Lagleder");
      await openConduct(page, applicantA);

      // Local validation rejects an incomplete form without opening confirmation or issuing POST.
      const beforeIncomplete = operations.length;
      await page.getByRole("button", { name: "Fullfør intervju" }).click();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "Svar på alle spørsmål, velg alle tre scorer og en anbefaling." }),
      ).toBeVisible();
      expect(operations.length).toBe(beforeIncomplete);
      await fillAnswersAndScores(page);

      // Keep an independent revision-1 detail open while the first context finalizes.
      staleContext = await browser.newContext({
        baseURL: dashboardOrigin,
        viewport: { width: 1440, height: 900 },
      });
      observe(staleContext, pageErrors, operations, browserRequests);
      const stalePage = await staleContext.newPage();
      await signIn(stalePage);
      await stalePage.goto("/dashboard/intervjuer");
      await openConduct(stalePage, applicantA);
      await fillAnswersAndScores(stalePage);

      const freshConduct = responseFor(page, "readInterviewConduct");
      const freshBoard = responseFor(page, "readSchedulingBoard");
      const finalizePost = responseFor(page, "finalizeInterview");
      await page.getByRole("button", { name: "Fullfør intervju" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const confirm = dialog.getByRole("button", { name: "Fullfør intervju", exact: true });
      await expect(confirm).toBeFocused();
      await confirm.press("Enter");
      const [postResponse, conductResponse, boardResponse] = await Promise.all([
        finalizePost,
        freshConduct,
        freshBoard,
      ]);
      expect(postResponse.status()).toBe(200);
      expect(conductResponse.status()).toBe(200);
      expect(boardResponse.status()).toBe(200);
      await expect(page.getByText("Intervjuet er fullført.")).toBeVisible();
      await expect(page.getByText("Completed", { exact: true })).toBeVisible();
      await expect(page.locator(`#question-${questionIds.text}`)).toHaveValue(
        "Jeg liker å bygge gode løsninger sammen med andre.",
      );

      const detailAxe = await new AxeBuilder({ page })
        .include('section[aria-labelledby="fs-page-title"]')
        .analyze();
      accessibilityViolations += detailAxe.violations.length;

      // A real reload starts from the native session and reads the persisted terminal detail again.
      await page.reload();
      await expect(
        page.getByRole("heading", { level: 1, name: "Planlegg intervjuer" }),
      ).toBeVisible();
      await openConduct(page, applicantA);
      await expect(page.getByText("Completed", { exact: true })).toBeVisible();
      await expect(page.locator(`#question-${questionIds.text}`)).toHaveValue(
        "Jeg liker å bygge gode løsninger sammen med andre.",
      );
      if (screenshotDirectory !== undefined) {
        await mkdir(screenshotDirectory, { recursive: true });
        await page.screenshot({
          path: join(screenshotDirectory, "interview-completion-desktop.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByText("Intervjuet er fullført.")).toBeVisible();
        await expect(page.getByText("Completed", { exact: true })).toBeVisible();
        expect(
          await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
        ).toBe(true);
        const mobileAxe = await new AxeBuilder({ page })
          .include('section[aria-labelledby="fs-page-title"]')
          .analyze();
        accessibilityViolations += mobileAxe.violations.length;
        await page.screenshot({
          path: join(screenshotDirectory, "interview-completion-mobile.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 900 });
      }

      applicantContext = await browser.newContext({
        baseURL: dashboardOrigin,
        viewport: { width: 1440, height: 900 },
      });
      observe(applicantContext, pageErrors, operations, browserRequests);
      const applicantPage = await applicantContext.newPage();
      await signIn(applicantPage, applicantEmail, applicantPassword);
      const applicantProgress = await applicantContext.request.get(
        `${apiOrigin}/api/applicant-progress`,
        { headers: { origin: dashboardOrigin } },
      );
      await applicantPage.goto("/dashboard/soknad");
      expect(applicantProgress.status()).toBe(200);
      const applicantProgressBody: unknown = await applicantProgress.json();
      assertNoApplicantPrivateFields(applicantProgressBody);
      expect(JSON.stringify(applicantProgressBody)).toContain('"InterviewCompleted"');
      await expect(
        applicantPage.getByRole("heading", { name: "Min søknad", exact: true }),
      ).toBeVisible();
      await expect(
        applicantPage.getByRole("heading", { name: "Intervjuet er fullført", exact: true }),
      ).toBeVisible();
      await expect(applicantPage.locator("body")).not.toContainText(
        "Jeg liker å bygge gode løsninger sammen med andre.",
      );
      await expect(applicantPage.locator("body")).not.toContainText("lina.conduct@example.invalid");
      await expect(applicantPage.locator("body")).not.toContainText("90000063");
      await applicantPage.reload();
      await expect(
        applicantPage.getByRole("heading", { name: "Intervjuet er fullført", exact: true }),
      ).toBeVisible();
      const applicantAxe = await new AxeBuilder({ page: applicantPage }).analyze();
      accessibilityViolations += applicantAxe.violations.length;
      applicantProgressObserved = true;

      // The independent revision-1 submit loses to the committed finalization.
      const stalePost = responseFor(stalePage, "finalizeInterview");
      await stalePage.getByRole("button", { name: "Fullfør intervju" }).click();
      await stalePage
        .getByRole("dialog")
        .getByRole("button", { name: "Fullfør intervju", exact: true })
        .click();
      const staleResponse = await stalePost;
      await expect(staleResponse.json()).resolves.toEqual({
        _tag: "Conflict",
        message: "Recruitment state has changed",
      });
      expect(staleResponse.status()).toBe(409);
      await expect(
        stalePage.getByRole("alert").filter({
          hasText:
            "Intervjuet er endret. Utkastet er beholdt; åpne intervjuet på nytt for å hente gjeldende versjon.",
        }),
      ).toBeVisible();
      await expect(stalePage.locator(".fs-conduct")).toHaveCount(1);
      await expect(stalePage.locator("#interviewer-recommendation")).toHaveValue("Ja");

      const pageAxe = await new AxeBuilder({ page })
        .include('section[aria-labelledby="fs-page-title"]')
        .analyze();
      accessibilityViolations += pageAxe.violations.length;
    } finally {
      await staleContext?.close();
      await applicantContext?.close();
      await firstContext.close();
      firstContextClosed = true;
    }

    // A new context signs in through /login and independently cancels the second interview.
    const independentContext = await browser.newContext({
      baseURL: dashboardOrigin,
      viewport: { width: 1440, height: 900 },
    });
    observe(independentContext, pageErrors, operations, browserRequests);
    const independentPage = await independentContext.newPage();
    try {
      await signIn(independentPage);
      await independentPage.goto("/dashboard/intervjuer");
      await openConduct(independentPage, applicantB);

      const cancelPost = responseFor(independentPage, "cancelInterview");
      const freshConduct = responseFor(independentPage, "readInterviewConduct");
      const freshBoard = responseFor(independentPage, "readSchedulingBoard");
      await independentPage.getByRole("button", { name: "Avlys intervju", exact: true }).click();
      const cancelDialog = independentPage.getByRole("dialog");
      await expect(cancelDialog).toBeVisible();
      const cancelConfirm = cancelDialog.getByRole("button", {
        name: "Avlys intervju",
        exact: true,
      });
      await expect(cancelConfirm).toBeFocused();
      await cancelConfirm.press("Enter");
      const [cancelResponse, cancelledConductResponse, cancelledBoardResponse] = await Promise.all([
        cancelPost,
        freshConduct,
        freshBoard,
      ]);
      expect(cancelResponse.status()).toBe(200);
      expect(cancelledConductResponse.status()).toBe(200);
      expect(cancelledBoardResponse.status()).toBe(200);
      await expect(independentPage.getByText("Intervjuet er avlyst.")).toBeVisible();
      await expect(independentPage.getByText("Cancelled", { exact: true })).toBeVisible();

      // A real reload starts from the native session and reads the persisted cancellation again.
      await independentPage.reload();
      await expect(
        independentPage.getByRole("heading", { level: 1, name: "Planlegg intervjuer" }),
      ).toBeVisible();
      await openConduct(independentPage, applicantB);
      await expect(independentPage.getByText("Cancelled", { exact: true })).toBeVisible();
      await expect(independentPage.locator("body")).not.toContainText("responseCapability");
      await expect(independentPage.locator("body")).not.toContainText("responseCode");
      await expect(independentPage.locator("body")).not.toContainText(
        "olav.conduct@example.invalid",
      );
      await expect(independentPage.locator("body")).not.toContainText("90000064");
      const independentAxe = await new AxeBuilder({ page: independentPage })
        .include('section[aria-labelledby="fs-page-title"]')
        .analyze();
      accessibilityViolations += independentAxe.violations.length;
    } finally {
      await independentContext.close();
    }

    const legacyBrowserRequests = browserRequests.filter((entry) =>
      /\/interview(?:$|\/)|\/api\/admin\/interviews|responseCode|responseCapability/u.test(entry),
    );
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join("; ")}`);
    expect(legacyBrowserRequests).toEqual([]);
    expect(accessibilityViolations).toBe(0);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({ firstContextClosed, independentContextPersisted: true, applicantProgressObserved, accessibilityViolations, pageErrors, operations, legacyBrowserRequests, nativeLogin: true, rawCapabilityObserved: false }, null, 2)}\n`,
    );
  });
});
