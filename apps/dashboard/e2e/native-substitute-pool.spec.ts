import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const manifestPath = process.env.SUBSTITUTE_JOURNEY_MANIFEST;
const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
const scopePath = (semesterId: string) =>
  `/dashboard/vikarer?${new URLSearchParams({ departmentId: manifest.departmentId, semesterId })}`;
const signIn = async (page: Page, person: { email: string; password: string }) => {
  await page.goto(
    `${manifest.dashboardOrigin}/dashboard/login?redirectTo=${encodeURIComponent("/vikarer")}`,
  );
  await page.getByLabel("E-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Vikarer", exact: true })).toBeVisible();
};
const axe = async (page: Page, state: string) => {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations, `${state}: ${JSON.stringify(result.violations)}`).toEqual([]);
};
const selectHistorical = async (page: Page) => {
  await page.getByLabel("Avdeling", { exact: true }).selectOption(manifest.departmentId);
  await page.getByLabel("Semester", { exact: true }).selectOption(manifest.semesterId);
  await page.getByRole("button", { name: "Vis vikarer" }).click();
  await expect(page).toHaveURL(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
};
const card = (page: Page) => page.getByRole("article", { name: "Sofie Søker", exact: true });
const declare = async (page: Page, year = "3") => {
  for (const label of ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag"])
    await card(page)
      .getByLabel(label, { exact: true })
      .selectOption(label === "Mandag" ? "true" : "false");
  await card(page).getByLabel("Undervisningsspråk").selectOption("Norwegian");
  await card(page).getByLabel("Studieår").fill(year);
};
const readEntry = async (page: Page) => {
  const response = await page.request.get(
    `${manifest.backendOrigin}/api/substitutes/${manifest.applicationId}`,
    { headers: { Origin: manifest.dashboardOrigin } },
  );
  expect(response.status()).toBe(200);
  return response.json();
};

test("0094 coordinator manages a real persisted substitute pool", async ({ browser }) => {
  test.skip(!manifest, "Requires the isolated native substitute lifecycle driver");
  test.setTimeout(150_000);
  const leader = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const member = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const wrong = await browser.newContext();
  const anonymous = await browser.newContext();
  const page = await leader.newPage();
  const gates: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const anon = await anonymous.newPage();
    await anon.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(anon).toHaveURL(/\/login/);
    gates.push("anonymous browser is redirected to sign-in");
    await signIn(page, manifest.persons.leader);
    await axe(page, "explicit scope selection");
    await page.getByLabel("Avdeling", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Semester", { exact: true })).toBeFocused();
    await selectHistorical(page);
    await page.getByLabel("Søker", { exact: true }).selectOption(manifest.applicationId);
    await expect(card(page).getByLabel("Mandag", { exact: true })).toHaveValue("");
    await expect(card(page).getByLabel("Undervisningsspråk")).toHaveValue("");
    await card(page).getByRole("button", { name: "Legg til som vikar" }).click();
    await expect(card(page).getByLabel("Mandag", { exact: true })).toBeFocused();
    expect((await readEntry(page)).active).toBe(false);
    await declare(page);
    await axe(page, "explicit candidate preferences");
    let posts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/vikarer.data"))
        posts += 1;
    });
    const beforePosts = posts;
    await card(page)
      .getByRole("button", { name: "Legg til som vikar" })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(
      page.getByRole("status").filter({ hasText: "Vikaren er lagt til." }),
    ).toBeVisible();
    expect(posts - beforePosts).toBe(1);
    await expect(
      page.getByRole("status").filter({ hasText: "Vikaren er lagt til." }),
    ).toBeInViewport({ ratio: 1 });
    await page.reload();
    await expect(card(page).getByRole("button", { name: "Lagre endringer" })).toBeVisible();
    const activated = await readEntry(page);
    expect(activated.active).toBe(true);
    expect(activated.preferences).toEqual({
      monday: true,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      language: "Norwegian",
    });
    gates.push(
      "explicit preference validation, keyboard selection, pending duplicate suppression, activation and reload",
    );

    // An independently authenticated browser creates a real stale-version rejection.
    const concurrent = await other.newPage();
    await signIn(concurrent, manifest.persons.leader);
    await concurrent.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await card(page).getByLabel("Studieår").fill("4");
    await card(page).getByLabel("Undervisningsspråk").selectOption("English");
    await card(page).getByLabel("Tirsdag", { exact: true }).selectOption("true");
    await card(concurrent).getByLabel("Studieår").fill("5");
    await card(concurrent).getByRole("button", { name: "Lagre endringer" }).click();
    await expect(
      concurrent.getByRole("status").filter({ hasText: "Opplysningene er lagret." }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await card(page).getByRole("button", { name: "Lagre endringer" }).click();
    await expect(card(page).getByRole("alert")).toContainText("Utkastet ditt er beholdt");
    await expect(card(page).getByLabel("Studieår")).toHaveValue("4");
    await expect(card(page).getByLabel("Undervisningsspråk")).toHaveValue("English");
    await expect(card(page).getByLabel("Tirsdag", { exact: true })).toHaveValue("true");
    await expect(card(page).getByRole("alert")).toBeInViewport({ ratio: 1 });
    await axe(page, "mobile stale rejected draft");
    const rejectedKey = await card(page).locator('input[name="commandId"]').inputValue();
    const retryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/vikarer.data"),
    );
    await card(page).getByRole("button", { name: "Lagre endringer" }).click();
    await (await retryResponse).finished();
    await expect(card(page).getByRole("button", { name: "Lagre endringer" })).toBeEnabled();
    expect(await card(page).locator('input[name="commandId"]').inputValue()).toBe(rejectedKey);
    expect((await readEntry(page)).yearOfStudy).toBe(5);
    await expect(card(page).getByLabel("Studieår")).toHaveValue("4");
    await card(page).getByRole("button", { name: "Hent siste versjon", exact: true }).click();
    await expect(card(page).getByText(/Siste lagrede versjon: studieår 5/)).toBeVisible();
    await card(page).getByRole("button", { name: "Bruk siste versjon med mitt utkast" }).click();
    await card(page).getByRole("button", { name: "Lagre endringer" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Opplysningene er lagret." }),
    ).toBeVisible();
    await page.reload();
    await expect(card(page).getByLabel("Studieår")).toHaveValue("4");
    expect((await readEntry(page)).preferences.language).toBe("English");
    // Consecutive successes on the same mounted form must use the latest ETag and a new command.
    for (const available of ["true", "false"]) {
      await card(page).getByLabel("Fredag", { exact: true }).selectOption(available);
      await card(page).getByRole("button", { name: "Lagre endringer" }).click();
      await expect
        .poll(async () => (await readEntry(page)).preferences.friday)
        .toBe(available === "true");
      await expect(
        page.getByRole("status").filter({ hasText: "Opplysningene er lagret." }),
      ).toBeInViewport({ ratio: 1 });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    gates.push(
      "two real browser versions conflict; draft retained; unchanged failed retry preserves its key; explicit version refresh and consecutive successful edits persist canonical year/language/weekdays",
    );

    // A real concurrent removal moves the application out of the active list.
    // The rejected editor must retain its input without claiming or restoring activity.
    await concurrent.reload();
    await card(page).getByLabel("Onsdag", { exact: true }).selectOption("true");
    await card(concurrent).getByRole("button", { name: "Fjern fra vikaroversikten" }).click();
    await expect(
      concurrent.getByRole("status").filter({ hasText: "Søknaden og opplysningene er bevart." }),
    ).toBeVisible();
    await card(page).getByRole("button", { name: "Lagre endringer" }).click();
    await expect(card(page).getByRole("alert")).toContainText("Søkeren er ikke lenger aktiv vikar");
    await expect(card(page).getByLabel("Onsdag", { exact: true })).toHaveValue("true");
    expect((await readEntry(page)).active).toBe(false);
    await expect(card(page).getByRole("button", { name: "Lagre endringer" })).toHaveCount(0);
    await card(page).getByRole("button", { name: "Hent siste versjon", exact: true }).click();
    await card(page).getByRole("button", { name: "Bruk siste versjon med mitt utkast" }).click();
    await card(page).getByRole("button", { name: "Legg til som vikar" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Vikaren er lagt til." }),
    ).toBeVisible();
    expect((await readEntry(page)).preferences.wednesday).toBe(true);
    await card(page).getByLabel("Onsdag", { exact: true }).selectOption("false");
    await card(page).getByRole("button", { name: "Lagre endringer" }).click();
    await expect.poll(async () => (await readEntry(page)).preferences.wednesday).toBe(false);
    await expect(
      page.getByRole("status").filter({ hasText: "Opplysningene er lagret." }),
    ).toBeVisible();
    gates.push(
      "real concurrent deactivation preserves the rejected draft; explicit activation is required to return to the pool",
    );

    await card(page).getByRole("button", { name: "Fjern fra vikaroversikten" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Søknaden og opplysningene er bevart." }),
    ).toBeVisible();
    await page.reload();
    await expect(card(page)).toHaveCount(0);
    const inactive = await readEntry(page);
    expect(inactive.active).toBe(false);
    expect(inactive.yearOfStudy).toBe(4);
    expect(inactive.preferences.language).toBe("English");
    await page.getByLabel("Søker", { exact: true }).selectOption(manifest.applicationId);
    await expect(card(page).getByLabel("Tirsdag", { exact: true })).toHaveValue("true");
    await card(page).getByRole("button", { name: "Legg til som vikar" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Vikaren er lagt til." }),
    ).toBeVisible();
    await page.reload();
    expect((await readEntry(page)).active).toBe(true);
    await axe(page, "reactivated pool");
    await page.screenshot({
      path: join(manifest.artifacts, "substitute-leader.png"),
      fullPage: true,
    });
    gates.push(
      "deactivation preserves preferences and application; explicit reactivation survives reload",
    );

    await page.goto(`${manifest.dashboardOrigin}${scopePath(manifest.secondSemesterId)}`);
    await expect(card(page)).toHaveCount(0);
    await page.goto(`${manifest.dashboardOrigin}${scopePath(manifest.noPeriodSemesterId)}`);
    await expect(
      page.getByText("Det finnes ingen opptaksperiode for valgt avdeling og semester."),
    ).toBeVisible();
    gates.push(
      "historical scope is independent and a semester without a period is honestly unavailable",
    );

    const readOnly = await member.newPage();
    await signIn(readOnly, manifest.persons.member);
    await readOnly.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(readOnly.getByText(/Du har lesetilgang/)).toBeVisible();
    await expect(card(readOnly)).toBeVisible();
    await expect(readOnly.getByRole("button", { name: "Lagre endringer" })).toHaveCount(0);
    await expect(readOnly.getByLabel("Søker", { exact: true })).toHaveCount(0);
    const selected = await readEntry(readOnly);
    const denied = await readOnly.request.post(
      `${manifest.backendOrigin}/api/substitutes/${manifest.applicationId}:deactivate`,
      {
        headers: {
          Origin: manifest.dashboardOrigin,
          "Idempotency-Key": "browser-member-denied-0094",
          "If-Match": selected.etag,
        },
        data: {},
      },
    );
    expect(denied.status()).toBe(403);
    await axe(readOnly, "read-only pool");
    await readOnly.setViewportSize({ width: 390, height: 844 });
    await axe(readOnly, "mobile read-only pool");
    await readOnly.screenshot({
      path: join(manifest.artifacts, "substitute-member-mobile.png"),
      fullPage: true,
    });
    const forbidden = await wrong.newPage();
    await signIn(forbidden, manifest.persons.wrongDepartment);
    await forbidden.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(forbidden.getByRole("alert")).toContainText("Velg en avdeling du har tilgang til");
    await expect(card(forbidden)).toHaveCount(0);
    gates.push(
      "read-only controls and real backend mutation denial; wrong-department scope denied; mobile accessibility",
    );
    expect(pageErrors).toEqual([]);
    await writeFile(
      join(manifest.artifacts, "browser-evidence.json"),
      JSON.stringify(
        {
          specId: "0094",
          revision: manifest.revision,
          passed: true,
          runtime:
            "production React Router dashboard + real native Bun backend + PostgreSQL; Chromium",
          gates,
          finalExpected: {
            applicationId: manifest.applicationId,
            active: true,
            yearOfStudy: 4,
            preferences: {
              monday: true,
              tuesday: true,
              wednesday: false,
              thursday: false,
              friday: false,
              language: "English",
            },
          },
          pageErrors,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all([leader, other, member, wrong, anonymous].map((context) => context.close()));
  }
});
