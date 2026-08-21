import { expect, test, type Page, type Request } from "@playwright/test";

const leaderUsername = "recruitment-response-leader-0031";
const leaderPassword = "recruitment-response-e2e-0031";
const interviewerUsername = "recruitment-response-interviewer-0031";
const interviewerPassword = "recruitment-response-e2e-0031";

const cases = [
  {
    capability: "recruitment_response_0031_confirm",
    applicantName: "Søker Confirm 0031",
    operation: "confirmCandidate",
    actionLabel: "Bekreft intervjutid",
    resultHeading: "Intervjutiden er akseptert",
    leaderStatus: "Akseptert",
    schedulingStatus: "accepted",
  },
  {
    capability: "recruitment_response_0031_reject",
    applicantName: "Søker Reject 0031",
    operation: "rejectCandidate",
    actionLabel: "Avvis intervju",
    resultHeading: "Intervjuinvitasjonen er avvist",
    leaderStatus: "Avlyst",
    schedulingStatus: "cancelled",
    message: "Jeg kan ikke delta på dette tidspunktet.",
  },
  {
    capability: "recruitment_response_0031_new_time",
    applicantName: "Søker New-time 0031",
    operation: "requestNewTimeCandidate",
    actionLabel: "Be om nytt tidspunkt",
    resultHeading: "Nytt tidspunkt er ønsket",
    leaderStatus: "Ønsker nytt tidspunkt",
    schedulingStatus: "request_new_time",
    message: "Kan vi møtes torsdag i stedet?",
  },
] as const;

function bridgeOperation(request: Request): string | null {
  try {
    const body = request.postDataJSON();
    if (typeof body !== "object" || body === null || !("operation" in body)) return null;
    return typeof body.operation === "string" ? body.operation : null;
  } catch {
    return null;
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Brukernavn eller e-post").fill(username);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:$|\/)/);
}

async function readOperation(page: Page): Promise<void> {
  const response = await page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/interview" &&
      bridgeOperation(candidate.request()) === "readCandidate",
  );
  expect(response.status()).toBe(200);
}

test.describe("Real Symfony interview invitation response", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("applicant confirms, rejects, and requests a new time with fresh observer reads", async ({
    browser,
    page,
  }) => {
    test.skip(
      process.env.REAL_SYMFONY_INTERVIEW_RESPONSE_E2E !== "1",
      "requires the real Symfony invitation response runner",
    );
    expect(process.env.REAL_SYMFONY_INTERVIEW_RESPONSE_E2E).toBe("1");
    expect(process.env.API_MODE).not.toBe("fixture");
    expect(process.env.VITE_API_MODE).not.toBe("fixture");

    await login(page, leaderUsername, leaderPassword);

    for (const responseCase of cases) {
      const candidateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const candidatePage = await candidateContext.newPage();
      await candidatePage.goto(`/interview-response/${responseCase.capability}`, { waitUntil: "networkidle" });
      await expect(candidatePage).toHaveURL(/\/interview-response\/redacted$/);
      await expect(candidatePage.getByRole("heading", { name: "Svar på intervjutid", exact: true })).toBeVisible();
      await expect(candidatePage.getByText("Rom 31", { exact: false })).toBeVisible();
      await expect(candidatePage.getByText("Gløshaugen", { exact: true })).toBeVisible();
      await expect(candidatePage.locator("body")).not.toContainText(responseCase.capability);

      if ("message" in responseCase) {
        await candidatePage.getByLabel("Melding", { exact: true }).fill(responseCase.message);
      }
      const actionResponse = candidatePage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/interview" &&
          bridgeOperation(response.request()) === responseCase.operation,
      );
      const freshRead = readOperation(candidatePage);
      await candidatePage.getByRole("button", { name: responseCase.actionLabel, exact: true }).click();
      const observedActionResponse = await actionResponse;
      expect(observedActionResponse.status(), await observedActionResponse.text()).toBe(200);
      await freshRead;
      await expect(candidatePage.getByRole("heading", { name: responseCase.resultHeading, exact: true })).toBeVisible();
      await expect(candidatePage.locator("body")).not.toContainText(responseCase.capability);
      await candidateContext.close();
    }

    await page.goto("/dashboard/foldkit", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Planlegg intervjuer", exact: true })).toBeVisible();
    for (const responseCase of cases) {
      const card = page.getByRole("article").filter({ hasText: responseCase.applicantName });
      if (responseCase.operation === "rejectCandidate") {
        await expect(card).toHaveCount(0);
      } else {
        await expect(card).toContainText(responseCase.leaderStatus);
      }
    }

    // The migrated React application projection is the authoritative cancelled read.
    await page.goto("/dashboard/sokere?status=cancelled", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Søkere", exact: true })).toBeVisible();
    const cancelledApplication = page.getByRole("row").filter({ hasText: "Søker Reject 0031" });
    await expect(cancelledApplication).toContainText("Kansellert");
    await expect(page.locator("body")).not.toContainText("recruitment_response_0031_reject");

    // The migrated interviewer route exposes the existing team-member department projection.
    // Every fixture interview is assigned to this account; the route itself is not per-user filtered.
    const interviewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const interviewerPage = await interviewerContext.newPage();
    await login(interviewerPage, interviewerUsername, interviewerPassword);
    await interviewerPage.goto("/dashboard/intervjuer", { waitUntil: "networkidle" });
    for (const responseCase of cases) {
      const row = interviewerPage.getByRole("row").filter({ hasText: responseCase.applicantName });
      if (responseCase.operation === "rejectCandidate") {
        await expect(row).toHaveCount(0);
      } else {
        await expect(row).toContainText(responseCase.schedulingStatus);
      }
    }
    await interviewerContext.close();
  });
});
