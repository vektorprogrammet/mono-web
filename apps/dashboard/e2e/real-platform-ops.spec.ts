import { Schema, Predicate } from "effect";
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
  const payload = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))((await response.json()));
  expect(Predicate.isString(payload.token)).toBe(true);

  return payload.token;
}

function headers(token: string) {
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
    const createdPayload = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(JSON.parse(createdBody));
    expect(Predicate.isNumber(createdPayload.id)).toBe(true);

    const duplicate = await page.request.post(`${apiOrigin}/api/admin/semesters`, {
      headers: headers(adminToken),
      data: { semesterTime: "Høst", year: "2034" },
    });

    await expectProblem(duplicate, [409]);

    const statistics = await page.request.get(`${apiOrigin}/api/statistics`, {
      headers: { Accept: "application/ld+json" },
    });

    expect(statistics.status()).toBe(200);

    const statisticsPayload = Schema.decodeUnknownSync(Schema.Struct({ assistantCount: Schema.Number, teamMemberCount: Schema.Number }))((await statistics.json()));

    expect(Predicate.isNumber(statisticsPayload.assistantCount)).toBe(true);
    expect(Predicate.isNumber(statisticsPayload.teamMemberCount)).toBe(true);

    const fields = await page.request.get(`${apiOrigin}/api/field_of_studies`, {
      headers: { Accept: "application/ld+json" },
    });

    expect(fields.status()).toBe(200);

    const fieldsPayload = Schema.decodeUnknownSync(Schema.Struct({ "hydra:member": Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Number, shortName: Schema.optional(Schema.Json) }))), member: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Number, shortName: Schema.optional(Schema.Json) }))) }))((await fields.json()));

    const members = fieldsPayload["hydra:member"] ?? fieldsPayload.member ?? [];
    const fixtureField = members.find((field) => field.shortName === "PLATFORM-STUDY-0032");
    expect(fixtureField).toBeDefined();
    expect(Predicate.isNumber(fixtureField?.id)).toBe(true);

    const rendered = await page.goto(`${apiOrigin}/kontrollpanel/semesteradmin`);
    expect(rendered?.status()).toBe(200);
    await expect(page.getByText("Høst 2034", { exact: true })).toBeVisible();
  });
});
