import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { z } from "zod";

const DASHBOARD_ORIGIN =
  process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5173";
const FIXTURE_ORIGIN =
  process.env.API_URL ?? "http://127.0.0.1:8790";
const DEPARTMENT_ID = "dep-trd-1";
const SEMESTER_ID = "sem-2026-høst";
const INTERVIEW_ID = "interview-001";
const VALID_TIME = "2026-09-14T15:00:00+02:00";
const VALID_ROOM = "Rom 2";
const VALID_CAMPUS = "Gløshaugen";
const LEADER_SESSION = "fixture-leader-session";
const INTERVIEWER_SESSION = "fixture-interviewer-session";
const MEMBER_SESSION = "fixture-member-session";
const BERGEN_SESSION = "fixture-bergen-session";
const INTERVIEW_FIXTURE_CONTROL_KEY =
  process.env.INTERVIEW_FIXTURE_CONTROL_KEY ??
  "foldkit-interview-control-key-0021-local-only";

const dashboardOriginUrl = new URL(DASHBOARD_ORIGIN);
const fixtureOriginUrl = new URL(FIXTURE_ORIGIN);

const candidatePrivacyTerms = [
  "Applicant One",
  "app-001",
  "interviewer-trondheim@example.invalid",
  "Trondheim",
  "Høst 2026",
];

const evidenceRequestSchema = z.object({
  method: z.string(),
  operation: z.string(),
  actor: z.string(),
  status: z.number().int(),
  identifiers: z.record(z.string()),
  bodyKeys: z.array(z.string()),
});
const evidenceSchema = z.object({
  seed: z.literal("foldkit-interview-0021"),
  requests: z.array(evidenceRequestSchema),
  transitions: z.array(z.string()),
});
type Evidence = z.infer<typeof evidenceSchema>;

const assignedStateSchema = z.object({
  schedulingStatus: z.string(),
});

type FixtureControl =
  | "expired"
  | "missing"
  | "cancelled"
  | "no_contact"
  | "conducted"
  | "wrong-cycle"
  | "unknown-interview";

type BrowserSeamObservation = {
  bridgeRequests: number;
  directFixtureRequests: number;
};

function actorHeaders(session: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${session}`,
  };
}

function fixtureControlHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Interview-Fixture-Control": INTERVIEW_FIXTURE_CONTROL_KEY,
  };
}

function observeBrowserSeam(
  page: Page,
  observation: BrowserSeamObservation,
): void {
  page.on("request", (event) => {
    const url = new URL(event.url());
    if (url.origin === fixtureOriginUrl.origin) observation.directFixtureRequests += 1;
    if (
      url.origin === dashboardOriginUrl.origin &&
      url.pathname === "/interview"
    ) {
      observation.bridgeRequests += 1;
    }
  });
}

async function resetFixture(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_ORIGIN}/__interview_fixture/reset`,
    { headers: fixtureControlHeaders() },
  );
  expect(response.status()).toBe(204);
}

