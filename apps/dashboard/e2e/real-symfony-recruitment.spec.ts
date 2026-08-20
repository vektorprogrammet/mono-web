import { expect, test, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const leaderUsername = "recruitment-leader-0028";
const leaderPassword = "recruitment-e2e-0028";
const applicantName = "Søker 0028";
const interviewerName = "Intervjuer 0028";
const schemaName = "Førstegangsintervju 0028";
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
): Promise<{ status: number; body: string }> {
  try {
    const response = await page.request.post(`${apiOrigin}/api/login`, {
      timeout: 10_000,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      data: {
        username: leaderUsername,
        password: leaderPassword,
      },
    });
    const body = redactTokenBody(await response.text());
    return { status: response.status(), body };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}
async function diagnoseDashboardAuth(page: Page, stage: string): Promise<void> {
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
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (jwtCookie) {
    headers.Authorization = `Bearer ${jwtCookie.value}`;
  }

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

  await test.info().attach(`real-dashboard-auth-${stage}.json`, {
    body: JSON.stringify({ cookies, probes }, null, 2),
    contentType: "application/json",
  });
}


test.describe("Real Symfony recruitment applicant assignment", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("logs in, assigns a new applicant, and observes the fresh server read", async ({
    page,
  }) => {
    test.skip(
      process.env.REAL_SYMFONY_RECRUITMENT_E2E !== "1",
      "requires the real Symfony recruitment command",
    );
    expect(process.env.REAL_SYMFONY_RECRUITMENT_E2E).toBe("1");
    expect(process.env.API_MODE).not.toBe("fixture");
    expect(process.env.VITE_API_MODE).not.toBe("fixture");

    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Vektorprogrammet", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Brukernavn eller e-post").fill(leaderUsername);
    await page.getByLabel("Passord").fill(leaderPassword);
    await page.getByRole("button", { name: "Logg inn", exact: true }).click();
    try {
      await expect(page).toHaveURL(/\/dashboard(?:$|\/)/);
    } catch (error) {
      await diagnoseDashboardAuth(page, "login-redirect");
      const probe = await probeLoginFailure(page);
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
        `Real login UI did not reach the dashboard (${reason}); direct API probe returned ${probe.status}: ${probe.body}`,
      );
    }
    try {
      await page.goto("/dashboard/sokere?status=new", {
        waitUntil: "networkidle",
      });
      await expect(page).toHaveURL(/\/dashboard\/sokere\?status=new$/);
    } catch (error) {
      await diagnoseDashboardAuth(page, "applicant-list");
      throw error;
    }
    await expect(
      page.getByRole("heading", { name: "Søkere", exact: true }),
    ).toBeVisible();

    const applicantRow = page
      .getByRole("row")
      .filter({ hasText: applicantName });
    await expect(applicantRow).toBeVisible();
    await expect(applicantRow).toContainText("—");

    await applicantRow
      .getByRole("button", { name: "Tildel intervju", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const interviewerSelect = dialog.getByRole("combobox").nth(0);
    await interviewerSelect.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(
      page.getByRole("option", { name: interviewerName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("option", { name: interviewerName, exact: true })
      .click();

    const schemaSelect = dialog.getByRole("combobox").nth(1);
    await schemaSelect.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(
      page.getByRole("option", { name: schemaName, exact: true }),
    ).toBeVisible();
    await page.getByRole("option", { name: schemaName, exact: true }).click();

    await dialog.getByRole("button", { name: "Tildel", exact: true }).click();
    await expect(applicantRow).toContainText(interviewerName);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/dashboard\/sokere\?status=new$/);
    const refreshedApplicantRow = page
      .getByRole("row")
      .filter({ hasText: applicantName });
    await expect(refreshedApplicantRow).toContainText(interviewerName);
    await expect(
      refreshedApplicantRow.getByRole("button", {
        name: "Tildel intervju",
        exact: true,
      }),
    ).toHaveCount(0);

    const jwtCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "jwt_token",
    );
    if (!jwtCookie) {
      throw new Error("The real login did not set jwt_token");
    }
    const freshRead = await page.request.get(
      `${apiOrigin}/api/admin/applications?status=new`,
      {
        headers: { Authorization: `Bearer ${jwtCookie.value}` },
      },
    );
    expect(freshRead.status()).toBe(200);
    const payload = (await freshRead.json()) as {
      applications?: Array<{
        userName?: string;
        interviewer?: string | null;
      }>;
    };
    expect(payload.applications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userName: applicantName,
          interviewer: interviewerName,
        }),
      ]),
    );
  });
});
