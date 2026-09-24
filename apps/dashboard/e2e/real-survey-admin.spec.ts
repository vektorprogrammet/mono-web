import { Schema, Predicate } from "effect";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";

const operatorUsername = "survey-admin-operator-0032";

const operatorPassword = "survey-admin-password-0032";

const viewerUsername = "survey-admin-viewer-0032";

const viewerPassword = "survey-admin-viewer-password-0032";

function requireSurveyAdminMode(): void {
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

async function currentSemesterId(page: Page): Promise<number> {
  const value = await page
    .locator('select[name="survey[semester]"] option')
    .filter({ hasText: "Vår 2032" })
    .getAttribute("value");

  expect(value).toMatch(/^\d+$/);

  return Number(value);
}

test.describe("Real Symfony survey administration journey", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("survey-admin", async ({ page }) => {
    requireSurveyAdminMode();

    const viewerToken = await loginWithApi(page, viewerUsername, viewerPassword);

    const unauthorized = await page.request.get(`${apiOrigin}/api/admin/surveys`, {
      headers: { Accept: "application/ld+json", Authorization: `Bearer ${viewerToken}` },
    });

    await expectProblem(unauthorized, [401, 403]);

    await loginWithUi(page, operatorUsername, operatorPassword);
    const operatorToken = await loginWithApi(page, operatorUsername, operatorPassword);

    const formPage = await page.goto(`${apiOrigin}/kontrollpanel/undersokelse/opprett`);
    expect(formPage?.status()).toBe(200);
    const semesterId = await currentSemesterId(page);

    const invalid = await page.request.post(`${apiOrigin}/api/admin/surveys`, {
      headers: headers(operatorToken),
      data: {
        name: "",
        semesterId,
        targetAudience: 0,
        confidential: false,
        finishPageContent: "Survey administration complete.",
      },
    });

    await expectProblem(invalid, [400, 422]);

    const name = "Survey administration 0032";

    const created = await page.request.post(`${apiOrigin}/api/admin/surveys`, {
      headers: headers(operatorToken),
      data: {
        name,
        semesterId,
        targetAudience: 0,
        confidential: false,
        finishPageContent: "Survey administration complete.",
        questions: [
          {
            question: "Which deployment lane was verified?",
            type: "text",
            optional: false,
            help: "Answer with one short phrase.",
          },
        ],
      },
    });

    expect(created.status()).toBe(201);
    const createdPayload = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))((await created.json()));
    expect(Predicate.isNumber(createdPayload.id)).toBe(true);

    const freshRead = await page.request.get(`${apiOrigin}/api/admin/surveys?semester=${semesterId}`, {
      headers: { Accept: "application/ld+json", Authorization: `Bearer ${operatorToken}` },
    });

    expect(freshRead.status()).toBe(200);
    const listPayload = Schema.decodeUnknownSync(Schema.Struct({ surveys: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.optional(Schema.Json) }))) }))((await freshRead.json()));
    expect(listPayload.surveys?.some((survey) => survey.name === name)).toBe(true);

    const rendered = await page.goto(`${apiOrigin}/kontrollpanel/undersokelse/admin?semester=${semesterId}`);
    expect(rendered?.status()).toBe(200);
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  });
});
