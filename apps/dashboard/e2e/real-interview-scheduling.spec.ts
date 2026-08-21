import { expect, test, type Page, type Request } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const leaderUsername = "recruitment-leader-0029";
const leaderPassword = "recruitment-e2e-0029";
const interviewerUsername = "recruitment-interviewer-0029";
const interviewerPassword = "recruitment-e2e-0029";
const applicantName = "Søker 0029";
const responseCapability = "recruitment_response_0029";
const schedule = {
  datetime: "2026-09-14T15:00:00+02:00",
  room: "Rom 29",
  campus: "E2E campus",
  mapLink: "https://maps.example.invalid/interview-0029",
  from: "recruitment-interviewer-0029@example.invalid",
  to: "recruitment-applicant-0029@example.invalid",
  message: "Vi ser frem til intervjuet.",
};

function redactTokenBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { token?: unknown };
    if (parsed && typeof parsed === "object" && "token" in parsed) {
      parsed.token = "<redacted>";
      return JSON.stringify(parsed);
    }
  } catch {
    // Keep non-JSON error responses intact for diagnosis.
  }
  return rawBody;
}

async function probeLoginFailure(
  page: Page,
  username: string,
  password: string,
): Promise<{ status: number; body: string }> {
  try {
    const response = await page.request.post(`${apiOrigin}/api/login`, {
      timeout: 10_000,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      data: { username, password },
    });
    return {
      status: response.status(),
      body: redactTokenBody(await response.text()),
    };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

async function diagnoseDashboardAuth(page: Page, stage: string): Promise<string> {
  const rawCookies = await page.context().cookies();
  const cookies = rawCookies.map((cookie) => ({
    name: cookie.name,
    value: "<redacted>",
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  }));
  const jwtCookie = rawCookies.find((cookie) => cookie.name === "jwt_token");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (jwtCookie) headers.Authorization = `Bearer ${jwtCookie.value}`;

  const probes = await Promise.all(
    ["/api/me", "/api/me/dashboard"].map(async (endpoint) => {
      try {
        const response = await page.request.get(`${apiOrigin}${endpoint}`, {
          timeout: 10_000,
          headers,
        });
        return {
          endpoint,
          status: response.status(),
          body: redactTokenBody(await response.text()),
        };
      } catch (error) {
        return {
          endpoint,
          status: 0,
          body: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const diagnosticBody = JSON.stringify({ cookies, probes }, null, 2);
  await test.info().attach(`real-dashboard-auth-${stage}.json`, {
    body: diagnosticBody,
    contentType: "application/json",
  });
  return diagnosticBody;
}


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
  await expect(page.getByRole("heading", { name: "Vektorprogrammet", exact: true })).toBeVisible();
  await page.getByLabel("Brukernavn eller e-post").fill(username);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  try {
    await expect(page).toHaveURL(/\/dashboard(?:$|\/)/);
  } catch (error) {
    const dashboardDiagnostics = await diagnoseDashboardAuth(page, `login-${username}`);
    const probe = await probeLoginFailure(page, username, password);
    await test.info().attach("real-login-api-response.json", {
      body: JSON.stringify(
        {
          endpoint: `${apiOrigin}/api/login`,
          status: probe.status,
          body: probe.body,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Real login UI did not reach the dashboard (${reason}); direct API probe returned ${probe.status}: ${probe.body}; dashboard auth diagnostics: ${dashboardDiagnostics}`,
    );
  }
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
        new URL(request.url()).pathname === "/interview" &&
        bridgeOperation(request) === "scheduleInterview",
    );
    const scheduleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/interview" &&
        bridgeOperation(response.request()) === "scheduleInterview",
    );
    await page.getByRole("button", { name: "Lagre og send", exact: true }).click();
    const [request, response] = await Promise.all([scheduleRequest, scheduleResponse]);
    const bridgePayload = request.postDataJSON();
    expect(bridgePayload).toMatchObject({
      operation: "scheduleInterview",
      input: schedule,
    });
    expect(bridgePayload.interviewId).toEqual(expect.any(Number));
    const bridgeResponseBody = await response.text();
    if (response.status() !== 200) {
      const jwtCookie = (await page.context().cookies()).find((cookie) => cookie.name === "jwt_token");
      const directHeaders: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      if (jwtCookie) directHeaders.Authorization = `Bearer ${jwtCookie.value}`;

      let directStatus = 0;
      let directBody = "";
      try {
        const directResponse = await page.request.post(
          `${apiOrigin}/api/admin/interviews/${bridgePayload.interviewId}/schedule`,
          { headers: directHeaders, data: schedule, timeout: 10_000 },
        );
        directStatus = directResponse.status();
        directBody = redactTokenBody(await directResponse.text());
      } catch (error) {
        directBody = error instanceof Error ? error.message : String(error);
      }

      await test.info().attach("real-schedule-failure.json", {
        body: JSON.stringify(
          {
            bridge: {
              status: response.status(),
              body: redactTokenBody(bridgeResponseBody),
            },
            directSymfony: {
              endpoint: `${apiOrigin}/api/admin/interviews/${bridgePayload.interviewId}/schedule`,
              status: directStatus,
              body: directBody,
            },
            payload: schedule,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      throw new Error(
        `Interview scheduling bridge returned ${response.status()}: ${redactTokenBody(bridgeResponseBody)}; direct Symfony returned ${directStatus}: ${directBody}`,
      );
    }
    expect(response.status()).toBe(200);

    const scheduleResult = JSON.parse(bridgeResponseBody) as unknown;
    expect(scheduleResult).toBeNull();

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
    await candidatePage.getByRole("button", { name: "Bekreft intervjutid", exact: true }).click();
    await expect(candidatePage.getByRole("heading", { name: "Intervjutiden er akseptert", exact: true })).toBeVisible();
    await candidateContext.close();

    const interviewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const interviewerPage = await interviewerContext.newPage();
    await login(interviewerPage, interviewerUsername, interviewerPassword);
    const freshRead = interviewerPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/interview" &&
        bridgeOperation(response.request()) === "listInterviews",
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
