import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";
const REAL_RECRUITMENT_E2E = process.env.REAL_RECRUITMENT_E2E === "1";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the native recruitment journey`);
  }
  return value;
};

const authenticate = async (page: Page): Promise<void> => {
  await page.context().addCookies([
    {
      name: "jwt_token",
      value: requiredEnvironment("RECRUITMENT_E2E_LEADER_TOKEN"),
      url: DASHBOARD_ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
};

test.describe("Native recruitment applicant assignment", () => {
  test.skip(!REAL_RECRUITMENT_E2E, "run through the deterministic native recruitment runner");

  test("assigns through the Foldkit owner and renders only a fresh board read", async ({ page }) => {
    const applicantName = requiredEnvironment("RECRUITMENT_E2E_APPLICANT_NAME");
    const interviewerName = requiredEnvironment("RECRUITMENT_E2E_INTERVIEWER_NAME");
    const schemaName = requiredEnvironment("RECRUITMENT_E2E_SCHEMA_NAME");
    const bridgeOperations: string[] = [];

    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/recruitment" || request.method() !== "POST") return;
      const payload: unknown = request.postDataJSON();
      if (
        typeof payload === "object" &&
        payload !== null &&
        "operation" in payload &&
        typeof payload.operation === "string"
      ) {
        bridgeOperations.push(payload.operation);
      }
    });

    await authenticate(page);
    await page.goto("/dashboard/sokere?status=all");

    await expect(page).toHaveURL(`${DASHBOARD_ORIGIN}/dashboard/sokere?status=all`);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Søkere" })).toBeVisible();

    await page.getByRole("button", { name: "Nye søkere" }).click();
    const applicantRow = page.getByRole("row").filter({ hasText: applicantName });
    await expect(applicantRow).toContainText("Ikke tildelt");
    await applicantRow
      .getByRole("button", { name: `Tildel intervju til ${applicantName}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Intervjuer").selectOption({ label: interviewerName });
    const schemaSelect = dialog.getByLabel("Intervjuskjema");
    const schemaValue = await schemaSelect
      .locator("option")
      .filter({ hasText: schemaName })
      .getAttribute("value");
    if (schemaValue === null) throw new Error("seeded interview schema option was absent");
    await schemaSelect.selectOption(schemaValue);
    await dialog.getByRole("button", { name: "Tildel intervju", exact: true }).click();

    await expect(page.getByRole("status").filter({ hasText: "Intervjuet er tildelt." })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(applicantRow).toContainText("Ikke kontaktet");
    await expect(applicantRow).toContainText(interviewerName);
    expect(bridgeOperations.slice(-3)).toEqual([
      "readAssignmentBoard",
      "assignApplicant",
      "readAssignmentBoard",
    ]);

    const accessibility = await new AxeBuilder({ page })
      .include('section[aria-labelledby="fr-page-title"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });
});
