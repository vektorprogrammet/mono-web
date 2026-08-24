import { expect, test, type Page } from "@playwright/test";

const nativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

// Seed personas provisioned by native-users-journey-seed.mjs (spec 0057).
// None of these names exists in app/mock/api/data-brukere.ts, so their
// presence proves the render is native; asserting every fixture name absent
// proves zero mock usage.
const adminEmail = "admin.journey@example.invalid";
const adminPassword = "journey-secret-2026";
const leader = {
  email: "leif.ledersen@example.invalid",
  password: "leif-pass-2026-long",
};
const plainMember = {
  email: "pia.medlem@example.invalid",
  password: "pia-pass-2026-longg",
};

const endedMemberLast = "Avsluttet";
const osloOnlyLast = "Oslobergen";
const columnHeaders = ["Fornavn", "Etternavn", "Telefon", "E-post", "Studie", "Avdeling"];
const fixtureNames = ["Ola Nordmann", "Kari Nordmann", "Trond Nordmann", "Heidi Nordmann"];

async function signInFromLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Brukernavn eller e-post").fill(email);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn" }).click();
}

async function signOut(page: Page, email: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(email) }).click();
  await page.getByRole("menuitem", { name: "Logg ut" }).click();
  await page.waitForURL(/\/login$/);
}

// The click must land after React hydration: before that, the native focus
// moves but Radix never toggles selection, so retry until it takes.
async function openInactiveTab(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.getByRole("tab", { name: "Inaktive Brukere" }).click();
        return await page
          .getByRole("tab", { name: "Inaktive Brukere" })
          .getAttribute("aria-selected");
      },
      { timeout: 10_000 },
    )
    .toBe("true");
}

test.describe("Native user directory journey (spec 0057)", () => {
  test("renders the directory from native data per caller authority", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    // -- Admin journey -----------------------------------------------------
    await signInFromLogin(page, adminEmail, adminPassword);
    await page.waitForURL(/\/dashboard$/);

    // The directory renders BOTH tabs from native data. The seeded
    // multi-department person shows BOTH departments inside ONE row.
    await page.goto("/dashboard/brukere");
    const activeTable = page.getByRole("table").first();
    await expect(activeTable).toBeVisible();
    for (const header of columnHeaders) {
      await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
    }
    const monaRow = activeTable.getByRole("row").filter({ hasText: "Fjellheim" });
    await expect(monaRow).toHaveCount(1);
    await expect(monaRow).toContainText("Mona");
    // Both departments inside ONE Avdeling cell (order is not contractual).
    const monaDepartments = await monaRow
      .getByRole("cell")
      .filter({ hasText: /Trondheim|Oslo/ })
      .innerText();
    for (const department of ["Trondheim", "Oslo"]) {
      expect(monaDepartments).toContain(department);
    }
    // studyProgramme is null in this slice: the Studie column shows an em dash.
    await expect(monaRow.getByRole("cell").filter({ hasText: "—" })).toHaveCount(1);

    // The Inaktive tab shows the ended-membership person; no mock name
    // anywhere in either tab.
    await openInactiveTab(page);
    // Radix tabs unmount the hidden panel: exactly one table is mounted
    // after the switch, and it must hold the ended-membership person.
    const inactiveTable = page.getByRole("table");
    await expect(inactiveTable).toBeVisible();
    const gunnarRow = inactiveTable.getByRole("row").filter({ hasText: endedMemberLast });
    // studyProgramme is null here too: the em dash shows for the ended
    // member as well; no mock name appears anywhere.
    await expect(gunnarRow.getByRole("cell").filter({ hasText: "—" })).toHaveCount(1);
    for (const name of fixtureNames) {
      await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
    }

    // Sign out through the user menu.
    await signOut(page, adminEmail);
  });

  test("scopes a department leader to the union of leader departments", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await signInFromLogin(page, leader.email, leader.password);
    await page.waitForURL(/\/dashboard$/);
    await page.goto("/dashboard/brukere");

    // Scoped intersection: only Trondheim members reach the leader's view.
    const activeTable = page.getByRole("table").first();
    await expect(activeTable).toBeVisible();
    await expect(activeTable.getByRole("row").filter({ hasText: "Fjellheim" })).toHaveCount(1);
    await expect(activeTable.getByRole("row").filter({ hasText: "Medlem" })).toHaveCount(1);

    // The ended Trondheim member still appears, under Inaktive Brukere.
    await openInactiveTab(page);
    const inactiveTable = page.getByRole("table");
    await expect(inactiveTable.getByRole("row").filter({ hasText: endedMemberLast })).toHaveCount(
      1,
    );

    // No cross-department row leaks into the scoped view.
    await expect(page.getByRole("row").filter({ hasText: osloOnlyLast })).toHaveCount(0);

    await signOut(page, leader.email);
  });

  test("denies a plain member without fixture fallback", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await signInFromLogin(page, plainMember.email, plainMember.password);
    await page.waitForURL(/\/dashboard$/);
    await page.goto("/dashboard/brukere");

    // Typed denial state — and no fixture fallback anywhere.
    await expect(page.getByRole("alert")).toContainText("ikke tilgang til brukerlisten");
    for (const name of [...fixtureNames, "Fjellheim", osloOnlyLast]) {
      await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
    }
  });
});
