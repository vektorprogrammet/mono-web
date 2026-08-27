import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";
const REAL_NATIVE_SCHEDULING_E2E = process.env.REAL_NATIVE_SCHEDULING_E2E === "1";
const SCHEDULE = {
  scheduledAt: "2031-09-20T13:30:00.000Z",
  room: "K-101",
  campus: "Gløshaugen",
  mapLink: "https://maps.example.invalid/native-scheduling-0050",
  message: "Vi ser frem til intervjuet.",
} as const;

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the native scheduling journey`);
  }
  return value;
};

const authenticate = async (
  page: Page,
  emailEnvironment: string,
  passwordEnvironment: string,
): Promise<ReadonlyArray<string>> => {
  await page.goto("/login");
  await page.getByLabel("E-post").fill(requiredEnvironment(emailEnvironment));
  await page.getByLabel("Passord").fill(requiredEnvironment(passwordEnvironment));
  await page.getByRole("button", { name: "Logg inn" }).click();
  try {
    await page.waitForURL(/\/dashboard\/?$/, { timeout: 5_000 });
  } catch (error) {
    throw new Error(
      `native login did not redirect: ${page.url()} ${await page.locator("body").innerText()}`,
      { cause: error },
    );
  }
  const sessionCookieNames = (await page.context().cookies(DASHBOARD_ORIGIN))
    .filter(
      ({ name }) =>
        name === "better-auth.session_token" || name === "__Secure-better-auth.session_token",
    )
    .map(({ name }) => name)
    .sort();
  if (sessionCookieNames.length === 0) {
    throw new Error("native login did not issue a Better Auth session cookie");
  }
  return sessionCookieNames;
};

const bridgeOperation = (request: Request): string | undefined => {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/recruitment") {
    return undefined;
  }
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

const applicantCard = (page: Page, applicantName: string) =>
  page.getByRole("article").filter({ hasText: applicantName });

test.describe("Native recruitment interview scheduling", () => {
  test.skip(!REAL_NATIVE_SCHEDULING_E2E, "run through the disposable native scheduling runner");

  test("schedules through Foldkit, refreshes, and survives an independent browser context", async ({
    browser,
  }) => {
    const applicantName = requiredEnvironment("SCHEDULING_E2E_APPLICANT_NAME");
    const interviewerName = requiredEnvironment("SCHEDULING_E2E_INTERVIEWER_NAME");
    const evidencePath = requiredEnvironment("SCHEDULING_E2E_BROWSER_EVIDENCE_PATH");
    const bridgeOperations: string[] = [];
    const legacyBrowserRequests: string[] = [];
    const bearerRequests: string[] = [];
    const pageErrors: string[] = [];
    const observeRequests = (page: Page): void => {
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        const operation = bridgeOperation(request);
        if (request.headers().authorization?.startsWith("Bearer ")) {
          bearerRequests.push(pathname);
        }
        if (operation !== undefined) bridgeOperations.push(operation);
        if (
          pathname === "/interview" ||
          pathname.startsWith("/api/admin/interviews") ||
          ["listInterviews", "readInterview"].includes(operation ?? "")
        ) {
          legacyBrowserRequests.push(`${request.method()} ${pathname} ${operation ?? ""}`.trim());
        }
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
    };

    const firstContext = await browser.newContext({
      baseURL: DASHBOARD_ORIGIN,
      viewport: { width: 1440, height: 900 },
    });
    let firstContextClosed = false;
    let leaderSessionCookieNames: ReadonlyArray<string> = [];
    try {
      const page = await firstContext.newPage();
      observeRequests(page);
      leaderSessionCookieNames = await authenticate(
        page,
        "SCHEDULING_E2E_LEADER_EMAIL",
        "SCHEDULING_E2E_LEADER_PASSWORD",
      );
      await page.goto("/dashboard/intervjuer");

      await expect(page).toHaveURL(`${DASHBOARD_ORIGIN}/dashboard/intervjuer`);
      await expect(page.getByRole("main")).toHaveCount(1);
      await expect(
        page.getByRole("heading", { level: 1, name: "Planlegg intervjuer" }),
      ).toBeVisible();
      const card = applicantCard(page, applicantName);
      await expect(card).toContainText(`Intervjuer: ${interviewerName}`);
      await expect(card).toContainText("Ikke planlagt");
      await card.getByRole("button", { name: "Planlegg intervju" }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("heading", { name: `Planlegg intervju med ${applicantName}` }),
      ).toBeVisible();
      await dialog.getByLabel("Tidspunkt").fill(SCHEDULE.scheduledAt);
      await dialog.getByLabel("Rom").fill(SCHEDULE.room);
      await dialog.getByLabel("Campus").fill(SCHEDULE.campus);
      await dialog.getByLabel("Kartlenke").fill(SCHEDULE.mapLink);
      await dialog.getByLabel("Melding").fill(SCHEDULE.message);

      const scheduleResponse = page.waitForResponse(
        (response) => bridgeOperation(response.request()) === "scheduleInterview",
      );
      const freshBoardResponse = page.waitForResponse(
        (response) => bridgeOperation(response.request()) === "readSchedulingBoard",
      );
      await dialog.getByRole("button", { name: "Lagre og legg i kø" }).click();
      const [scheduled, refreshed] = await Promise.all([scheduleResponse, freshBoardResponse]);
      expect(scheduled.status()).toBe(200);
      expect(refreshed.status()).toBe(200);
      expect(await scheduled.text()).not.toContain("responseCapability");
      expect(await refreshed.text()).not.toContain("responseCapability");

      await expect(
        page.getByRole("status").filter({
          hasText: "Intervjuet er planlagt. Invitasjonen er lagt i kø for sending.",
        }),
      ).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(card).toContainText("Planlagt");
      await expect(card).toContainText(SCHEDULE.room);
      await expect(card).toContainText(SCHEDULE.campus);
      await expect(card).toContainText(SCHEDULE.mapLink);
      await expect(card).toContainText("Venter på svar");
      await expect(card).toContainText("Lagt i kø");
      expect(bridgeOperations).toEqual(["scheduleInterview", "readSchedulingBoard"]);
      expect(legacyBrowserRequests).toEqual([]);
      expect(await page.locator("body").innerText()).not.toContain("responseCapability");

      const accessibility = await new AxeBuilder({ page })
        .include('section[aria-labelledby="fs-page-title"]')
        .analyze();
      expect(accessibility.violations).toEqual([]);
    } finally {
      await firstContext.close();
      firstContextClosed = true;
    }

    const verificationContext = await browser.newContext({
      baseURL: DASHBOARD_ORIGIN,
      viewport: { width: 1440, height: 900 },
    });
    let interviewerSessionCookieNames: ReadonlyArray<string> = [];
    try {
      const page = await verificationContext.newPage();
      observeRequests(page);
      interviewerSessionCookieNames = await authenticate(
        page,
        "SCHEDULING_E2E_INTERVIEWER_EMAIL",
        "SCHEDULING_E2E_INTERVIEWER_PASSWORD",
      );
      await page.goto("/dashboard/intervjuer");

      const persistedCard = applicantCard(page, applicantName);
      await expect(persistedCard).toContainText(`Intervjuer: ${interviewerName}`);
      await expect(persistedCard).toContainText("Planlagt");
      await expect(persistedCard).toContainText(SCHEDULE.room);
      await expect(persistedCard).toContainText(SCHEDULE.campus);
      await expect(persistedCard).toContainText(SCHEDULE.mapLink);
      await expect(persistedCard).toContainText("Venter på svar");
      await expect(persistedCard).toContainText("Lagt i kø");
      await expect(persistedCard.getByRole("button", { name: "Planlegg intervju" })).toHaveCount(0);
      expect(bridgeOperations).toEqual(["scheduleInterview", "readSchedulingBoard"]);
      expect(legacyBrowserRequests).toEqual([]);
      expect(await page.locator("body").innerText()).not.toContain("responseCapability");
      expect(pageErrors).toEqual([]);
      expect(bearerRequests).toEqual([]);
    } finally {
      await verificationContext.close();
    }

    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        firstContextClosed,
        independentContextPersisted: true,
        nativeActors: ["DepartmentLeader", "Member"],
        bridgeOperations,
        legacyBrowserRequests,
        sessionCookieNames: {
          leader: leaderSessionCookieNames,
          interviewer: interviewerSessionCookieNames,
        },
        bearerTokenInjected: bearerRequests.length > 0,
        expectedSchedule: SCHEDULE,
        accessibilityViolations: 0,
        pageErrors,
        rawCapabilityObserved: false,
      })}\n`,
      "utf8",
    );
  });
});
