import { expect, test, type Locator, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const leaderUsername = "background-recruiter-leader-0032";
const leaderPassword = "background-recruiter-password-0032";
const applicantName = "Applicant Assignment 0032";
const interviewerName = "Recruiter Interviewer 0032";
const schemaName = "Background recruiter schema 0032";

function requireBackgroundMode(): void {
  expect(process.env.REAL_SYMFONY_BACKGROUND_OPERATIONS_E2E).toBe("1");
  expect(process.env.API_MODE).not.toBe("fixture");
  expect(process.env.VITE_API_MODE).not.toBe("fixture");
}

async function loginDashboard(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Vektorprogrammet", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Brukernavn eller e-post").fill(leaderUsername);
  await page.getByLabel("Passord").fill(leaderPassword);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:$|\/)/);
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

  test("interview-recruiter", async ({ page }) => {
    requireBackgroundMode();
    await loginDashboard(page);
    const loginResponse = await page.request.post(`${apiOrigin}/api/login`, {
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      data: { username: leaderUsername, password: leaderPassword },
    });
    expect(loginResponse.status()).toBe(200);
    const loginPayload = (await loginResponse.json()) as { token?: unknown };
    expect(typeof loginPayload.token).toBe("string");
    const authorization = { Authorization: `Bearer ${loginPayload.token as string}` };
    for (const path of [
      "/api/admin/applications?status=new",
      "/api/admin/users",
      "/api/admin/interview-schemas",
    ]) {
      const response = await page.request.get(`${apiOrigin}${path}`, {
        headers: { Accept: "application/ld+json", ...authorization },
      });
      expect(response.status(), path).toBe(200);
    }

    await page.goto("/dashboard/sokere?status=new", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Søkere", exact: true })).toBeVisible();
    const applicantRow = page.getByRole("row").filter({ hasText: applicantName });
    await expect(applicantRow).toBeVisible();
    await expect(applicantRow).toContainText("—");

    await applicantRow.getByRole("button", { name: "Tildel intervju", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const interviewerSelect = dialog.getByRole("combobox").nth(0);
    await interviewerSelect.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("option", { name: interviewerName, exact: true }).click();

    const schemaSelect = dialog.getByRole("combobox").nth(1);
    await schemaSelect.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("option", { name: schemaName, exact: true }).click();
    await dialog.getByRole("button", { name: "Tildel", exact: true }).click();

    await expect(applicantRow).toContainText(interviewerName);
    await page.reload({ waitUntil: "networkidle" });
    const freshApplicantRow = page.getByRole("row").filter({ hasText: applicantName });
    await expect(freshApplicantRow).toContainText(interviewerName);
    await expect(
      freshApplicantRow.getByRole("button", { name: "Tildel intervju", exact: true }),
    ).toHaveCount(0);

    await page.goto("/dashboard/intervjuer", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Intervjuer", exact: true })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: applicantName })).toContainText(interviewerName);
  });

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

    const privilegedResponse = await page.request.get(
      `${apiOrigin}/api/admin/interview-schemas`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${loginPayload.token as string}`,
        },
      },
    );
    expect(privilegedResponse.status()).toBe(200);
  });

  test("background-delivery", async ({ page }) => {
    requireBackgroundMode();
    await loginDashboard(page);
    await page.goto("/dashboard/intervjuer", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Intervjuer", exact: true })).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: "Applicant Reminder 0032" }),
    ).toContainText("Recruiter Interviewer 0032");
  });
});
