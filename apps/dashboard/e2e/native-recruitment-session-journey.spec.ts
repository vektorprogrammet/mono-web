import { expect, test } from "@playwright/test";

const nativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

const leaderEmail = "lina.leader@example.invalid";
const leaderPassword = "journey-secret-0123456789abcdef";
// Spec 0049 journey facts provisioned by e2e/native-recruitment-journey-seed.mjs.
const applicantName = "Sofie Søker";
const interviewerName = "Irene Intervjuer";
const schemaOptionLabel = "Førstegangsintervju (8 spørsmål)";

/**
 * Native recruitment applicant-assignment journey (spec 0049) over the real
 * native Identity topology: Better Auth sign-in through /login, then the
 * Foldkit /dashboard/sokere program driven end to end. Requires
 * REAL_NATIVE_IDENTITY_E2E=1 plus backend+dashboard booted by the caller.
 */
test.describe("Native recruitment assignment journey (spec 0049)", () => {
  test("leader signs in and assigns an interviewee from a fresh board read", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    const bridgeOperations: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/recruitment" || request.method() !== "POST") {
        return;
      }
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

    // 1. Sign in as the seeded active team leader through the login form.
    await page.goto("/login");
    await page.getByLabel("Brukernavn eller e-post").fill(leaderEmail);
    await page.getByLabel("Passord").fill(leaderPassword);
    await page.getByRole("button", { name: "Logg inn" }).click();
    await page.waitForURL(/\/dashboard$/);

    await page.goto("/dashboard/sokere");
    await expect(page).toHaveURL(/\/dashboard\/sokere$/);
    await expect(page.getByRole("heading", { level: 1, name: "Søkere" })).toBeVisible();

    // 3. The Foldkit board renders the seeded unassigned applicant.
    const applicantRow = page
      .getByRole("row")
      .filter({ hasText: applicantName })
      .filter({ hasText: "Ikke tildelt" });
    await expect(applicantRow).toBeVisible();

    // 4. Select the Nye søkere filter; the unassigned candidate stays visible.
    await page.getByRole("button", { name: "Nye søkere" }).click();
    await expect(applicantRow).toBeVisible();

    // 5. Open the unassigned applicant dialog.
    await applicantRow
      .getByRole("button", { name: `Tildel intervju til ${applicantName}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // 6. Pick one active interviewer and one active schema, submit once.
    await dialog.getByLabel("Intervjuer").selectOption({ label: interviewerName });
    await dialog.getByLabel("Intervjuskjema").selectOption({ label: schemaOptionLabel });
    await dialog.getByRole("button", { name: "Tildel intervju", exact: true }).click();

    // 7. Success feedback, dialog closed, and the fresh post-command board read
    // replaces the board model. Under the Nye søkere filter the newly assigned
    // candidate legitimately leaves the filtered board, so the refreshed row is
    // verified on the Alle søkere view.
    await expect(
      page.getByRole("status").filter({ hasText: "Intervjuet er tildelt." }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Alle søkere" }).click();
    const assignedRow = page
      .getByRole("row")
      .filter({ hasText: applicantName })
      .filter({ hasText: "Ikke kontaktet" });
    await expect(assignedRow).toContainText(interviewerName);

    // 8. Only the fresh post-command board read may replace the board model.
    // True operation tail: the command, exactly one fresh post-command board
    // read replacing the model, then the Alle søkere re-read above.
    expect(bridgeOperations.slice(-3)).toEqual([
      "assignApplicant",
      "readAssignmentBoard",
      "readAssignmentBoard",
    ]);
  });
});
