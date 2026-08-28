import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test, type Request } from "@playwright/test";

const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5194";
const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8800";
const nativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";
const evidencePath = process.env.RECRUITMENT_E2E_BROWSER_EVIDENCE_PATH;
const expectedLeaderPersonId =
  process.env.RECRUITMENT_E2E_LEADER_PERSON_ID ?? "journey-rec-leader-0049";

const leaderEmail = "lina.leader@example.invalid";
const leaderPassword = "journey-secret-0123456789abcdef";
const applicantName = "Sofie Søker";
const interviewerName = "Irene Intervjuer";
const interviewerOptions = ["Velg intervjuer", "Ida Intervjuer", interviewerName, "Lina Lagleder"];
const schemaOptionLabel = "Førstegangsintervju (8 spørsmål)";
const schemaOptions = ["Velg intervjuskjema", schemaOptionLabel];
const journeys = [
  {
    journeyRefId: "intent://journey:recruitment:applicant-assignment:v1",
    stepIds: [
      "mono-session-login",
      "load-applicant-list",
      "load-interviewer-options",
      "load-interview-schema-options",
      "assign-interview",
      "fresh-read-applicant-list",
    ],
  },
  {
    journeyRefId: "intent://journey:recruitment:review-applicants:v1",
    stepIds: ["mono-session-login", "list-current-applicants"],
  },
] as const;

const bridgeOperation = (request: Request): string | undefined => {
  if (new URL(request.url()).pathname !== "/recruitment" || request.method() !== "POST") {
    return undefined;
  }
  const payload: unknown = request.postDataJSON();
  return typeof payload === "object" &&
    payload !== null &&
    "operation" in payload &&
    typeof payload.operation === "string"
    ? payload.operation
    : undefined;
};

