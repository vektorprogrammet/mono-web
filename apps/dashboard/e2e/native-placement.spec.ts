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
  const landmarks = await page.locator("form[aria-label]").evaluateAll((forms) =>
    forms.map((form) => ({
      label: form.getAttribute("aria-label"),
      action: form.getAttribute("action"),
    })),
  );
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
    `${state}; form landmarks: ${JSON.stringify(landmarks)}`,
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
  await expect(form).toHaveAttribute("data-pending", "true");
  await expect(form).toHaveAttribute("data-pending", "false");
  await expect(form.getByRole("status")).toHaveText("Endringen er lagret.");
};
const submittedAndRemoved = async (form: Locator) => {
  await expect(form).toHaveAttribute("data-pending", "true");
  await expect(form).toHaveCount(0);
};
const readBoard = async (page: Page) => {
  const response = await page.request.get(
    `${manifest.backendOrigin}/api/placements?${new URLSearchParams({ departmentId: manifest.departmentId, semesterId: manifest.semesterId })}`,
    { headers: { origin: manifest.dashboardOrigin } },
  );
  expect(response.status()).toBe(200);
  return response.json();
};
const readCoverageBoard = async (page: Page) => {
  const response = await page.request.get(
    `${manifest.backendOrigin}/api/placements/coverage?${new URLSearchParams({
      departmentId: manifest.departmentId,
      semesterId: manifest.semesterId,
    })}`,
    { headers: { origin: manifest.dashboardOrigin } },
  );
  expect(response.status()).toBe(200);
  return response.json();
};

