import { expect, test, type Page } from "@playwright/test";

const nativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

// Journey personas provisioned by e2e/native-team-interest-mailing-list-seed.mjs.
const password = "journey-secret-0123456789abcdef";
const adminEmail = "admin.0059@example.invalid";
const leaderEmail = "leader.0059@example.invalid";
const memberEmail = "member.0059@example.invalid";
const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8790";

const signIn = async (page: Page, email: string) => {
  await page.goto("/login");
  await page.getByLabel("Brukernavn eller e-post").fill(email);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn" }).click();
  await page.waitForURL(/\/dashboard$/);
};

test.describe("Native mailing-lists journey (spec 0060)", () => {
  test("admin reads team-type lists from the native projection", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await signIn(page, adminEmail);
    await page.goto("/dashboard/epostliste");

    // The page flattens lists into (name, email) rows. The dashboard requests
    // no type parameter, so the native default type=assistants applies; with
    // no assistant facts seeded, every department still emits its list with
    // zero emails — an empty-list rendering is a success value per spec 0060.
    await expect(page.getByRole("heading", { name: "E-postliste" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "No results.", exact: true })).toBeVisible();

    // The native endpoint itself answers with seeded member emails under the
    // expected list names for type=team and type=all (direct projection read).
    const teamLists = (await page.request.get(
      `${apiOrigin}/api/admin/mailing-lists?type=team`,
    )) as unknown as {
      status(): number;
      json(): Promise<Array<{ name: string; emails: Array<string> }>>;
    };
    expect(teamLists.status()).toBe(200);
    const lists = await teamLists.json();
    // One list per department in the authorized scope, named {type}-{id}.
    const trondheim = lists.find((list) => list.name === "team-department-0059-trondheim");
    const bergen = lists.find((list) => list.name === "team-department-0059-bergen");
    expect(trondheim?.emails).toEqual([
      "astrid.admin@example.invalid",
      "lars.leader@example.invalid",
      "mona.member@example.invalid",
      "tiril.team@example.invalid",
      "torunn.team@example.invalid",
    ]);
    // Bergen's only team member (its leader) has no contact profile, so its
    // list survives with zero emails — an empty list is a real success value.
    expect(bergen?.emails).toEqual([]);
  });

  test("leader scope renders only own-department data", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await signIn(page, leaderEmail);
    const response = await page.request.get(`${apiOrigin}/api/admin/mailing-lists?type=team`);
    expect(response.status()).toBe(200);
    const lists = (await response.json()) as Array<{ name: string; emails: string[] }>;
    expect(lists.map((list) => list.name)).toEqual(["team-department-0059-trondheim"]);

    // The page itself renders from the same scoped projection.
    await page.goto("/dashboard/epostliste");
    await expect(page.getByRole("heading", { name: "E-postliste" })).toBeVisible();
  });

  test("plain member receives the typed denial without fixture fallback", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await signIn(page, memberEmail);
    await page.goto("/dashboard/epostliste");

    // Typed 403 surfaces as the route error boundary; no fixture list may leak.
    await expect(page.getByRole("heading", { name: /Feil|\d{3}/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: "first@example.invalid" })).toHaveCount(0);
  });

  test("unknown type denies with 422 before any data leaves the store", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    const anonymous = await page.request.get(`${apiOrigin}/api/admin/mailing-lists`);
    expect(anonymous.status()).toBe(401);

    await signIn(page, adminEmail);
    const invalidType = await page.request.get(`${apiOrigin}/api/admin/mailing-lists?type=bogus`);
    expect(invalidType.status()).toBe(422);
    expect(await invalidType.json()).toEqual({
      error: { tag: "OrganizationDecodeError" },
    });
  });
});
