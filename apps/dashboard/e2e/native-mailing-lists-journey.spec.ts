import { DepartmentId, SemesterId } from "@vektorprogrammet/domain";
import { nativeScriptClient } from "@vektorprogrammet/rpc/script";
import { expect, test, type Page } from "@playwright/test";

const nativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

// Personas and canonical semesters come from native-team-interest-mailing-list-seed.mjs.
const password = "journey-secret-0123456789abcdef";

const adminEmail = "admin.0059@example.invalid";

const leaderEmail = "leader.0059@example.invalid";

const memberEmail = "member.0059@example.invalid";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8790";

const selectedSemester = SemesterId.make("semester-0060-selected");

const beforeAppointments = SemesterId.make("semester-0060-before-appointments");

const trondheim = DepartmentId.make("department-0059-trondheim");

const bergen = DepartmentId.make("department-0059-bergen");

const native = nativeScriptClient(apiOrigin);

/** The browser's cookies and the dashboard origin, which a native RPC takes from the page. */
const pageHeaders = async (page: Page, baseURL: string | undefined) => ({
  cookie: (await page.context().cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join("; "),
  origin: new URL(baseURL ?? page.url()).origin,
});

const teamEmails = [
  "astrid.admin@example.invalid",
  "lars.leader@example.invalid",
  "mona.member@example.invalid",
  "tiril.team@example.invalid",
  "torunn.team@example.invalid",
];

const signIn = async (page: Page, email: string) => {
  await page.goto("/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn" }).click();
  await page.waitForURL(/\/dashboard$/);
};

test.describe("Native scoped mailing recipients", () => {
  test.skip(!nativeIdentityMode, "requires the real native identity topology");

  test.afterAll(() => native.dispose());

  test("selection controls expose copyable recipients and retain filters after reload", async ({
    page,
    baseURL,
  }) => {
    await signIn(page, adminEmail);
    await page.goto(`/dashboard/epostliste?semester=${selectedSemester}`);
    await page.getByLabel("Avdeling", { exact: true }).selectOption(trondheim);
    await page.getByLabel("Semester", { exact: true }).selectOption(selectedSemester);
    await page.getByLabel("Mottakere", { exact: true }).selectOption("team");
    await page.getByRole("button", { name: "Vis e-postliste" }).click();

    const recipients = page.getByRole("textbox", { name: "E-postadresser", exact: true });

    await expect(recipients).toHaveValue(teamEmails.join(", "));
    await expect(recipients).toHaveAttribute("readonly", "");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("department")).toBe(trondheim);
    expect(new URL(page.url()).searchParams.get("semester")).toBe(selectedSemester);
    expect(new URL(page.url()).searchParams.get("type")).toBe("team");
    await page.reload();
    await expect(page.getByLabel("Avdeling", { exact: true })).toHaveValue(trondheim);
    await expect(page.getByLabel("Semester", { exact: true })).toHaveValue(selectedSemester);
    await expect(page.getByLabel("Mottakere", { exact: true })).toHaveValue("team");
    await expect(recipients).toHaveValue(teamEmails.join(", "));

    await page.getByLabel("Semester", { exact: true }).selectOption(beforeAppointments);
    await page.getByRole("button", { name: "Vis e-postliste" }).click();
    await expect(page).toHaveURL(new RegExp(`semester=${beforeAppointments}`));
    await expect(recipients).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);

    const response = await native.call(await pageHeaders(page, baseURL), (client) =>
      client["organization.listMailingLists"]({
        departmentId: trondheim,
        semesterId: beforeAppointments,
        type: "team",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.ok && response.value).toEqual([{ name: `team-${trondheim}`, emails: [] }]);

    await page.goto(`/dashboard/epostliste?department=${trondheim}&semester=unknown&type=team`);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(recipients).toHaveCount(0);
  });

  test("public department choices never expand a leader's recipient authority", async ({
    page,
    baseURL,
  }) => {
    await signIn(page, leaderEmail);
    await page.goto(
      `/dashboard/epostliste?department=${trondheim}&semester=${selectedSemester}&type=team`,
    );
    await expect(page.getByRole("textbox", { name: "E-postadresser", exact: true })).toHaveValue(
      teamEmails.join(", "),
    );
    await page.getByLabel("Avdeling", { exact: true }).selectOption(bergen);
    await page.getByRole("button", { name: "Vis e-postliste" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "E-postadresser", exact: true })).toHaveCount(0);

    const response = await native.call(await pageHeaders(page, baseURL), (client) =>
      client["organization.listMailingLists"]({
        departmentId: bergen,
        semesterId: selectedSemester,
        type: "team",
      }),
    );

    expect(response.status).toBe(403);
    expect(response.ok ? undefined : response.code).toBe("authority.denied");
  });

  test("ordinary membership does not permit recipient reads", async ({ page, baseURL }) => {
    await signIn(page, memberEmail);
    await page.goto(`/dashboard/epostliste?semester=${selectedSemester}&type=team`);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "E-postadresser", exact: true })).toHaveCount(0);

    const response = await native.call(await pageHeaders(page, baseURL), (client) =>
      client["organization.listMailingLists"]({ semesterId: selectedSemester, type: "team" }),
    );

    expect(response.status).toBe(403);
    expect(response.ok ? undefined : response.code).toBe("authority.denied");
  });

  // An invalid cohort no longer reaches the backend: the RPC payload schema admits only the
  // declared list types, so the typed client cannot send one.
  test("anonymous access fails at its boundary", async ({ baseURL }) => {
    const anonymous = await native.call(
      { origin: new URL(baseURL ?? apiOrigin).origin },
      (client) => client["organization.listMailingLists"]({}),
    );

    expect(anonymous.status).toBe(401);
    expect(anonymous.ok ? undefined : anonymous.code).toBe("credential.missing");
  });
});