test.describe("Native recruitment assignment journey (spec 0049.2)", () => {
  test("leader signs in and assigns an applicant from the mandatory fresh read", async ({
    page,
  }) => {
    test.skip(!nativeIdentityMode, "requires the real native Identity topology");
    if (evidencePath === undefined || evidencePath.length === 0) {
      throw new Error("RECRUITMENT_E2E_BROWSER_EVIDENCE_PATH is required");
    }

    const bridgeRequests: Array<{
      operation: string;
      authorizationHeaderPresent: boolean;
    }> = [];
    const bridgeResponses: Array<{
      operation: string;
      status: number;
      authorizationHeaderPresent: boolean;
    }> = [];
    const legacyBrowserRequests: string[] = [];
    const externalBrowserRequests: string[] = [];
    const pageErrors: string[] = [];
    let rawAuthenticationLeak = false;

    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!["data:", "blob:"].includes(url.protocol) && url.origin !== dashboardOrigin) {
        externalBrowserRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      }
      const legacyPaths = [
        "/api/admin/applications",
        "/api/admin/users",
        "/api/admin/interviews/schemas",
        "/api/admin/interviews/assign",
      ];
      if (
        legacyPaths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))
      ) {
        legacyBrowserRequests.push(`${request.method()} ${url.pathname}${url.search}`);
      }
      const headers = request.headers();
      if (
        headers.authorization !== undefined ||
        headers.cookie?.split(";").some((value) => value.trim().startsWith("jwt_token="))
      ) {
        rawAuthenticationLeak = true;
      }
      const operation = bridgeOperation(request);
      if (operation !== undefined) {
        bridgeRequests.push({
          operation,
          authorizationHeaderPresent: headers.authorization !== undefined,
        });
      }
    });
    page.on("response", (response) => {
      const request = response.request();
      const operation = bridgeOperation(request);
      if (operation !== undefined) {
        bridgeResponses.push({
          operation,
          status: response.status(),
          authorizationHeaderPresent: request.headers().authorization !== undefined,
        });
      }
    });

    await page.goto("/login");
    await expect(page.getByLabel("E-post")).toBeVisible();
    await expect(page.getByLabel("Passord", { exact: true })).toBeVisible();
    await page.getByLabel("E-post").fill(leaderEmail);
    await page.getByLabel("Passord", { exact: true }).fill(leaderPassword);
    await page.getByRole("button", { name: "Logg inn" }).click();
    await page.waitForURL((url) => url.pathname === "/dashboard");

    const sessionCookies = (await page.context().cookies(dashboardOrigin)).filter(
      ({ name }) =>
        name === "better-auth.session_token" || name === "__Secure-better-auth.session_token",
    );
    expect(sessionCookies).toHaveLength(1);
    expect(sessionCookies[0]?.name).toBe("better-auth.session_token");
    expect(sessionCookies[0]?.value ?? "").not.toBe("");
    const sessionResponse = await page.context().request.get(`${apiOrigin}/api/me/session`);
    expect(sessionResponse.status()).toBe(200);
    const session: unknown = await sessionResponse.json();
    expect(session).toMatchObject({ personId: expectedLeaderPersonId });

    await page.goto("/dashboard/sokere");
    await expect(page).toHaveURL(/\/dashboard\/sokere$/);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Søkere" })).toBeVisible();

    const applicantRow = page
      .getByRole("row")
      .filter({ hasText: applicantName })
      .filter({ hasText: "Ikke tildelt" });
    await expect(applicantRow).toBeVisible();

    const newFilterResponse = page.waitForResponse(
      (response) => bridgeOperation(response.request()) === "readAssignmentBoard",
    );
    await page.getByRole("button", { name: "Nye søkere" }).click();
    expect((await newFilterResponse).status()).toBe(200);
    await expect(applicantRow).toBeVisible();

    await applicantRow
      .getByRole("button", { name: `Tildel intervju til ${applicantName}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const interviewerSelect = dialog.getByLabel("Intervjuer");
    const schemaSelect = dialog.getByLabel("Intervjuskjema");
    expect(await interviewerSelect.locator("option").allTextContents()).toEqual(interviewerOptions);
    expect(await schemaSelect.locator("option").allTextContents()).toEqual(schemaOptions);
    await interviewerSelect.selectOption({ label: interviewerName });
    await schemaSelect.selectOption({ label: schemaOptionLabel });
    await expect(interviewerSelect).toHaveValue("journey-rec-interviewer-a-0049");
    await expect(schemaSelect).toHaveValue("interview-schema-native-journey-0049");

    const assignResponse = page.waitForResponse(
      (response) => bridgeOperation(response.request()) === "assignApplicant",
    );
    const freshNewFilterResponse = page.waitForResponse(
      (response) =>
        bridgeOperation(response.request()) === "readAssignmentBoard" &&
        bridgeRequests.some(({ operation }) => operation === "assignApplicant"),
    );
    await dialog.getByRole("button", { name: "Tildel intervju", exact: true }).click();
    expect((await assignResponse).status()).toBe(200);
    expect((await freshNewFilterResponse).status()).toBe(200);

    await expect(
      page.getByRole("status").filter({ hasText: "Intervjuet er tildelt." }),
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(applicantRow).toHaveCount(0);

    const allFilterResponse = page.waitForResponse(
      (response) => bridgeOperation(response.request()) === "readAssignmentBoard",
    );
    await page.getByRole("button", { name: "Alle søkere" }).click();
    expect((await allFilterResponse).status()).toBe(200);
    const assignedRow = page
      .getByRole("row")
      .filter({ hasText: applicantName })
      .filter({ hasText: "Ikke kontaktet" });
    await expect(assignedRow).toBeVisible();
    await expect(assignedRow).toContainText(interviewerName);
    await expect(assignedRow).not.toContainText("Ikke tildelt");

    const accessibility = await new AxeBuilder({ page })
      .include('section[aria-labelledby="fr-page-title"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
    expect(bridgeRequests.map(({ operation }) => operation)).toEqual([
      "readAssignmentBoard",
      "assignApplicant",
      "readAssignmentBoard",
      "readAssignmentBoard",
    ]);
    expect(bridgeResponses).toEqual([
      { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
      { operation: "assignApplicant", status: 200, authorizationHeaderPresent: false },
      { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
      { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
    ]);
    expect(legacyBrowserRequests).toEqual([]);
    expect(externalBrowserRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(rawAuthenticationLeak).toBe(false);

    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        journeys,
        renderedNativeLogin: true,
        sessionCookieName: sessionCookies[0]?.name,
        sessionPersonId: expectedLeaderPersonId,
        bridgeResponses,
        transition: {
          applicantName,
          from: "Unassigned",
          to: "NoContact",
          visibleState: "Ikke kontaktet",
          assignedInterviewer: interviewerName,
          successStatusVisible: true,
          dialogClosed: true,
        },
        options: {
          interviewers: interviewerOptions.slice(1),
          schemas: schemaOptions.slice(1),
        },
        accessibilityViolations: accessibility.violations.length,
        legacyBrowserRequests,
        externalBrowserRequests,
        pageErrors,
        rawAuthenticationLeak,
      })}\n`,
      "utf8",
    );
  });
});
