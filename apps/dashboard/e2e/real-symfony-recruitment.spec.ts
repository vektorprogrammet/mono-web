import { expect, test } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const leaderUsername = "recruitment-leader-0028";
const leaderPassword = "recruitment-e2e-0028";
const applicantName = "Søker 0028";
const interviewerName = "Intervjuer 0028";
const schemaName = "Førstegangsintervju 0028";

test.describe("Real Symfony recruitment applicant assignment", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("logs in, assigns a new applicant, and observes the fresh server read", async ({
    page,
  }) => {
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
    await expect(page).toHaveURL(/\/dashboard(?:$|\/)/);

    await page.goto("/dashboard/sokere?status=new", {
      waitUntil: "networkidle",
    });
    await expect(page).toHaveURL(/\/dashboard\/sokere\?status=new$/);
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

    const freshRead = await page.request.get(
      `${apiOrigin}/api/admin/applications?status=new`,
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