test("0096 placement, 0110 school-service, and 0111 coverage journeys persist with explicit authority", async ({
  browser,
}) => {
  test.skip(!manifest, "Requires the isolated native placement driver");
  test.setTimeout(180_000);
  const coordinator = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const volunteer = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const concurrent = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const wrong = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const substitute = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const anonymous = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const contexts = [coordinator, volunteer, concurrent, wrong, substitute, anonymous];
  contexts.forEach((context) => context.setDefaultTimeout(10_000));
  const page = await coordinator.newPage(),
    self = await volunteer.newPage(),
    other = await concurrent.newPage();
  const gates: string[] = [];
  const errors: string[] = [];
  const monitor = (current: Page) => current.on("pageerror", (error) => errors.push(error.message));
  for (const current of [page, self, other]) monitor(current);
  try {
    const anon = await anonymous.newPage();
    monitor(anon);
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
    expect(await self.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
      true,
    );
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
    monitor(wrongPage);
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
    const proposalAction = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/assistenter.data"),
    );
    await generate.getByRole("button", { name: "Lag forslag fra aktive plasseringer" }).click();
    const proposalActionBody = await (await proposalAction).text();
    expect(proposalActionBody, proposalActionBody).toContain("Endringen er lagret.");
    await page.reload();
    const proposalArticle = page.locator("[data-proposal-id]");
    const serviceProposalId = await proposalArticle.getAttribute("data-proposal-id");
    expect(serviceProposalId).toMatch(/^school-service-proposal-/);
    if (serviceProposalId === null) throw new Error("confirmed proposal id is missing");
    const ownAbsenceFormName = `Fravær: Skole Beta, Monday, bolk 2, tjenesteplan ${serviceProposalId.slice(-8)}, mitt fravær`;
    const coordinatorAbsenceFormName = `Fravær: Skole Beta, Monday, bolk 2, tjenesteplan ${serviceProposalId.slice(-8)}, koordinator`;
    await expect(proposalArticle).toContainText("2 av 4 frivillige");
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
    await expect(proposalArticle).toContainText("bekreftet");
    await staleConfirm.getByRole("button", { name: "Bekreft og send tjenesteplan" }).click();
    await expect(staleConfirm.getByRole("alert")).toContainText("Oversikten er endret");
    await expect
      .poll(
        async () => {
          await page.reload();
          return proposalArticle.textContent();
        },
        { timeout: 15_000 },
      )
      .toContain("Delivered");
    await self.reload();
    const ownAbsence = self.getByRole("form", {
      name: ownAbsenceFormName,
      exact: true,
    });
    await ownAbsence.getByLabel("Dato").focus();
    const reportAbsenceButton = ownAbsence.getByRole("button", {
      name: "Rapporter fravær",
      exact: true,
    });
    for (let step = 0; step < 4; step++) {
      if (await reportAbsenceButton.evaluate((button) => button.matches(":focus"))) break;
      await self.keyboard.press("Tab");
    }
    await expect(reportAbsenceButton).toBeFocused();
    let absencePosts = 0;
    self.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/assistenter.data") &&
        new URLSearchParams(request.postData() ?? "").get("action") === "ReportAbsence"
      )
        absencePosts++;
    });
    await ownAbsence.getByLabel("Dato").fill(manifest.coverage.serviceDate);
    await ownAbsence
      .getByRole("button", { name: "Rapporter fravær", exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await saved(ownAbsence);
    expect(absencePosts).toBe(1);
    await self.reload();
    await expect(
      self.getByRole("form", {
        name: ownAbsenceFormName,
        exact: true,
      }),
    ).toBeVisible();
    await axe(self, "own absence persisted on mobile");
    expect(await self.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
      true,
    );
    const reportedCoverage = await readCoverageBoard(page);
    const coveredAbsence = reportedCoverage.absences.find(
      (absence: { proposalId: string; personId: string; serviceDate: string }) =>
        absence.proposalId === serviceProposalId &&
        absence.personId === manifest.volunteerId &&
        absence.serviceDate === manifest.coverage.serviceDate,
    );
    expect(coveredAbsence).toBeDefined();
    await page.reload();
    const dispatchCovered = page.getByRole("form", {
      name: `Vikardispatch: ${coveredAbsence.absenceId}`,
      exact: true,
    });
    await dispatchCovered
      .getByRole("combobox", { name: "Kvalifisert vikar", exact: true })
      .selectOption(manifest.coverage.candidateId);
    await dispatchCovered.getByRole("button", { name: "Send vikartilbud", exact: true }).click();
    await submittedAndRemoved(dispatchCovered);
    await wrongPage.reload();
    await expect(
      wrongPage.getByRole("form", {
        name: `Vikartilbud: Skole Beta, ${manifest.coverage.serviceDate}, bolk 2`,
        exact: true,
      }),
    ).toHaveCount(0);
    const candidatePage = await substitute.newPage();
    monitor(candidatePage);
    await signIn(candidatePage, manifest.persons.candidate);
    await selectScope(candidatePage);
    await candidatePage.setViewportSize({ width: 390, height: 844 });
    const candidateOffer = candidatePage.getByRole("form", {
      name: `Vikartilbud: Skole Beta, ${manifest.coverage.serviceDate}, bolk 2`,
      exact: true,
    });
    await expect
      .poll(
        async () => {
          const coverage = await readCoverageBoard(page);
          const offer = coverage.offers.find(
            (item: { absenceId: string }) => item.absenceId === coveredAbsence.absenceId,
          );
          return coverage.dispatchNotifications.find(
            (notification: { offerId: string }) => notification.offerId === offer?.offerId,
          )?.status;
        },
        { timeout: 15_000 },
      )
      .toBe("Delivered");
    await candidatePage.reload();
    await expect(candidateOffer.locator("xpath=..")).toContainText("Levering: Levert");
    await candidateOffer.getByRole("button", { name: "Aksepter tilbud", exact: true }).click();
    await submittedAndRemoved(candidateOffer);
    await candidatePage.reload();
    const acceptedOfferArticle = candidatePage
      .getByRole("heading", {
        name: `Skole Beta, ${manifest.coverage.serviceDate} — Monday, bolk 2`,
        exact: true,
      })
      .locator("xpath=..");
    await expect(
      acceptedOfferArticle.getByText("Endelig svar: Akseptert", { exact: true }),
    ).toBeVisible();
    await axe(candidatePage, "addressed substitute offer on mobile");
    expect(
      await candidatePage.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
    ).toBe(true);
    await candidatePage.screenshot({
      path: join(manifest.artifacts, "coverage-substitute-mobile.png"),
      fullPage: true,
    });
    await page.reload();
    await other.reload();
    const acknowledgementName = `Dekningstilbud: ${manifest.coverage.candidateFirstName} ${manifest.coverage.candidateLastName}, ${manifest.coverage.serviceDate}`;
    const acknowledgeCoverage = page.getByRole("form", { name: acknowledgementName, exact: true });
    const staleAcknowledgement = other.getByRole("form", {
      name: acknowledgementName,
      exact: true,
    });
    await expect(acknowledgeCoverage).toContainText("Tilbudstatus: Akseptert");
    await acknowledgeCoverage.getByRole("button", { name: "Bekreft dekning", exact: true }).click();
    await submittedAndRemoved(acknowledgeCoverage);
    await staleAcknowledgement
      .getByRole("button", { name: "Bekreft dekning", exact: true })
      .click();
    await expect(staleAcknowledgement.getByRole("alert")).toContainText("Oversikten er endret");
    await staleAcknowledgement
      .getByRole("button", { name: "Hent oppdatert oversikt", exact: true })
      .click();
    await staleAcknowledgement
      .getByRole("button", { name: "Godta oppdatert versjon", exact: true })
      .click();
    await page.reload();
    const acknowledgedOfferArticle = page
      .getByRole("heading", {
        name: `Skole Beta, ${manifest.coverage.serviceDate} — Monday, bolk 2`,
        exact: true,
      })
      .locator("xpath=..");
    await expect(
      acknowledgedOfferArticle.getByText("Dekningen er bekreftet av koordinator.", {
        exact: true,
      }),
    ).toBeVisible();
    const closeCovered = page.getByRole("form", {
      name: `Tjenestelukking: Skole Beta, ${manifest.coverage.serviceDate}, bolk 2, tjenesteplan ${serviceProposalId.slice(-8)}`,
      exact: true,
    });
    await expect(closeCovered.getByLabel("Lina Lagleder møtte", { exact: true })).toBeChecked();
    await expect(
      closeCovered.getByLabel("Kari Kandidat (vikar) møtte", { exact: true }),
    ).toBeChecked();
    await closeCovered.getByRole("button", { name: "Lukk tjeneste", exact: true }).click();
    await submittedAndRemoved(closeCovered);
    await page.reload();
    await expect(
      page.getByText(`Skole Beta, ${manifest.coverage.serviceDate}, bolk 2 — Utfallet: Dekket`, {
        exact: true,
      }),
    ).toBeVisible();
    const leaderAbsence = page.getByRole("form", {
      name: coordinatorAbsenceFormName,
      exact: true,
    });
    await leaderAbsence.getByLabel("Dato").fill(manifest.coverage.secondServiceDate);
    await leaderAbsence.getByRole("button", { name: "Rapporter fravær", exact: true }).click();
    await saved(leaderAbsence);
    await page.reload();
    const afterLeaderAbsence = await readCoverageBoard(page);
    const uncoveredAbsence = afterLeaderAbsence.absences.find(
      (absence: { proposalId: string; personId: string; serviceDate: string }) =>
        absence.proposalId === serviceProposalId &&
        absence.personId === manifest.leaderId &&
        absence.serviceDate === manifest.coverage.secondServiceDate,
    );
    expect(uncoveredAbsence).toBeDefined();
    const dispatchUncovered = page.getByRole("form", {
      name: `Vikardispatch: ${uncoveredAbsence.absenceId}`,
      exact: true,
    });
    await dispatchUncovered
      .getByRole("combobox", { name: "Kvalifisert vikar", exact: true })
      .selectOption(manifest.coverage.candidateId);
    await dispatchUncovered.getByRole("button", { name: "Send vikartilbud", exact: true }).click();
    await submittedAndRemoved(dispatchUncovered);
    await expect
      .poll(
        async () => {
          const coverage = await readCoverageBoard(page);
          const offer = coverage.offers.find(
            (item: { absenceId: string; status: string }) =>
              item.absenceId === uncoveredAbsence.absenceId && item.status === "Offered",
          );
          return coverage.dispatchNotifications.find(
            (notification: { offerId: string }) => notification.offerId === offer?.offerId,
          )?.status;
        },
        { timeout: 15_000 },
      )
      .toBe("Delivered");
    await candidatePage.reload();
    const declinedOffer = candidatePage.getByRole("form", {
      name: `Vikartilbud: Skole Beta, ${manifest.coverage.secondServiceDate}, bolk 2`,
      exact: true,
    });
    await declinedOffer.getByRole("button", { name: "Avslå tilbud", exact: true }).click();
    await submittedAndRemoved(declinedOffer);
    await page.reload();
    const redispatch = page.getByRole("form", {
      name: `Vikardispatch: ${uncoveredAbsence.absenceId}`,
      exact: true,
    });
    await redispatch
      .getByRole("combobox", { name: "Kvalifisert vikar", exact: true })
      .selectOption(manifest.coverage.candidateId);
    await redispatch.getByRole("button", { name: "Send vikartilbud", exact: true }).click();
    await submittedAndRemoved(redispatch);
    await expect
      .poll(
        async () => {
          const coverage = await readCoverageBoard(page);
          const offer = coverage.offers.find(
            (item: { absenceId: string; status: string }) =>
              item.absenceId === uncoveredAbsence.absenceId && item.status === "Offered",
          );
          return coverage.dispatchNotifications.find(
            (notification: { offerId: string }) => notification.offerId === offer?.offerId,
          )?.status;
        },
        { timeout: 15_000 },
      )
      .toBe("Delivered");
    await page.reload();
    const withdrawOffer = page
      .getByRole("form", {
        name: `Dekningstilbud: ${manifest.coverage.candidateFirstName} ${manifest.coverage.candidateLastName}, ${manifest.coverage.secondServiceDate}`,
        exact: true,
      })
      .filter({ has: page.getByRole("button", { name: "Trekk tilbake tilbud", exact: true }) });
    await withdrawOffer.getByRole("button", { name: "Trekk tilbake tilbud", exact: true }).click();
    await submittedAndRemoved(withdrawOffer);
    await page.reload();
    const closeUncovered = page.getByRole("form", {
      name: `Tjenestelukking: Skole Beta, ${manifest.coverage.secondServiceDate}, bolk 2, tjenesteplan ${serviceProposalId.slice(-8)}`,
      exact: true,
    });
    await expect(
      closeUncovered.getByLabel("Irene Intervjuer møtte", { exact: true }),
    ).toBeChecked();
    await closeUncovered.getByRole("button", { name: "Lukk tjeneste", exact: true }).click();
    await submittedAndRemoved(closeUncovered);
    await page.reload();
    await expect(
      page.getByText(
        `Skole Beta, ${manifest.coverage.secondServiceDate}, bolk 2 — Utfallet: Ikke dekket`,
        { exact: true },
      ),
    ).toBeVisible();
    const finalCoverage = await readCoverageBoard(page);
    const coveredOccurrence = finalCoverage.occurrences.find(
      (occurrence: { proposalId: string; occurredOn: string }) =>
        occurrence.proposalId === serviceProposalId &&
        occurrence.occurredOn === manifest.coverage.serviceDate,
    );
    const uncoveredOccurrence = finalCoverage.occurrences.find(
      (occurrence: { proposalId: string; occurredOn: string }) =>
        occurrence.proposalId === serviceProposalId &&
        occurrence.occurredOn === manifest.coverage.secondServiceDate,
    );
    const coveredOfferFact = finalCoverage.offers.find(
      (offer: { absenceId: string }) => offer.absenceId === coveredAbsence.absenceId,
    );
    const declinedOfferFact = finalCoverage.offers.find(
      (offer: { absenceId: string; status: string }) =>
        offer.absenceId === uncoveredAbsence.absenceId && offer.status === "Declined",
    );
    const withdrawnOfferFact = finalCoverage.offers.find(
      (offer: { absenceId: string; status: string }) =>
        offer.absenceId === uncoveredAbsence.absenceId && offer.status === "Withdrawn",
    );
    const coveredAcknowledgement = finalCoverage.acknowledgements.find(
      (acknowledgement: { absenceId: string }) =>
        acknowledgement.absenceId === coveredAbsence.absenceId,
    );
    expect(coveredOccurrence).toBeDefined();
    expect(uncoveredOccurrence).toBeDefined();
    expect(coveredOfferFact).toBeDefined();
    expect(declinedOfferFact).toBeDefined();
    expect(withdrawnOfferFact).toBeDefined();
    expect(coveredAcknowledgement).toBeDefined();
    expect([...coveredOccurrence.attendedPersonIds].sort()).toEqual(
      [manifest.leaderId, manifest.coverage.candidateId].sort(),
    );
    expect([...uncoveredOccurrence.attendedPersonIds].sort()).toEqual([manifest.volunteerId]);
    const browserCoverageExpected = {
      duplicateSuppressionPosts: absencePosts,
      proposalId: serviceProposalId,
      coveredAbsenceId: coveredAbsence.absenceId,
      uncoveredAbsenceId: uncoveredAbsence.absenceId,
      coveredOfferId: coveredOfferFact.offerId,
      declinedOfferId: declinedOfferFact.offerId,
      withdrawnOfferId: withdrawnOfferFact.offerId,
      coveredAcknowledgementId: coveredAcknowledgement.acknowledgementId,
      occurrenceId: coveredOccurrence.occurrenceId,
      uncoveredOccurrenceId: uncoveredOccurrence.occurrenceId,
    };
    await page.setViewportSize({ width: 1280, height: 900 });
    await axe(page, "coordinator coverage closure desktop");
    await page.screenshot({
      path: join(manifest.artifacts, "coverage-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await axe(page, "coordinator coverage closure mobile");
    expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(
      true,
    );
    await page.screenshot({
      path: join(manifest.artifacts, "coverage-mobile.png"),
      fullPage: true,
    });
    gates.push(
      "two-person confirmed roster; own absence reload and duplicate suppression; scoped dispatch, addressed response, stale acknowledgement refresh, exact Covered closure",
    );
    gates.push(
      "wrong candidate invisibility; delivery remains distinct from acceptance; decline, sequential redispatch, withdrawal, exact Uncovered closure",
    );
    expect(errors).toEqual([]);
    gates.push(
      "remove retains audited row; affiliation revoke preserves other placement; keyboard, desktop/mobile Axe, screenshots, and no horizontal overflow",
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
          coverageExpected: browserCoverageExpected,
          pageErrors: errors,
          screenshots: [
            "placements-desktop.png",
            "placements-mobile.png",
            "coverage-desktop.png",
            "coverage-mobile.png",
            "coverage-substitute-mobile.png",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
