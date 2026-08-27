import { expect, test, type Locator, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";

function requireBackgroundMode(): void {
  expect(process.env.REAL_SYMFONY_BACKGROUND_OPERATIONS_E2E).toBe("1");
  expect(process.env.API_MODE).not.toBe("fixture");
  expect(process.env.VITE_API_MODE).not.toBe("fixture");
}

async function findAdmissionForm(page: Page): Promise<Locator> {
  const departmentTab = page.getByRole("link", {
    name: "BackgroundAdmissionCity",
    exact: true,
  });
  await expect(departmentTab).toBeVisible();
  await departmentTab.click();

  const form = page.locator(".tab-pane.active form");
  await expect(form).toBeVisible();
  return form;
}

test.describe("Real Symfony background operations", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test("admission-operations", async ({ page }) => {
    requireBackgroundMode();
    await page.goto(`${apiOrigin}/opptak`, { waitUntil: "networkidle" });
    const form = await findAdmissionForm(page);
    await form.getByLabel("Fornavn").fill("Admission");
    await form.getByLabel("Etternavn").fill("Operations 0032");
    await form.getByLabel("E-post").fill("background-admission-applicant-0032@example.invalid");
    await form.getByLabel("Telefon").fill("90000035");
    await form.getByLabel("Kjønn").selectOption({ label: "Dame" });
    await form.getByLabel("Linje").selectOption({ label: "BG-ADM-STUDY" });
    await form.getByLabel("Årstrinn").selectOption({ label: "1. klasse" });
    await form.getByRole("button", { name: "Søk nå!", exact: true }).click();

    await expect(page).toHaveURL(/\/assistenter\/opptak\/bekreftelse$/);
    await expect(page.getByText(/søknad|registrert/i).first()).toBeVisible();
  });

  test("background-automation", async ({ page }) => {
    requireBackgroundMode();
    const loginResponse = await page.request.post(`${apiOrigin}/api/login`, {
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      data: {
        username: "background-automation-user-0032",
        password: "background-automation-password-0032",
      },
    });
    expect(loginResponse.status()).toBe(200);
    const loginPayload = (await loginResponse.json()) as { token?: unknown };
    expect(typeof loginPayload.token).toBe("string");

    const privilegedResponse = await page.request.get(`${apiOrigin}/api/admin/interview-schemas`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${loginPayload.token as string}`,
      },
    });
    expect(privilegedResponse.status()).toBe(200);
  });
});
