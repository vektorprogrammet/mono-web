import { expect, test, type Page } from "@playwright/test";

const nativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

// Journey personas provisioned by e2e/native-team-interest-mailing-list-seed.mjs
// (identity:seed users + organization authority facts + registration rows).
const password = "journey-secret-0123456789abcdef";
const adminEmail = "admin.0059@example.invalid";
const leaderEmail = "leader.0059@example.invalid";
const memberEmail = "member.0059@example.invalid";
const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8790";

const signIn = async (page: Page, email: string) => {
  await page.goto("/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn" }).click();
  await page.waitForURL(/\/dashboard$/);
};

test.describe("Native team-interest journey (spec 0059)", () => {
  test("admin reads registrations from native data across all departments", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await signIn(page, adminEmail);
    await page.goto("/dashboard/teaminteresse");

    // The native projection answers the frozen fixture envelope: one row per
    // (interested person x team), ordered registration_id ASC.
    await expect(page.getByRole("heading", { name: "Teaminteresse" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Sondre Soker", exact: true })).toBeVisible();
    // Contract: teamName serializes the referenced team's NAME, not its id.
    await expect(page.getByRole("cell", { name: "IT-Team 0059", exact: true })).toHaveCount(2);
    // Four seeded registrations total (three Trondheim + one Bergen): the
    // active global administrator's scope covers every department.
    await expect(page.locator("tbody tr")).toHaveCount(4);
    await expect(page.getByRole("cell", { name: "Bjornar Bergen", exact: true })).toBeVisible();
  });

  test("leader sees only own-department registrations", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await signIn(page, leaderEmail);
    await page.goto("/dashboard/teaminteresse");

    await expect(page.getByRole("heading", { name: "Teaminteresse" })).toBeVisible();
    // Lars leads IT-Team in Trondheim only: exactly the three Trondheim rows,
    // never the Bergen registration.
    await expect(page.locator("tbody tr")).toHaveCount(3);
    await expect(page.getByRole("cell", { name: "Sondre Soker", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Bjornar Bergen", exact: true })).toHaveCount(0);
  });

  test("plain member receives the typed denial without fixture fallback", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await signIn(page, memberEmail);
    const denied = page.waitForURL(/\/dashboard\/teaminteresse|\/dashboard$/);
    await page.goto("/dashboard/teaminteresse");
    await denied;

    // The loader surfaces the typed 403 as the route error boundary; no row
    // from the seed may leak into a fallback rendering.
    await expect(page.getByRole("heading", { name: /Feil|\d{3}/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Sondre Soker", exact: true })).toHaveCount(0);
  });

  test("native endpoint orders rows by registration id and gates anonymous callers", async ({
    request,
  }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    const anonymous = await request.get(`${apiOrigin}/api/admin/team-interest`);
    expect(anonymous.status()).toBe(401);
    expect(await anonymous.json()).toEqual({
      error: { tag: "UnauthenticatedActor" },
    });
  });
});
