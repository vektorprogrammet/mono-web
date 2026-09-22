import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type Locator } from "@playwright/test";

const manifestPath = process.env.PLACEMENT_JOURNEY_MANIFEST;
const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
const scopePath = () =>
  `/dashboard/assistenter?${new URLSearchParams({ departmentId: manifest.departmentId, semesterId: manifest.semesterId })}`;
const signIn = async (page: Page, person: { email: string; password: string }) => {
  await page.goto(
    `${manifest.dashboardOrigin}/dashboard/login?redirectTo=${encodeURIComponent("/assistenter")}`,
  );
  await page.getByLabel("E-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Frivilligtilknytning og skoleplassering", exact: true }),
  ).toBeVisible();
};
const selectScope = async (page: Page) => {
  await page
    .getByRole("combobox", { name: "Avdeling", exact: true })
    .selectOption(manifest.departmentId);
  await page
    .getByRole("combobox", { name: "Semester", exact: true })
    .selectOption(manifest.semesterId);
  await page.getByRole("button", { name: "Vis valgt avdeling" }).click();
  await expect(page).toHaveURL(`${manifest.dashboardOrigin}${scopePath()}`);
};
const axe = async (page: Page, state: string) => {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
    state,
  ).toEqual([]);
};
const fillPlacement = async (form: Locator, block: string, day = "Monday", workdays = "4") => {
  await form
    .getByRole("combobox", { name: "Skole", exact: true })
    .selectOption(String(manifest.schoolId));
  await form.getByRole("combobox", { name: "Ukedag", exact: true }).selectOption(day);
  await form.getByLabel("Antall undervisningsdager").fill(workdays);
  await form.getByRole("combobox", { name: "Bolk", exact: true }).selectOption(block);
};
const saved = async (form: Locator) => {
  await expect(form).toHaveAttribute("data-pending", "false");
  await expect(form.getByRole("status")).toHaveText("Endringen er lagret.");
};
const readBoard = async (page: Page) => {
  const response = await page.request.get(
    `${manifest.backendOrigin}/api/placements?${new URLSearchParams({ departmentId: manifest.departmentId, semesterId: manifest.semesterId })}`,
    { headers: { origin: manifest.dashboardOrigin } },
  );
  expect(response.status()).toBe(200);
  return response.json();
};