async function controlFixture(
  request: APIRequestContext,
  state: FixtureControl,
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_ORIGIN}/__interview_fixture/control`,
    {
      headers: fixtureControlHeaders(),
      data: { state },
    },
  );
  expect(response.status()).toBe(204);
}

async function responsePath(request: APIRequestContext): Promise<string> {
  const response = await request.get(
    `${FIXTURE_ORIGIN}/__interview_fixture/response-url`,
    { headers: fixtureControlHeaders() },
  );
  expect(response.status()).toBe(200);
  const body = z.object({ url: z.string().startsWith("/interview-response/") }).parse(
    await response.json(),
  );
  return body.url;
}

async function readEvidence(request: APIRequestContext): Promise<Evidence> {
  const response = await request.get(
    `${FIXTURE_ORIGIN}/__interview_fixture/evidence`,
    { headers: fixtureControlHeaders() },
  );
  expect(response.status()).toBe(200);
  return evidenceSchema.parse(await response.json());
}

async function addSessionCookie(
  context: BrowserContext,
  session: string,
): Promise<void> {
  await context.addCookies([
    {
      name: "fixture_session",
      value: session,
      url: DASHBOARD_ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function openDashboard(page: Page): Promise<void> {
  await page.goto(`${DASHBOARD_ORIGIN}/dashboard/foldkit`);
  await expect(
    page.getByRole("heading", { name: "Planlegg intervjuer", exact: true }),
  ).toBeVisible();
}

async function selectCycle(page: Page): Promise<void> {
  const department = page.getByLabel("Avdeling", { exact: true });
  const semester = page.getByLabel("Semester", { exact: true });
  await department.selectOption({ label: "Trondheim" });
  await expect(department).toHaveValue(DEPARTMENT_ID);
  await semester.selectOption({ label: "Høst 2026" });
  await expect(semester).toHaveValue(SEMESTER_ID);
  await expect(department).toHaveValue(DEPARTMENT_ID);
}

async function loadCycle(page: Page): Promise<void> {
  await selectCycle(page);
  await page.getByRole("button", { name: "Vis søkere", exact: true }).click();
}

async function openSchedule(page: Page): Promise<void> {
  const row = page
    .getByRole("article")
    .filter({ hasText: "Applicant One" });
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: "Planlegg intervju", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Planlegg intervju", exact: true }),
  ).toBeVisible();
}

async function fillSchedule(
  page: Page,
  values: { time: string; room: string; campus: string },
): Promise<void> {
  await page.getByLabel("Tidspunkt", { exact: true }).fill(values.time);
  await page.getByLabel("Rom", { exact: true }).fill(values.room);
  await page.getByLabel("Campus", { exact: true }).fill(values.campus);
  await page.getByRole("button", { name: "Lagre og send", exact: true }).click();
}

async function scheduleThroughHttp(
  request: APIRequestContext,
  session: string,
  interviewId = INTERVIEW_ID,
): Promise<void> {
  const response = await request.put(
    `${FIXTURE_ORIGIN}/api/admin/interviews/assigned/${encodeURIComponent(interviewId)}/schedule`,
    {
      headers: actorHeaders(session),
      data: {
        departmentId: DEPARTMENT_ID,
        semesterId: SEMESTER_ID,
        interviewTime: VALID_TIME,
        room: VALID_ROOM,
        campus: VALID_CAMPUS,
      },
    },
  );
  expect(response.status()).toBe(204);
}

async function readAssigned(
  request: APIRequestContext,
  session: string,
  interviewId = INTERVIEW_ID,
): Promise<{ status: number; body: unknown }> {
  const response = await request.get(
    `${FIXTURE_ORIGIN}/api/admin/interviews/assigned/${encodeURIComponent(interviewId)}?departmentId=${encodeURIComponent(DEPARTMENT_ID)}&semesterId=${encodeURIComponent(SEMESTER_ID)}`,
    { headers: actorHeaders(session) },
  );
  return {
    status: response.status(),
    body: await response.json().catch(() => null),
  };
}

async function assertNoCapabilityInPage(
  page: Page,
  capability: string,
): Promise<void> {
  expect(page.url()).not.toContain(capability);
  expect(await page.locator("body").innerText()).not.toContain(capability);
  expect(await page.locator("html").evaluate((node) => node.outerHTML)).not.toContain(
    capability,
  );
}
async function assertCandidatePrivacy(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  expect(text).not.toContain("fixture_session");
  expect(text).not.toContain("fixture-");
  for (const term of candidatePrivacyTerms) expect(text).not.toContain(term);
}

async function attachEvidence(
  request: APIRequestContext,
  testInfo: TestInfo,
  capability: string,
): Promise<Evidence> {
  const evidence = await readEvidence(request);
  const serialized = JSON.stringify(evidence);
  expect(serialized).not.toContain(INTERVIEW_FIXTURE_CONTROL_KEY);
  expect(serialized).not.toContain("fixture-");
  expect(serialized).not.toContain(capability);
  await testInfo.attach("sanitized-fixture-evidence.json", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  return evidence;
}

function assertSdkObservation(
  evidence: Evidence,
  operation: string,
  status: number,
): void {
  expect(
    evidence.requests.some(
      (entry) => entry.operation === operation && entry.status === status,
    ),
  ).toBe(true);
}

test.describe("Foldkit interview scheduling journey", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test("leader schedules, candidate accepts in another context, interviewer sees fresh accepted state", async ({
    browser,
    request,
  }, testInfo) => {
    await resetFixture(request);

    const browserSeam: BrowserSeamObservation = {
      bridgeRequests: 0,
      directFixtureRequests: 0,
    };
    const leader = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await addSessionCookie(leader, LEADER_SESSION);
    const leaderPage = await leader.newPage();
    observeBrowserSeam(leaderPage, browserSeam);
    await openDashboard(leaderPage);
    await leaderPage.reload();
    await expect(leaderPage.getByRole("heading", { name: "Tildelte søkere" })).toHaveCount(0);
    await selectCycle(leaderPage);
    await leaderPage.screenshot({ path: testInfo.outputPath("selected-context.png") });
    await leaderPage.getByRole("button", { name: "Vis søkere", exact: true }).click();
    await expect(leaderPage.getByRole("heading", { name: "Tildelte søkere" })).toBeVisible();
    await expect(leaderPage.getByText("Applicant One", { exact: true })).toBeVisible();

    await openSchedule(leaderPage);
    await fillSchedule(leaderPage, {
      time: VALID_TIME,
      room: VALID_ROOM,
      campus: VALID_CAMPUS,
    });
    await expect(leaderPage.getByText("Intervjuet er planlagt og invitert.", { exact: true })).toBeVisible();
    const pendingRow = leaderPage.getByRole("article").filter({ hasText: "Applicant One" });
    await expect(pendingRow).toContainText("Invitert");
    await expect(pendingRow).toContainText(VALID_TIME);
    await expect(pendingRow).toContainText(VALID_ROOM);
    await expect(pendingRow).toContainText(VALID_CAMPUS);
    await leaderPage.screenshot({ path: testInfo.outputPath("scheduled-pending-row.png") });

    const privatePath = await responsePath(request);
    expect(privatePath).toMatch(/^\/interview-response\/[^/]+$/);
    const candidate = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const candidatePage = await candidate.newPage();
    observeBrowserSeam(candidatePage, browserSeam);
    await candidatePage.goto(`${DASHBOARD_ORIGIN}${privatePath}`);
    await expect(candidatePage).toHaveURL(`${DASHBOARD_ORIGIN}/interview-response/redacted`);
    await expect(candidatePage.getByText(VALID_ROOM, { exact: true })).toBeVisible();
    await expect(candidatePage.getByText(VALID_CAMPUS, { exact: true })).toBeVisible();
    await expect(candidatePage.getByRole("button", { name: "Aksepter intervjutid", exact: true })).toBeVisible();
    await assertCandidatePrivacy(candidatePage);
    const capability = decodeURIComponent(privatePath.split("/").at(-1) ?? "");
    await assertNoCapabilityInPage(candidatePage, capability);
    await candidatePage.getByRole("button", { name: "Aksepter intervjutid", exact: true }).click();
    await expect(candidatePage.getByRole("heading", { name: "Intervjutiden er akseptert", exact: true })).toBeVisible();
    await expect(candidatePage.getByText("Svaret er registrert. Du trenger ikke gjøre noe mer.", { exact: true })).toBeVisible();
    await candidatePage.reload();
    await expect(candidatePage).toHaveURL(`${DASHBOARD_ORIGIN}/interview-response/redacted`);
    await expect(candidatePage.getByRole("heading", { name: "Intervjutiden er akseptert", exact: true })).toBeVisible();
    await assertCandidatePrivacy(candidatePage);
    await assertNoCapabilityInPage(candidatePage, capability);
    await candidatePage.screenshot({ path: testInfo.outputPath("candidate-confirmation.png") });

    const interviewer = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await addSessionCookie(interviewer, INTERVIEWER_SESSION);
    const interviewerPage = await interviewer.newPage();
    await openDashboard(interviewerPage);
    await interviewerPage.reload();
    await loadCycle(interviewerPage);
    const interviewerRow = interviewerPage.getByRole("article").filter({ hasText: "Applicant One" });
    await expect(interviewerRow).toBeVisible();
    await expect(interviewerRow).toContainText("Akseptert");
    await expect(interviewerRow).toContainText(VALID_TIME);
    await expect(interviewerRow).toContainText(VALID_ROOM);
    await expect(interviewerRow).toContainText(VALID_CAMPUS);
    await expect(interviewerRow).toContainText("interviewer-trondheim@example.invalid");
    await expect(interviewerRow).not.toContainText(INTERVIEWER_SESSION);
    await interviewerPage.screenshot({ path: testInfo.outputPath("interviewer-accepted-row.png") });
    const evidence = await attachEvidence(request, testInfo, capability);
    expect(evidence.transitions).toEqual(["created -> pending", "pending -> accepted"]);
    expect(browserSeam.bridgeRequests).toBeGreaterThan(0);
    expect(browserSeam.directFixtureRequests).toBe(0);
    assertSdkObservation(evidence, "list-assigned", 200);
    assertSdkObservation(evidence, "schedule", 204);
    assertSdkObservation(evidence, "accept-candidate", 204);
    assertSdkObservation(evidence, "read-candidate", 200);
    await leader.close();
    await candidate.close();
    await interviewer.close();
  });

  test("rejects unauthorized role and wrong department without applicant disclosure", async ({
    browser,
    request,
  }) => {
    for (const session of [MEMBER_SESSION, BERGEN_SESSION]) {
      await resetFixture(request);
      const context = await browser.newContext();
      await addSessionCookie(context, session);
      const page = await context.newPage();
      await openDashboard(page);
      await page.reload();
      await loadCycle(page);
      await expect(page.getByText("Applicant One", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("alert")).toContainText("tilgang");
      const evidence = await readEvidence(request);
      assertSdkObservation(evidence, "list-assigned", 403);
      await context.close();
    }
  });

  test("validates missing and unknown cycle context before any mutation", async ({
    browser,
    request,
  }) => {
    await resetFixture(request);
    const context = await browser.newContext();
    await addSessionCookie(context, LEADER_SESSION);
    const page = await context.newPage();
    await openDashboard(page);
    await page.reload();
    await page.getByRole("button", { name: "Vis søkere", exact: true }).click();
    await expect(page.getByText("Velg avdeling og semester.", { exact: true })).toBeVisible();
    expect((await readEvidence(request)).requests).toEqual([]);
    await context.close();

    await resetFixture(request);
    const unknown = await request.get(
      `${FIXTURE_ORIGIN}/api/admin/interviews/assigned?departmentId=${encodeURIComponent(DEPARTMENT_ID)}&semesterId=sem-unknown`,
      { headers: actorHeaders(LEADER_SESSION) },
    );
    expect(unknown.status()).toBe(404);
    assertSdkObservation(await readEvidence(request), "list-assigned", 404);
  });

  test("blocks invalid, past, and empty schedule values in the UI", async ({
    browser,
    request,
  }) => {
    const cases = [
      { name: "empty time", time: "", room: VALID_ROOM, campus: VALID_CAMPUS },
      { name: "invalid date", time: "not-a-date", room: VALID_ROOM, campus: VALID_CAMPUS },
      { name: "past date", time: "2026-07-01T15:00:00+02:00", room: VALID_ROOM, campus: VALID_CAMPUS },
      { name: "empty room", time: VALID_TIME, room: "", campus: VALID_CAMPUS },
      { name: "empty campus", time: VALID_TIME, room: VALID_ROOM, campus: "" },
    ];
    for (const input of cases) {
      await test.step(input.name, async () => {
        await resetFixture(request);
        const context = await browser.newContext();
        await addSessionCookie(context, LEADER_SESSION);
        const page = await context.newPage();
        await openDashboard(page);
        await page.reload();
        await loadCycle(page);
        await openSchedule(page);
        await fillSchedule(page, input);
        await expect(page.getByText("Kontroller feltene.", { exact: true })).toBeVisible();
        const assigned = await readAssigned(request, LEADER_SESSION);
        expect(assigned.status).toBe(200);
        expect(assignedStateSchema.parse(assigned.body).schedulingStatus).toBe("created");
        const evidence = await readEvidence(request);
        expect(evidence.requests.some((entry) => entry.operation === "schedule" && entry.status === 204)).toBe(false);
        await context.close();
      });
    }
  });

  test("rejects unauthorized and invalid schedule identifiers without changing state", async ({
    request,
  }) => {
    await resetFixture(request);
    const unauthorized = await request.put(
      `${FIXTURE_ORIGIN}/api/admin/interviews/assigned/${INTERVIEW_ID}/schedule`,
      {
        headers: actorHeaders(MEMBER_SESSION),
        data: { departmentId: DEPARTMENT_ID, semesterId: SEMESTER_ID, interviewTime: VALID_TIME, room: VALID_ROOM, campus: VALID_CAMPUS },
      },
    );
    expect(unauthorized.status()).toBe(403);
    expect(
      assignedStateSchema.parse(
        (await readAssigned(request, LEADER_SESSION)).body,
      ).schedulingStatus,
    ).toBe("created");

    const invalidId = await request.put(
      `${FIXTURE_ORIGIN}/api/admin/interviews/assigned/not-positive/schedule`,
      {
        headers: actorHeaders(LEADER_SESSION),
        data: { departmentId: DEPARTMENT_ID, semesterId: SEMESTER_ID, interviewTime: VALID_TIME, room: VALID_ROOM, campus: VALID_CAMPUS },
      },
    );
    expect(invalidId.status()).toBe(404);
    assertSdkObservation(await readEvidence(request), "schedule", 404);
  });

  test("binds admin reads and schedules to the stored interview cycle", async ({
    request,
  }) => {
    await resetFixture(request);
    await controlFixture(request, "wrong-cycle");

    const assigned = await request.get(
      `${FIXTURE_ORIGIN}/api/admin/interviews/assigned?departmentId=${encodeURIComponent(DEPARTMENT_ID)}&semesterId=${encodeURIComponent(SEMESTER_ID)}`,
      { headers: actorHeaders(LEADER_SESSION) },
    );
    expect(assigned.status()).toBe(200);
    expect(await assigned.json()).toEqual([]);

    const read = await readAssigned(request, LEADER_SESSION);
    expect(read.status).toBe(404);

    const scheduled = await request.put(
      `${FIXTURE_ORIGIN}/api/admin/interviews/assigned/${INTERVIEW_ID}/schedule`,
      {
        headers: actorHeaders(LEADER_SESSION),
        data: {
          departmentId: DEPARTMENT_ID,
          semesterId: SEMESTER_ID,
          interviewTime: VALID_TIME,
          room: VALID_ROOM,
          campus: VALID_CAMPUS,
        },
      },
    );
    expect(scheduled.status()).toBe(404);
  });

  test("rejects missing and terminal interviews and leaves safe views", async ({
    browser,
    request,
  }) => {
    for (const state of ["missing", "cancelled", "conducted"] as const) {
      await resetFixture(request);
      if (state !== "missing") await scheduleThroughHttp(request, LEADER_SESSION);
      await controlFixture(request, state);
      const assigned = await readAssigned(request, LEADER_SESSION);
      if (state === "missing") expect(assigned.status).toBe(404);
      else expect(assigned.status).toBe(200);

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${DASHBOARD_ORIGIN}/interview-response/not-a-valid-capability`);
      await assertCandidatePrivacy(page);
      await context.close();
    }
  });

  test("rejects missing, malformed, wrong-cycle, and expired capabilities", async ({
    browser,
    request,
  }) => {
    await resetFixture(request);
    await scheduleThroughHttp(request, LEADER_SESSION);
    const privatePath = await responsePath(request);
    const capability = decodeURIComponent(privatePath.split("/").at(-1) ?? "");

    const malformed = await browser.newContext();
    const malformedPage = await malformed.newPage();
    await malformedPage.goto(`${DASHBOARD_ORIGIN}/interview-response/not-a-valid-capability`);
    await assertCandidatePrivacy(malformedPage);
    await malformed.close();

    await resetFixture(request);
    await scheduleThroughHttp(request, LEADER_SESSION);
    await controlFixture(request, "wrong-cycle");
    const wrongCycle = await request.get(
      `${FIXTURE_ORIGIN}/api/interview-responses/${encodeURIComponent(capability)}`,
      { headers: fixtureControlHeaders() },
    );
    expect([404, 409]).toContain(wrongCycle.status());

    await resetFixture(request);
    await scheduleThroughHttp(request, LEADER_SESSION);
    const expiredPath = await responsePath(request);
    await controlFixture(request, "expired");
    const expired = await browser.newContext();
    const expiredPage = await expired.newPage();
    await expiredPage.goto(`${DASHBOARD_ORIGIN}${expiredPath}`);
    await expect(expiredPage.getByRole("alert")).toContainText("ikke tilgjengelig");
    await assertCandidatePrivacy(expiredPage);
    await expired.close();
  });

  test("rejects reused capability and invalid transitions", async ({ request }) => {
    await resetFixture(request);
    await scheduleThroughHttp(request, LEADER_SESSION);
    const privatePath = await responsePath(request);
    const capability = decodeURIComponent(privatePath.split("/").at(-1) ?? "");
    const accepted = await request.post(
      `${FIXTURE_ORIGIN}/api/interview-responses/${encodeURIComponent(capability)}/accept`,
      { headers: fixtureControlHeaders() },
    );
    expect(accepted.status()).toBe(204);
    const reused = await request.post(
      `${FIXTURE_ORIGIN}/api/interview-responses/${encodeURIComponent(capability)}/accept`,
      { headers: fixtureControlHeaders() },
    );
    expect(reused.status()).toBe(409);

    await resetFixture(request);
    const beforeSchedule = await request.post(
      `${FIXTURE_ORIGIN}/api/interview-responses/${encodeURIComponent(capability)}/accept`,
      { headers: fixtureControlHeaders() },
    );
    expect([404, 409]).toContain(beforeSchedule.status());

    await resetFixture(request);
    await scheduleThroughHttp(request, LEADER_SESSION);
    await controlFixture(request, "cancelled");
    const cancelledSchedule = await request.put(
      `${FIXTURE_ORIGIN}/api/admin/interviews/assigned/${INTERVIEW_ID}/schedule`,
      {
        headers: actorHeaders(LEADER_SESSION),
        data: { departmentId: DEPARTMENT_ID, semesterId: SEMESTER_ID, interviewTime: VALID_TIME, room: VALID_ROOM, campus: VALID_CAMPUS },
      },
    );
    expect(cancelledSchedule.status()).toBe(409);
  });

  test("refreshes a stale interviewer page after candidate acceptance", async ({
    browser,
    request,
  }, testInfo) => {
    await resetFixture(request);
    const leader = await browser.newContext();
    await addSessionCookie(leader, LEADER_SESSION);
    const leaderPage = await leader.newPage();
    await openDashboard(leaderPage);
    await leaderPage.reload();
    await loadCycle(leaderPage);
    await openSchedule(leaderPage);
    await fillSchedule(leaderPage, { time: VALID_TIME, room: VALID_ROOM, campus: VALID_CAMPUS });

    const interviewer = await browser.newContext();
    await addSessionCookie(interviewer, INTERVIEWER_SESSION);
    const interviewerPage = await interviewer.newPage();
    await openDashboard(interviewerPage);
    await interviewerPage.reload();
    await loadCycle(interviewerPage);
    await expect(interviewerPage.getByText("Invitert", { exact: true })).toBeVisible();

    const privatePath = await responsePath(request);
    const candidate = await browser.newContext();
    const candidatePage = await candidate.newPage();
    await candidatePage.goto(`${DASHBOARD_ORIGIN}${privatePath}`);
    await expect(candidatePage.getByText(VALID_ROOM, { exact: true })).toBeVisible();
    await candidatePage.getByRole("button", { name: "Aksepter intervjutid", exact: true }).click();
    await expect(candidatePage.getByText("Svaret er registrert. Du trenger ikke gjøre noe mer.", { exact: true })).toBeVisible();
    await interviewerPage.reload();
    await loadCycle(interviewerPage);
    await expect(interviewerPage.getByText("Akseptert", { exact: true })).toBeVisible();
    await interviewerPage.screenshot({ path: testInfo.outputPath("stale-interviewer-refresh.png") });

    const evidence = await readEvidence(request);
    expect(evidence.transitions).toContain("pending -> accepted");
    await leader.close();
    await interviewer.close();
    await candidate.close();
  });
});
