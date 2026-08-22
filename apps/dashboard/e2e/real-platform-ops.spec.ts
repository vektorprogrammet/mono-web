import { expect, test, type APIResponse, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const adminUsername = "platform-ops-admin-0032";
const adminPassword = "platform-ops-admin-password-0032";
const viewerUsername = "platform-ops-viewer-0032";
const viewerPassword = "platform-ops-viewer-password-0032";

function requirePlatformOpsMode(): void {
  test.skip(
    process.env.REAL_SYMFONY_CONTENT_OPS_E2E !== "1",
    "requires the real Symfony content operations command",
  );
  expect(process.env.REAL_SYMFONY_CONTENT_OPS_E2E).toBe("1");
  expect(process.env.API_MODE).not.toBe("fixture");
  expect(process.env.VITE_API_MODE).not.toBe("fixture");
}

async function loginWithUi(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Innlogging", exact: true })).toBeVisible();
  await page.getByLabel("Brukernavn / e-post").fill(username);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(/\/kontrollpanel$/);
}

async function loginWithApi(page: Page, username: string, password: string): Promise<string> {
  const response = await page.request.post(`${apiOrigin}/api/login`, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    data: { username, password },
  });
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { token?: unknown };
  expect(typeof payload.token).toBe("string");
  return payload.token as string;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/ld+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function expectProblem(response: APIResponse, statuses: readonly number[]): Promise<void> {
  expect(statuses).toContain(response.status());
  expect((await response.text()).length).toBeGreaterThan(0);
}

test.describe("Real Symfony platform operations journey", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("platform-ops", async ({ page }) => {
    requirePlatformOpsMode();

    const viewerToken = await loginWithApi(page, viewerUsername, viewerPassword);
    const unauthorized = await page.request.post(`${apiOrigin}/api/admin/semesters`, {
      headers: headers(viewerToken),
      data: { semesterTime: "Høst", year: "2034" },
    });
    await expectProblem(unauthorized, [401, 403]);

    await loginWithUi(page, adminUsername, adminPassword);
    const adminToken = await loginWithApi(page, adminUsername, adminPassword);

    const invalid = await page.request.post(`${apiOrigin}/api/admin/semesters`, {
      headers: headers(adminToken),
      data: { semesterTime: "Autumn", year: "2034" },
    });
    await expectProblem(invalid, [400, 422]);

    const created = await page.request.post(`${apiOrigin}/api/admin/semesters`, {
      headers: { ...headers(adminToken), Accept: "application/json" },
      data: { semesterTime: "Høst", year: "2034" },
    });
    const createdBody = await created.text();
    expect(created.status(), createdBody).toBe(201);
    const createdPayload = JSON.parse(createdBody) as { id?: unknown };
    expect(typeof createdPayload.id).toBe("number");
    const duplicate = await page.request.post(`${apiOrigin}/api/admin/semesters`, {
      headers: headers(adminToken),
      data: { semesterTime: "Høst", year: "2034" },
    });
    await expectProblem(duplicate, [409]);

    const statistics = await page.request.get(`${apiOrigin}/api/statistics`, {
      headers: { Accept: "application/ld+json" },
    });
    expect(statistics.status()).toBe(200);
    const statisticsPayload = (await statistics.json()) as {
      assistantCount?: unknown;
      teamMemberCount?: unknown;
    };
    expect(typeof statisticsPayload.assistantCount).toBe("number");
    expect(typeof statisticsPayload.teamMemberCount).toBe("number");

    const fields = await page.request.get(`${apiOrigin}/api/field_of_studies`, {
      headers: { Accept: "application/ld+json" },
    });
    expect(fields.status()).toBe(200);
    const fieldsPayload = (await fields.json()) as {
      "hydra:member"?: Array<{ id?: unknown; shortName?: unknown }>;
      member?: Array<{ id?: unknown; shortName?: unknown }>;
    };
    const members = fieldsPayload["hydra:member"] ?? fieldsPayload.member ?? [];
    const fixtureField = members.find((field) => field.shortName === "PLATFORM-STUDY-0032");
    expect(fixtureField).toBeDefined();
    expect(typeof fixtureField?.id).toBe("number");

    const rendered = await page.goto(`${apiOrigin}/kontrollpanel/semesteradmin`);
    expect(rendered?.status()).toBe(200);
    await expect(page.getByText("Høst 2034", { exact: true })).toBeVisible();
  });
});