test("0096 placement and 0110 school-service journeys persist with explicit authority", async ({
  browser,
}) => {
  test.skip(!manifest, "Requires the isolated native placement driver");
  test.setTimeout(150_000);
  const coordinator = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const volunteer = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const concurrent = await browser.newContext();
  const wrong = await browser.newContext();
  const anonymous = await browser.newContext();
  const contexts = [coordinator, volunteer, concurrent, wrong, anonymous];
  contexts.forEach((context) => context.setDefaultTimeout(10_000));
  const page = await coordinator.newPage(),
    self = await volunteer.newPage(),
    other = await concurrent.newPage();
  const gates: string[] = [];
  const errors: string[] = [];
  for (const p of [page, self, other]) p.on("pageerror", (error) => errors.push(error.message));
  try {
    const anon = await anonymous.newPage();
    await anon.goto(`${manifest.dashboardOrigin}${scopePath()}`);
    await expect(anon).toHaveURL(/\/login/);
    await signIn(self, manifest.persons.volunteer);
    await expect(
      self.getByRole("link", { name: "Frivilligtilknytning og plassering", exact: true }),
    ).toHaveCount(1);
    await selectScope(self);
    await self.setViewportSize({ width: 390, height: 844 });
    await expect(self.getByRole("form", { name: "Ny skoleplassering", exact: true })).toHaveCount(
      0,
    );
    await expect(self.getByText("Lina Lagleder", { exact: true })).toHaveCount(0);
    await axe(self, "no-team volunteer mobile self-request");
    const own = self.getByRole("form", { name: "Min tilknytning", exact: true });
    let ownPosts = 0;
    self.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/assistenter.data")
      )
        ownPosts++;
    });
    await own
      .getByRole("button", { name: "Be om tilknytning" })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await saved(own);
    expect(ownPosts).toBe(1);
    await self.reload();
    await expect(self.getByText("Status: Venter på godkjenning", { exact: true })).toBeVisible();
    gates.push(
      "anonymous redirect and no-team identity-only shell; own request persists without private directory",
    );
    await signIn(page, manifest.persons.leader);
    await page.getByRole("combobox", { name: "Avdeling", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: "Semester", exact: true })).toBeFocused();
    await selectScope(page);
    const affiliation = page.getByRole("form", {
      name: /^Tilknytning \d+: Irene Intervjuer$/,
    });
    await affiliation.getByRole("button", { name: "Godkjenn tilknytning" }).click();
    await saved(affiliation);
    await self.reload();
    await expect(self.getByText("Status: Aktiv", { exact: true })).toBeVisible();
    gates.push("coordinator establishes only explicitly requested Person affiliation");
    const wrongPage = await wrong.newPage();
    await signIn(wrongPage, manifest.persons.wrongDepartment);
    await selectScope(wrongPage);
    await expect(
      wrongPage.getByRole("form", { name: "Ny skoleplassering", exact: true }),
    ).toHaveCount(0);
    await expect(wrongPage.getByText("Irene Intervjuer", { exact: true })).toHaveCount(0);
    const create = page.getByRole("form", { name: "Ny skoleplassering", exact: true });
    await create
      .getByRole("combobox", { name: "Frivillig", exact: true })
      .selectOption(manifest.volunteerId);
    await fillPlacement(create, "1");
    await create.getByLabel("Antall undervisningsdager").fill("0");
    await create.getByRole("button", { name: "Opprett plassering" }).click();
    expect(
      (await readBoard(page)).placements.filter(
        (p: { personId: string }) => p.personId === manifest.volunteerId,
      ),
    ).toHaveLength(0);
    await create.getByLabel("Antall undervisningsdager").fill("4");
    await create.getByRole("button", { name: "Opprett plassering" }).click();
    await saved(create);
    await page.reload();
    const entry = page.getByRole("form", {
      name: /^Plassering \d+: Irene Intervjuer, Skole Beta, bolk 1,/,
    });
    await expect(entry.getByLabel("Antall undervisningsdager")).toHaveValue("4");
    const first = (await readBoard(page)).placements.find(
      (p: { personId: string; block: string }) =>
        p.personId === manifest.volunteerId && p.block === "1",
    );
    expect(first.active).toBe(true);
    expect(first.revision).toBe(1);
    await create
      .getByRole("combobox", { name: "Frivillig", exact: true })
      .selectOption(manifest.volunteerId);
    await fillPlacement(create, "2");
    await create.getByRole("button", { name: "Opprett plassering" }).click();
    await saved(create);
    const second = (await readBoard(page)).placements.find(
      (p: { personId: string; block: string }) =>
        p.personId === manifest.volunteerId && p.block === "2",
    );
    gates.push(
      "historical semester, invalid-value prevention, persisted creation and legitimate separate blocks",
    );
    await signIn(other, manifest.persons.leader);
    await selectScope(other);
    const otherEntry = other.getByRole("form", {
      name: /^Plassering \d+: Irene Intervjuer, Skole Beta, bolk 1,/,
    });
    await fillPlacement(entry, "1", "Wednesday", "7");
    await fillPlacement(otherEntry, "1", "Thursday", "6");
    await otherEntry.getByRole("button", { name: "Lagre plassering" }).click();
    await saved(otherEntry);
    await entry.getByRole("button", { name: "Lagre plassering" }).click();
    await expect(entry.getByRole("alert")).toContainText("Oversikten er endret");
    await expect(entry.getByLabel("Antall undervisningsdager")).toHaveValue("7");
    await entry.getByRole("button", { name: "Lagre plassering" }).click();
    await expect(entry.getByRole("alert")).toContainText("Oversikten er endret");
    await entry.getByRole("button", { name: "Hent oppdatert oversikt" }).click();
    await expect(entry.getByText(/Oppdatert oversikt:/)).toContainText("6 dager");
    await entry.getByRole("button", { name: "Godta oppdatert versjon" }).click();
    await expect(entry.getByLabel("Antall undervisningsdager")).toHaveValue("7");
    await expect(entry.getByRole("combobox", { name: "Ukedag", exact: true })).toHaveValue(
      "Wednesday",
    );
    await entry.getByRole("button", { name: "Lagre plassering" }).click();
    await saved(entry);
    expect(
      (await readBoard(page)).placements.find(
        (p: { placementId: string }) => p.placementId === first.placementId,
      ),
    ).toMatchObject({ day: "Wednesday", workdays: 7, revision: 3 });
    await selectScope(other);
    await expect(otherEntry.getByLabel("Antall undervisningsdager")).toHaveValue("7");
    await expect(otherEntry.getByRole("combobox", { name: "Ukedag", exact: true })).toHaveValue(
      "Wednesday",
    );
    await fillPlacement(entry, "1", "Friday", "8");
    await entry.getByRole("button", { name: "Lagre plassering" }).click();
    await saved(entry);
    expect(
      (await readBoard(page)).placements.find(
        (p: { placementId: string }) => p.placementId === first.placementId,
      ),
    ).toMatchObject({ day: "Friday", workdays: 8, revision: 4 });
    await page.reload();
    await expect(entry.getByLabel("Antall undervisningsdager")).toHaveValue("8");
    await axe(page, "coordinator persisted placements after explicit conflict recovery");
    await page.screenshot({
      path: join(manifest.artifacts, "placements-desktop.png"),
      fullPage: true,
    });
    gates.push(
      "two real browser sessions; unchanged stale retry denied, fresh conflict review preserves draft, repeated save persists",
    );
    await entry.getByRole("button", { name: "Fjern plassering" }).click();
    await saved(entry);
    await page.reload();
    await expect(entry.getByRole("button", { name: "Lagre plassering" })).toBeDisabled();
    await expect(
      entry.locator("xpath=..").getByText("Fjernet — historikken er bevart.", { exact: true }),
    ).toBeVisible();
    await affiliation.getByRole("button", { name: "Avslutt tilknytning" }).click();
    await saved(affiliation);
    await self.reload();
    await expect(self.getByText("Status: Inaktiv", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await axe(page, "mobile retained placement history");
    expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
      true,
    );
    await page.screenshot({
      path: join(manifest.artifacts, "placements-mobile.png"),
      fullPage: true,
    });
    const finalExpected = [
      {
        placementId: first.placementId,
        personId: manifest.volunteerId,
        schoolId: manifest.schoolId,
        semesterId: manifest.semesterId,
        day: "Friday",
        workdays: 8,
        block: "1",
        active: false,
        revision: 5,
      },
      {
        placementId: second.placementId,
        personId: manifest.volunteerId,
        schoolId: manifest.schoolId,
        semesterId: manifest.semesterId,
        day: "Monday",
        workdays: 4,
        block: "2",
        active: true,
        revision: 1,
      },
    ];
    const actual = (await readBoard(page)).placements.filter(
      (p: { personId: string }) => p.personId === manifest.volunteerId,
    );
    for (const expected of finalExpected)
      expect(
        actual.find((p: { placementId: string }) => p.placementId === expected.placementId),
      ).toMatchObject(expected);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    const demand = page.getByRole("form", { name: "Nytt skolebehov", exact: true });
    await demand
      .getByRole("combobox", { name: "Skole", exact: true })
      .selectOption(String(manifest.schoolId));
    await demand.getByRole("combobox", { name: "Ukedag", exact: true }).selectOption("Monday");
    await demand.getByRole("combobox", { name: "Bolk", exact: true }).selectOption("2");
    await demand.getByLabel("Frivillige som trengs").fill("4");
    await demand.getByRole("button", { name: "Legg til skolebehov" }).click();
    await saved(demand);
    await page.reload();
    const generate = page.getByRole("form", { name: "Lag nytt tjenesteforslag", exact: true });
    await generate.getByRole("button", { name: "Lag forslag fra aktive plasseringer" }).click();
    await page.reload();
    const proposalArticle = page.locator("[data-proposal-id]");
    const serviceProposalId = await proposalArticle.getAttribute("data-proposal-id");
    expect(serviceProposalId).toMatch(/^school-service-proposal-/);
    await expect(proposalArticle).toContainText("1 av 4 frivillige");
    const confirm = page.getByRole("form", { name: "Bekreft tjenesteforslag", exact: true });
    await confirm.getByRole("button", { name: "Bekreft og send tjenesteplan" }).click();
    await expect(confirm.getByRole("alert")).toContainText("Alle avvik må gjennomgås");
    for (const checkbox of await confirm.getByRole("checkbox").all()) await checkbox.check();
    await other.reload();
    const staleConfirm = other.getByRole("form", {
      name: "Bekreft tjenesteforslag",
      exact: true,
    });
    for (const checkbox of await staleConfirm.getByRole("checkbox").all()) await checkbox.check();
    await confirm.getByRole("button", { name: "Bekreft og send tjenesteplan" }).click();
    await saved(confirm);
    await staleConfirm.getByRole("button", { name: "Bekreft og send tjenesteplan" }).click();
    await expect(staleConfirm.getByRole("alert")).toContainText("Oversikten er endret");
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.getByText(/Delivered/).count();
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    const occurrence = page
      .getByRole("form", { name: /^Undervisning \d+: Skole Beta$/ })
      .filter({ hasText: "Skole Beta — Monday, bolk 2" });
    await occurrence.getByLabel("Dato").fill("2024-03-04");
    for (const checkbox of await occurrence.getByRole("checkbox").all()) await checkbox.check();
    await occurrence.getByRole("button", { name: "Registrer undervisning" }).click();
    await saved(occurrence);
    await page.reload();
    await expect(page.getByText(/Skole Beta, 2024-03-04, bolk 2:/)).toContainText("1 møtte");
    await axe(page, "confirmed school service with delivered notifications and occurrence");
    await page.screenshot({
      path: join(manifest.artifacts, "school-service-desktop.png"),
      fullPage: true,
    });
    gates.push(
      "school demand, unfilled exception, exact review, stale confirmation rejection, acknowledged delivery, exact attendance and reload",
    );
    expect(errors).toEqual([]);
    gates.push(
      "remove retains audited row; affiliation revoke preserves other placement; keyboard/mobile/Axe",
    );
    await writeFile(
      join(manifest.artifacts, "browser-evidence.json"),
      JSON.stringify(
        {
          passed: true,
          revision: manifest.revision,
          gates,
          finalExpected,
          serviceProposalId,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
