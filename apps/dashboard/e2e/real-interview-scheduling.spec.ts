import { expect, test, type Page } from "@playwright/test";

const leaderUsername = "recruitment-leader-0029";
const leaderPassword = "recruitment-e2e-0029";
const interviewerUsername = "recruitment-interviewer-0029";
const interviewerPassword = "recruitment-e2e-0029";
const applicantName = "Søker 0029";
const responseCapability = "recruitment-response-0029";
const schedule = {
  datetime: "2026-09-14T15:00:00+02:00",
  room: "Rom 29",
  campus: "E2E campus",
  mapLink: "https://maps.example.invalid/interview-0029",
  from: "recruitment-interviewer-0029@example.invalid",
  to: "recruitment-applicant-0029@example.invalid",
  message: "Vi ser frem til intervjuet.",
};

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Vektorprogrammet", exact: true })).toBeVisible();
  await page.getByLabel("Brukernavn eller e-post").fill(username);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:$|\/)/);
}

async function openInterviewDashboard(page: Page): Promise<void> {
  await page.goto("/dashboard/foldkit", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Planlegg intervjuer", exact: true })).toBeVisible();
}

test.describe("Real Symfony interview scheduling", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("leader schedules, candidate accepts, and interviewer reads fresh accepted state", async ({
    browser,
    page,
  }) => {
    test.skip(
      process.env.REAL_SYMFONY_INTERVIEW_SCHEDULING_E2E !== "1",
      "requires the real Symfony interview scheduling runner",
    );
    expect(process.env.REAL_SYMFONY_INTERVIEW_SCHEDULING_E2E).toBe("1");
    expect(process.env.API_MODE).not.toBe("fixture");
    expect(process.env.VITE_API_MODE).not.toBe("fixture");

    await login(page, leaderUsername, leaderPassword);
    await openInterviewDashboard(page);

    const applicantCard = page.getByRole("article").filter({ hasText: applicantName });
    await expect(applicantCard).toBeVisible();
    await applicantCard.getByRole("button", { name: "Planlegg intervju", exact: true }).click();

    await page.getByLabel("Tidspunkt", { exact: true }).fill(schedule.datetime);
    await page.getByLabel("Rom", { exact: true }).fill(schedule.room);
    await page.getByLabel("Campus", { exact: true }).fill(schedule.campus);
    await page.getByLabel("Kartlenke", { exact: true }).fill(schedule.mapLink);
    await page.getByLabel("Avsender", { exact: true }).fill(schedule.from);
    await page.getByLabel("Mottaker", { exact: true }).fill(schedule.to);
    await page.getByLabel("Melding", { exact: true }).fill(schedule.message);

    const scheduleRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.match(/^\/api\/admin\/interviews\/\d+\/schedule$/) !== null,
    );
    const scheduleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.match(/^\/api\/admin\/interviews\/\d+\/schedule$/) !== null,
    );
    await page.getByRole("button", { name: "Lagre og send", exact: true }).click();
    const [request, response] = await Promise.all([scheduleRequest, scheduleResponse]);
    expect(request.postDataJSON()).toEqual(schedule);
    expect(response.status()).toBe(204);

    await expect(page.getByText("Intervjuet er planlagt og invitert.", { exact: true })).toBeVisible();
    await expect(applicantCard).toContainText("Invitert");
    await expect(applicantCard).toContainText(schedule.datetime);
    await expect(applicantCard).toContainText(schedule.room);
    await expect(applicantCard).toContainText(schedule.campus);

    const candidateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const candidatePage = await candidateContext.newPage();
    await candidatePage.goto(`/interview-response/${responseCapability}`, { waitUntil: "networkidle" });
    await expect(candidatePage).toHaveURL(/\/interview-response\/redacted$/);
    await expect(candidatePage.getByRole("heading", { name: "Svar på intervjutid", exact: true })).toBeVisible();
    await expect(candidatePage.getByText(schedule.room, { exact: true })).toBeVisible();
    await expect(candidatePage.getByText(schedule.campus, { exact: true })).toBeVisible();
    await candidatePage.getByRole("button", { name: "Aksepter intervjutid", exact: true }).click();
    await expect(candidatePage.getByRole("heading", { name: "Intervjutiden er akseptert", exact: true })).toBeVisible();
    await candidateContext.close();

    const interviewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const interviewerPage = await interviewerContext.newPage();
    await login(interviewerPage, interviewerUsername, interviewerPassword);
    const freshRead = interviewerPage.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/interview",
    );
    await openInterviewDashboard(interviewerPage);
    expect((await freshRead).status()).toBe(200);
    const freshCard = interviewerPage.getByRole("article").filter({ hasText: applicantName });
    await expect(freshCard).toContainText("Akseptert");
    await expect(freshCard).toContainText(schedule.datetime);
    await expect(freshCard).toContainText(schedule.room);
    await expect(freshCard).toContainText(schedule.campus);
    await interviewerContext.close();
  });
});
