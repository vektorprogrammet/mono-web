import AxeBuilder from "@axe-core/playwright";
import type {
  CoverageCommand,
  OwnCoverageCommand,
  PlacementCommand,
} from "@vektorprogrammet/placements/contracts";
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
  await expect(form).toHaveAttribute("data-pending", "false");
  await expect(form.getByRole("status")).toHaveText("Endringen er lagret.");
};

const submittedAndRemoved = async (form: Locator) => {
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
  test.skip(!manifest || manifest.golden, "Requires the isolated broad placement driver");
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
    await demand.getByLabel("Frivillige som trengs").fill("2");
    await demand.getByRole("button", { name: "Legg til skolebehov" }).click();
    await saved(demand);
    await demand
      .getByRole("combobox", { name: "Skole", exact: true })
      .selectOption(String(manifest.schoolId));
    await demand.getByRole("combobox", { name: "Ukedag", exact: true }).selectOption("Tuesday");
    await demand.getByRole("combobox", { name: "Bolk", exact: true }).selectOption("1");
    await demand.getByLabel("Frivillige som trengs").fill("1");
    await demand.getByRole("button", { name: "Legg til skolebehov" }).click();
    await saved(demand);
    await expect
      .poll(async () =>
        (await readBoard(page)).demands.some(
          (item: { schoolId: number; day: string; block: string; requiredVolunteers: number }) =>
            item.schoolId === manifest.schoolId &&
            item.day === "Tuesday" &&
            item.block === "1" &&
            item.requiredVolunteers === 1,
        ),
      )
      .toBe(true);
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
    await expect(proposalArticle).toContainText("0 av 1 frivillige");
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
    await expect(
      page.getByRole("heading", { name: "Planlegg datert skoletjeneste" }),
    ).toBeVisible();

    const scheduleForm = page.locator(
      'form:has(input[name="action"][value="ScheduleService"]):has(input[name="block"][value="2"])',
    );

    const schedule = async (serviceDate: string) => {
      await scheduleForm.locator('input[type="date"]').fill(serviceDate);
      await scheduleForm.locator('input[type="time"]').nth(0).fill("09:00");
      await scheduleForm.locator('input[type="time"]').nth(1).fill("11:00");

      const [scheduleResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.includes("assistenter"),
        ),
        scheduleForm.getByRole("button", { name: "Planlegg denne datoen" }).click(),
      ]);

      expect(scheduleResponse.status()).toBe(200);
      await expect
        .poll(async () =>
          (await readBoard(page)).commitments.some(
            (item: { proposalId: string; serviceDate: string; schoolId: number; block: string }) =>
              item.proposalId === serviceProposalId &&
              item.serviceDate === serviceDate &&
              item.schoolId === manifest.schoolId &&
              item.block === "2",
          ),
        )
        .toBe(true);
      await page.reload();
      const board = await readBoard(page);

      const commitment = board.commitments.find(
        (item: { proposalId: string; serviceDate: string; schoolId: number; block: string }) =>
          item.proposalId === serviceProposalId &&
          item.serviceDate === serviceDate &&
          item.schoolId === manifest.schoolId &&
          item.block === "2",
      );

      expect(commitment).toBeDefined();
      expect(commitment.decision).toBeNull();

      return commitment;
    };

    const firstCommitment = await schedule(manifest.coverage.serviceDate);
    const secondCommitment = await schedule(manifest.coverage.secondServiceDate);
    const cancelledCommitment = await schedule(manifest.coverage.cancelledServiceDate);
    await self.reload();

    const ownAbsence = self.locator(
      `form:has(input[name="action"][value="ReportAbsence"]):has(input[name="commitmentId"][value="${firstCommitment.commitmentId}"])`,
    );

    const reportAbsenceButton = ownAbsence.getByRole("button", {
      name: "Rapporter fravær for denne tjenesten",
    });

    await reportAbsenceButton.focus();
    await expect(reportAbsenceButton).toBeFocused();
    let absencePosts = 0;
    self.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URLSearchParams(request.postData() ?? "").get("action") === "ReportAbsence"
      )
        absencePosts++;
    });
    await reportAbsenceButton.click();
    await expect
      .poll(async () =>
        (await readCoverageBoard(page)).absences.some(
          (item: { commitmentId: string; personId: string }) =>
            item.commitmentId === firstCommitment.commitmentId &&
            item.personId === manifest.volunteerId,
        ),
      )
      .toBe(true);
    expect(absencePosts).toBe(1);
    await self.reload();
    await axe(self, "own dated absence persisted on mobile");
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

    const offerTitle = (serviceDate: string) =>
      `Skole Beta, ${serviceDate} kl. 09:00–11:00 — Monday, bolk 2`;

    await wrongPage.reload();
    await expect(
      wrongPage.getByRole("form", {
        name: `Vikartilbud: ${offerTitle(manifest.coverage.serviceDate)}`,
        exact: true,
      }),
    ).toHaveCount(0);
    const candidatePage = await substitute.newPage();
    monitor(candidatePage);
    await signIn(candidatePage, manifest.persons.candidate);
    await selectScope(candidatePage);
    await candidatePage.setViewportSize({ width: 390, height: 844 });

    const candidateOffer = candidatePage.getByRole("form", {
      name: `Vikartilbud: ${offerTitle(manifest.coverage.serviceDate)}`,
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
        name: offerTitle(manifest.coverage.serviceDate),
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
    const acknowledgementName = `Dekningstilbud: ${manifest.coverage.candidateFirstName} ${manifest.coverage.candidateLastName}, ${offerTitle(manifest.coverage.serviceDate)}`;
    const acknowledgeCoverage = page.getByRole("form", { name: acknowledgementName, exact: true });

    const staleAcknowledgement = other.getByRole("form", {
      name: acknowledgementName,
      exact: true,
    });

    await expect(acknowledgeCoverage.locator("xpath=..")).toContainText("Tilbudstatus: Akseptert");
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
        name: offerTitle(manifest.coverage.serviceDate),
        exact: true,
      })
      .locator("xpath=..");

    await expect(
      acknowledgedOfferArticle.getByText("Dekningen er bekreftet av koordinator.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .locator(`article[data-commitment-id="${firstCommitment.commitmentId}"]`)
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();

    const completedForm = page.getByRole("form", {
      name: `Beslutning for Skole Beta, ${manifest.coverage.serviceDate} kl. 09:00–11:00, bolk 2`,
      exact: true,
    });

    await completedForm.locator("select").selectOption("CompleteService");
    await completedForm
      .locator(`input[name="attendedPersonId"][value="${manifest.leaderId}"]`)
      .check();
    await completedForm
      .locator(`input[name="attendedPersonId"][value="${manifest.coverage.candidateId}"]`)
      .check();
    await completedForm
      .locator('input[name="evidenceSource"]')
      .fill(`Skole Beta kontakt, telefon ${manifest.coverage.serviceDate}`);
    await completedForm.getByRole("button", { name: "Lagre uforanderlig beslutning" }).click();
    await submittedAndRemoved(completedForm);
    await page.reload();

    const completed = (await readCoverageBoard(page)).commitments.find(
      (item: { commitmentId: string }) => item.commitmentId === firstCommitment.commitmentId,
    );

    expect(completed.decision).toMatchObject({
      outcome: "Completed",
      evidenceSource: `Skole Beta kontakt, telefon ${manifest.coverage.serviceDate}`,
    });

    const leaderAbsence = page.locator(
      `form:has(input[name="action"][value="ReportAbsenceForVolunteer"]):has(input[name="commitmentId"][value="${secondCommitment.commitmentId}"])`,
    );

    await leaderAbsence
      .getByRole("combobox", { name: "Frivillig", exact: true })
      .selectOption(manifest.leaderId);
    await leaderAbsence.getByRole("button", { name: /Rapporter fravær/ }).click();
    await expect
      .poll(async () =>
        (await readCoverageBoard(page)).absences.some(
          (item: { commitmentId: string; personId: string }) =>
            item.commitmentId === secondCommitment.commitmentId &&
            item.personId === manifest.leaderId,
        ),
      )
      .toBe(true);
    await page.reload();
    const afterLeaderAbsence = await readCoverageBoard(page);

    const uncoveredAbsence = afterLeaderAbsence.absences.find(
      (item: { commitmentId: string; personId: string }) =>
        item.commitmentId === secondCommitment.commitmentId && item.personId === manifest.leaderId,
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
      name: `Vikartilbud: ${offerTitle(manifest.coverage.secondServiceDate)}`,
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
        name: `Dekningstilbud: ${manifest.coverage.candidateFirstName} ${manifest.coverage.candidateLastName}, ${offerTitle(manifest.coverage.secondServiceDate)}`,
        exact: true,
      })
      .filter({ has: page.getByRole("button", { name: "Trekk tilbake tilbud", exact: true }) });

    await withdrawOffer.getByRole("button", { name: "Trekk tilbake tilbud", exact: true }).click();
    await submittedAndRemoved(withdrawOffer);
    await page.reload();
    await page
      .locator(`article[data-commitment-id="${secondCommitment.commitmentId}"]`)
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();

    const unfulfilledForm = page.getByRole("form", {
      name: `Beslutning for Skole Beta, ${manifest.coverage.secondServiceDate} kl. 09:00–11:00, bolk 2`,
      exact: true,
    });

    await unfulfilledForm.locator("select").selectOption("MarkUnfulfilledService");
    await unfulfilledForm
      .locator(`input[name="attendedPersonId"][value="${manifest.volunteerId}"]`)
      .check();
    await unfulfilledForm
      .locator('input[name="evidenceSource"]')
      .fill(`Skole Beta kontakt, telefon ${manifest.coverage.secondServiceDate}`);
    await unfulfilledForm.locator('textarea[name="reason"]').fill("Bare én av to frivillige møtte");
    await unfulfilledForm.getByRole("button", { name: "Lagre uforanderlig beslutning" }).click();
    await submittedAndRemoved(unfulfilledForm);
    await page.reload();
    await page
      .locator(`article[data-commitment-id="${cancelledCommitment.commitmentId}"]`)
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();

    const cancelledForm = page.getByRole("form", {
      name: `Beslutning for Skole Beta, ${manifest.coverage.cancelledServiceDate} kl. 09:00–11:00, bolk 2`,
      exact: true,
    });

    await cancelledForm.locator("select").selectOption("CancelService");
    await cancelledForm
      .locator('input[name="evidenceSource"]')
      .fill(`Skole Beta kontakt, telefon ${manifest.coverage.cancelledServiceDate}`);
    await cancelledForm.locator('textarea[name="reason"]').fill("Skolen avlyste tjenesten");
    await cancelledForm.getByRole("button", { name: "Lagre uforanderlig beslutning" }).click();
    await submittedAndRemoved(cancelledForm);
    await page.reload();
    const finalCoverage = await readCoverageBoard(page);
    expect(
      finalCoverage.commitments.find(
        (item: { commitmentId: string }) => item.commitmentId === secondCommitment.commitmentId,
      )?.decision,
    ).toMatchObject({ outcome: "Unfulfilled", attendedPersonIds: [manifest.volunteerId] });
    expect(
      finalCoverage.commitments.find(
        (item: { commitmentId: string }) => item.commitmentId === cancelledCommitment.commitmentId,
      )?.decision,
    ).toMatchObject({
      outcome: "Cancelled",
      attendedPersonIds: [],
      reason: "Skolen avlyste tjenesten",
    });
    expect(
      finalCoverage.occurrences.filter(
        (item: { commitmentId: string }) => item.commitmentId === cancelledCommitment.commitmentId,
      ),
    ).toHaveLength(0);

    const coveredOccurrence = finalCoverage.occurrences.find(
      (item: { commitmentId: string }) => item.commitmentId === firstCommitment.commitmentId,
    );

    const uncoveredOccurrence = finalCoverage.occurrences.find(
      (item: { commitmentId: string }) => item.commitmentId === secondCommitment.commitmentId,
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
    expect(
      finalCoverage.closures.find(
        (item: { absenceId: string }) => item.absenceId === coveredAbsence.absenceId,
      )?.outcome,
    ).toBe("Covered");
    expect(
      finalCoverage.closures.find(
        (item: { absenceId: string }) => item.absenceId === uncoveredAbsence.absenceId,
      )?.outcome,
    ).toBe("Uncovered");

    const browserCoverageExpected = {
      absencePosts,
      proposalId: serviceProposalId,
      completedCommitmentId: firstCommitment.commitmentId,
      unfulfilledCommitmentId: secondCommitment.commitmentId,
      cancelledCommitmentId: cancelledCommitment.commitmentId,
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
      "confirmed two-person demand; scheduled dates; own absence and scoped dispatch; acknowledged actual attendance and Completed evidence",
    );
    gates.push(
      "decline, redispatch, withdrawal, partial Unfulfilled and cancellation without occurrence",
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

test("golden school-service continuous functional journey", async ({ browser }) => {
  test.skip(
    !manifest?.golden && process.env.GOLDEN_SCHOOL_SERVICE_REQUIRED !== "1",
    "Requires the golden lifecycle driver",
  );
  expect(manifest?.golden).toBe(true);
  test.setTimeout(240_000);

  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);

  const [coordinator, volunteer, wrong, freshVolunteer, staleCoordinator] = contexts;
  const page = await coordinator.newPage();
  const self = await volunteer.newPage();
  const outsider = await wrong.newPage();
  const steps: string[] = [];
  const http: { check: string; status: number; boundary: string }[] = [];
  const network: { method: string; path: string; status: number }[] = [];

  for (const context of contexts) {
    context.setDefaultTimeout(10_000);
    context.on("response", (response) => {
      const url = new URL(response.url());

      if (
        ["document", "fetch", "xhr"].includes(response.request().resourceType()) &&
        (url.origin === manifest.dashboardOrigin || url.origin === manifest.backendOrigin)
      )
        network.push({
          method: response.request().method(),
          path: url.pathname,
          status: response.status(),
        });
    });
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
  }

  const checkpoint = async (step: string) => {
    const response = await fetch(`${manifest.observerOrigin}/observe/${step}`, { method: "POST" });
    expect(response.status, await response.text()).toBe(200);
    steps.push(step);
  };

  const submit = async (form: Locator, name: string) => {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/assistenter(?:\.data)?$/.test(new URL(response.url()).pathname),
    );

    await form.getByRole("button", { name, exact: true }).click();
    expect((await response).status()).toBe(200);
  };

  const scope = new URLSearchParams({
    departmentId: manifest.departmentId,
    semesterId: manifest.semesterId,
  });

  const forbiddenMutation = async (
    actor: Page,
    endpoint: string,
    etag: string,
    payload: CoverageCommand | OwnCoverageCommand | PlacementCommand,
    check: string,
    expected: number,
    expectedCode?: string,
  ) => {
    const response = await actor.request.post(
      `${manifest.backendOrigin}/api/placements${endpoint}?${scope}`,
      {
        headers: {
          origin: manifest.dashboardOrigin,
          "if-match": etag,
          "idempotency-key": crypto.randomUUID(),
        },
        data: payload,
      },
    );

    const problem = await response.json();
    expect(response.status(), JSON.stringify(problem)).toBe(expected);

    if (expectedCode !== undefined) expect(problem.code).toBe(expectedCode);
    http.push({ check, status: response.status(), boundary: "authenticated-http" });
  };

  let passed = false;

  try {
    await signIn(self, manifest.persons.volunteer);
    await selectScope(self);
    await expect(self.getByRole("form", { name: "Ny skoleplassering", exact: true })).toHaveCount(
      0,
    );

    const requested = self.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/assistenter.data"),
    );

    await self
      .getByRole("form", { name: "Min tilknytning", exact: true })
      .getByRole("button", { name: "Be om tilknytning" })
      .click();
    expect((await requested).status()).toBe(200);
    await self.reload();
    await expect(self.getByText("Status: Venter på godkjenning", { exact: true })).toBeVisible();
    await checkpoint("affiliation");
    await writeFile(
      join(manifest.artifacts, "browser-active.json"),
      JSON.stringify({ stage: "affiliation", browser: browser.version() }),
    );

    await signIn(page, manifest.persons.leader);
    await selectScope(page);
    await submit(
      page.getByRole("form", { name: /^Tilknytning \d+: Irene Intervjuer$/ }),
      "Godkjenn tilknytning",
    );
    await self.reload();
    await expect(self.getByText("Status: Aktiv", { exact: true })).toBeVisible();
    await checkpoint("approval");

    await signIn(outsider, manifest.persons.wrongDepartment);
    await selectScope(outsider);
    await expect(
      outsider.getByRole("form", { name: "Ny skoleplassering", exact: true }),
    ).toHaveCount(0);
    await forbiddenMutation(
      outsider,
      "",
      (await readBoard(page)).etag,
      {
        action: "Create",
        personId: manifest.volunteerId,
        schoolId: manifest.schoolId,
        day: "Monday",
        workdays: 4,
        block: "2",
      },
      "out-of-scope placement denied",
      403,
    );
    await checkpoint("forbidden");

    const create = page.getByRole("form", { name: "Ny skoleplassering", exact: true });
    await create
      .getByRole("combobox", { name: "Frivillig", exact: true })
      .selectOption(manifest.volunteerId);
    await fillPlacement(create, "2");
    await submit(create, "Opprett plassering");
    await page.reload();
    await expect(
      page
        .getByRole("form", { name: /^Plassering \d+: Irene Intervjuer, Skole Beta, bolk 2,/ })
        .getByLabel("Antall undervisningsdager"),
    ).toHaveValue("4");
    await checkpoint("placement");

    const demand = page.getByRole("form", { name: "Nytt skolebehov", exact: true });
    await demand
      .getByRole("combobox", { name: "Skole", exact: true })
      .selectOption(String(manifest.schoolId));
    await demand.getByRole("combobox", { name: "Ukedag", exact: true }).selectOption("Monday");
    await demand.getByRole("combobox", { name: "Bolk", exact: true }).selectOption("2");
    await demand.getByLabel("Frivillige som trengs").fill("1");
    await submit(demand, "Legg til skolebehov");
    await page.reload();
    expect((await readBoard(page)).demands).toEqual([
      expect.objectContaining({
        schoolId: manifest.schoolId,
        day: "Monday",
        block: "2",
        requiredVolunteers: 1,
      }),
    ]);
    await checkpoint("demand");

    await submit(
      page.getByRole("form", { name: "Lag nytt tjenesteforslag", exact: true }),
      "Lag forslag fra aktive plasseringer",
    );
    await page.reload();
    const proposal = page.locator("[data-proposal-id]");
    await expect(proposal).toContainText("Irene Intervjuer");
    await expect(proposal).toContainText("Skole Beta");
    await checkpoint("proposal");
    await submit(
      page.getByRole("form", { name: "Bekreft tjenesteforslag", exact: true }),
      "Bekreft og send tjenesteplan",
    );
    await page.reload();
    await expect(proposal).toContainText("bekreftet");
    await checkpoint("confirmation");

    const schedule = page.locator('form:has(input[name="action"][value="ScheduleService"])');
    await schedule.getByLabel("Dato", { exact: true }).fill(manifest.serviceDate);
    await schedule.getByLabel("Fra (lokal skoletid)", { exact: true }).fill("09:00");
    await schedule.getByLabel("Til (lokal skoletid)", { exact: true }).fill("11:00");
    await submit(schedule, "Planlegg denne datoen");
    await page.reload();
    const [commitment] = (await readBoard(page)).commitments;
    expect(commitment).toMatchObject({
      serviceDate: manifest.serviceDate,
      requiredVolunteers: 1,
      decision: null,
    });
    await self.reload();
    await expect(
      self.getByRole("heading", {
        name: `Skole Beta, ${manifest.serviceDate} kl. 09:00–11:00, bolk 2`,
        exact: true,
      }),
    ).toBeVisible();
    await checkpoint("commitment");

    const stalePage = await staleCoordinator.newPage();
    await signIn(stalePage, manifest.persons.leader);
    await selectScope(stalePage);
    await stalePage
      .locator('article[data-commitment-id="' + commitment.commitmentId + '"]')
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();
    const staleDecision = stalePage.getByRole("form", { name: /^Beslutning for Skole Beta,/ });
    await staleDecision.getByLabel("Tjenesteutfall").selectOption("CancelService");
    await staleDecision
      .getByLabel("Kilde for dokumentasjonen", { exact: true })
      .fill("Stale coordinator review");
    await staleDecision
      .getByLabel("Begrunnelse", { exact: true })
      .fill("must not overwrite accepted outcome");

    await page
      .locator('article[data-commitment-id="' + commitment.commitmentId + '"]')
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();

    const decision = page.getByRole("form", {
      name: `Beslutning for Skole Beta, ${manifest.serviceDate} kl. 09:00–11:00, bolk 2`,
      exact: true,
    });

    await decision.getByLabel("Tjenesteutfall").selectOption("CompleteService");
    await decision
      .getByLabel("Kilde for dokumentasjonen", { exact: true })
      .fill(`Skole Beta kontakt, telefon ${manifest.serviceDate}`);
    await expect(
      decision.getByRole("button", { name: "Lagre uforanderlig beslutning" }),
    ).toBeDisabled();
    const staleEtag = (await readCoverageBoard(page)).etag;

    const terminalCommand = {
      action: "CompleteService",
      commitmentId: commitment.commitmentId,
      attendedPersonIds: [manifest.volunteerId],
      evidenceSource: `Skole Beta kontakt, telefon ${manifest.serviceDate}`,
    };

    await forbiddenMutation(
      page,
      "/coverage",
      staleEtag,
      { ...terminalCommand, attendedPersonIds: [] },
      "insufficient attendance cannot complete",
      422,
    );
    await checkpoint("insufficient");

    if (manifest.fault !== "omit-attendance")
      await decision.getByRole("checkbox", { name: "Irene Intervjuer", exact: true }).check();
    await expect(
      decision.getByRole("button", { name: "Lagre uforanderlig beslutning" }),
    ).toBeEnabled();
    await submit(decision, "Lagre uforanderlig beslutning");
    await page.reload();
    const completed = page.locator(`article[data-commitment-id="${commitment.commitmentId}"]`);
    await expect(completed).toContainText("Gjennomført");
    await expect(completed.getByRole("list", { name: "Faktisk møtte" })).toHaveText(
      "Irene Intervjuer",
    );
    await checkpoint("completed");

    await forbiddenMutation(
      page,
      "/coverage",
      staleEtag,
      {
        action: "CancelService",
        commitmentId: commitment.commitmentId,
        evidenceSource: terminalCommand.evidenceSource,
        reason: "must not overwrite accepted outcome",
      },
      "stale terminal decision cannot overwrite",
      412,
    );

    const rejected = stalePage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/assistenter(?:\.data)?$/.test(new URL(response.url()).pathname),
    );

    await staleDecision.getByRole("button", { name: "Lagre uforanderlig beslutning" }).click();
    expect((await rejected).status()).toBe(412);
    await expect(stalePage.getByRole("alert")).toContainText("Oversikten er endret");
    await checkpoint("stale");

    const fresh = await freshVolunteer.newPage();
    await signIn(fresh, manifest.persons.volunteer);
    await selectScope(fresh);
    await fresh.reload();

    const service = fresh
      .getByRole("heading", {
        name: `Skole Beta, ${manifest.serviceDate} kl. 09:00–11:00, bolk 2`,
        exact: true,
      })
      .locator("..");

    await expect(service).toContainText("Gjennomført");
    await expect(service).toContainText("Behov: 1 frivillige");
    await expect(fresh.getByRole("form", { name: "Ny skoleplassering", exact: true })).toHaveCount(
      0,
    );
    await expect(
      fresh.getByRole("button", { name: "Registrer beslutning for denne datoen" }),
    ).toHaveCount(0);
    await checkpoint("independent-read");
    // Continue the same real journey with a second date, covered by a linked substitute.
    const candidateContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(candidateContext);
    candidateContext.setDefaultTimeout(10_000);
    await candidateContext.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const candidatePage = await candidateContext.newPage();
    await signIn(candidatePage, manifest.persons.candidate);
    await selectScope(candidatePage);

    const candidateAffiliation = candidatePage.getByRole("form", {
      name: "Min tilknytning",
      exact: true,
    });

    await candidateAffiliation.getByRole("button", { name: "Be om tilknytning" }).click();
    await saved(candidateAffiliation);
    await checkpoint("candidate-affiliation");
    await page.reload();
    await submit(
      page.getByRole("form", { name: /^Tilknytning \d+: Kari Kandidat$/ }),
      "Godkjenn tilknytning",
    );
    await checkpoint("candidate-approval");
    await page.reload();
    await schedule.getByLabel("Dato", { exact: true }).fill(manifest.substituteServiceDate);
    await schedule.getByLabel("Fra (lokal skoletid)", { exact: true }).fill("09:00");
    await schedule.getByLabel("Til (lokal skoletid)", { exact: true }).fill("11:00");
    await submit(schedule, "Planlegg denne datoen");
    await page.reload();

    const substituteCommitment = (await readBoard(page)).commitments.find(
      (row: { serviceDate: string }) => row.serviceDate === manifest.substituteServiceDate,
    );

    expect(substituteCommitment.decision).toBeNull();
    await checkpoint("substitute-commitment");
    await self.reload();

    const absenceForm = self.locator(
      'form:has(input[name="action"][value="ReportAbsence"]):has(input[name="commitmentId"][value="' +
        substituteCommitment.commitmentId +
        '"])',
    );

    await absenceForm.getByRole("button", { name: "Rapporter fravær for denne tjenesten" }).click();
    await expect.poll(async () => (await readCoverageBoard(page)).absences.length).toBe(1);
    const absence = (await readCoverageBoard(page)).absences[0];
    expect((await readCoverageBoard(page)).candidates).toEqual([]);
    await checkpoint("substitute-absence");

    await page.goto(manifest.dashboardOrigin + "/dashboard/vikarer?" + scope);
    await page
      .getByRole("combobox", { name: "Søker", exact: true })
      .selectOption(manifest.applicationId);
    const poolCard = page.getByRole("article", { name: "Kari Kandidat", exact: true });

    for (const label of ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag"])
      await poolCard
        .getByRole("combobox", { name: label, exact: true })
        .selectOption(label === "Mandag" ? "true" : "false");
    await poolCard
      .getByRole("combobox", { name: "Undervisningsspråk", exact: true })
      .selectOption("Norwegian");
    await poolCard.getByLabel("Studieår").fill("3");
    await poolCard.getByRole("button", { name: "Legg til som vikar" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Vikaren er lagt til." }),
    ).toBeVisible();

    const expectedCandidate = {
      absenceId: absence.absenceId,
      applicationId: manifest.applicationId,
      personId: manifest.candidateId,
      firstName: "Kari",
      lastName: "Kandidat",
    };

    expect((await readCoverageBoard(page)).candidates).toEqual([expectedCandidate]);
    await checkpoint("pool-activated");

    const poolResponse = await page.request.get(
      manifest.backendOrigin + "/api/substitutes/" + manifest.applicationId,
      { headers: { origin: manifest.dashboardOrigin } },
    );

    expect(poolResponse.status()).toBe(200);
    const activePool = await poolResponse.json();
    await poolCard.getByRole("combobox", { name: "Mandag", exact: true }).selectOption("false");
    await poolCard.getByLabel("Studieår").fill("4");
    await poolCard.getByRole("button", { name: "Lagre endringer" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Opplysningene er lagret." }),
    ).toBeVisible();
    expect((await readCoverageBoard(page)).candidates).toEqual([]);
    await checkpoint("pool-edited");

    const stalePool = await page.request.post(
      manifest.backendOrigin + "/api/substitutes/" + manifest.applicationId + ":edit",
      {
        headers: {
          origin: manifest.dashboardOrigin,
          "if-match": activePool.etag,
          "idempotency-key": crypto.randomUUID(),
        },
        data: { ...activePool.preferences, yearOfStudy: 5 },
      },
    );

    expect(stalePool.status()).toBe(412);
    expect((await stalePool.json()).code).toBe("precondition.failed");
    http.push({
      check: "stale pool command rejected",
      status: 412,
      boundary: "authenticated-http",
    });
    await checkpoint("pool-stale");
    await poolCard.getByRole("button", { name: "Fjern fra vikaroversikten" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Søknaden og opplysningene er bevart." }),
    ).toBeVisible();
    expect((await readCoverageBoard(page)).candidates).toEqual([]);
    await checkpoint("pool-deactivated");
    await page.reload();
    await page
      .getByRole("combobox", { name: "Søker", exact: true })
      .selectOption(manifest.applicationId);
    await poolCard.getByRole("combobox", { name: "Mandag", exact: true }).selectOption("true");
    await poolCard.getByRole("button", { name: "Legg til som vikar" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Vikaren er lagt til." }),
    ).toBeVisible();
    expect((await readCoverageBoard(page)).candidates).toEqual([expectedCandidate]);
    await checkpoint("pool-reactivated");
    await page.screenshot({
      path: join(manifest.artifacts, "golden-substitute-pool.png"),
      fullPage: true,
    });

    await page.goto(manifest.dashboardOrigin + scopePath());
    await create
      .getByRole("combobox", { name: "Frivillig", exact: true })
      .selectOption(manifest.candidateId);
    await fillPlacement(create, "2");
    await submit(create, "Opprett plassering");
    await page.reload();
    expect((await readCoverageBoard(page)).candidates).toEqual([]);
    await forbiddenMutation(
      page,
      "/coverage",
      (await readCoverageBoard(page)).etag,
      {
        action: "DispatchSubstituteOffer",
        absenceId: absence.absenceId,
        candidatePersonId: manifest.candidateId,
      },
      "conflicting assignment rejects substitute offer",
      422,
      "offer.candidate-ineligible",
    );
    await checkpoint("assignment-conflict");
    const candidatePlacement = page.getByRole("form", { name: /^Plassering \d+: Kari Kandidat,/ });
    await submit(candidatePlacement, "Fjern plassering");
    await page.reload();
    expect((await readCoverageBoard(page)).candidates).toEqual([expectedCandidate]);
    await checkpoint("assignment-released");

    const dispatch = page.getByRole("form", {
      name: "Vikardispatch: " + absence.absenceId,
      exact: true,
    });

    await dispatch
      .getByRole("combobox", { name: "Kvalifisert vikar", exact: true })
      .selectOption(manifest.candidateId);
    await submit(dispatch, "Send vikartilbud");
    await expect
      .poll(async () => (await readCoverageBoard(page)).dispatchNotifications[0]?.status)
      .toBe("Failed");
    await checkpoint("offer-failed");
    await expect
      .poll(async () => (await readCoverageBoard(page)).dispatchNotifications[0]?.status, {
        timeout: 20000,
      })
      .toBe("Delivered");
    await checkpoint("offer-delivered");
    const offer = (await readCoverageBoard(page)).offers[0];

    const wrongCoverageResponse = await outsider.request.get(
      manifest.backendOrigin + "/api/placements/coverage/own?" + scope,
      { headers: { origin: manifest.dashboardOrigin } },
    );

    expect(wrongCoverageResponse.status()).toBe(200);
    const wrongCoverage = await wrongCoverageResponse.json();
    expect(wrongCoverage.offers).toEqual([]);
    await forbiddenMutation(
      outsider,
      "/coverage/own",
      wrongCoverage.etag,
      { action: "RespondToOffer", offerId: offer.offerId, response: "Accept" },
      "only addressed substitute can accept",
      403,
      "offer.owner-invalid",
    );
    await checkpoint("wrong-recipient");
    await candidatePage.reload();

    const offerTitle =
      "Skole Beta, " + manifest.substituteServiceDate + " kl. 09:00–11:00 — Monday, bolk 2";

    const candidateOffer = candidatePage.getByRole("form", {
      name: "Vikartilbud: " + offerTitle,
      exact: true,
    });

    await candidateOffer.getByRole("button", { name: "Aksepter tilbud", exact: true }).click();
    await submittedAndRemoved(candidateOffer);
    await candidatePage.reload();
    await expect(candidatePage.getByText("Endelig svar: Akseptert", { exact: true })).toBeVisible();
    await checkpoint("offer-accepted");
    await candidatePage.screenshot({
      path: join(manifest.artifacts, "golden-substitute-accepted-mobile.png"),
      fullPage: true,
    });
    await page.reload();
    await submit(
      page.getByRole("form", { name: "Dekningstilbud: Kari Kandidat, " + offerTitle, exact: true }),
      "Bekreft dekning",
    );
    await page.reload();
    await expect(
      page.getByText("Dekningen er bekreftet av koordinator.", { exact: true }),
    ).toBeVisible();
    await checkpoint("coverage-acknowledged");

    const substituted = page.locator(
      'article[data-commitment-id="' + substituteCommitment.commitmentId + '"]',
    );

    await substituted
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();

    const substituteDecision = page.getByRole("form", {
      name:
        "Beslutning for Skole Beta, " + manifest.substituteServiceDate + " kl. 09:00–11:00, bolk 2",
      exact: true,
    });

    await substituteDecision.getByLabel("Tjenesteutfall").selectOption("CompleteService");
    await substituteDecision
      .getByLabel("Kilde for dokumentasjonen", { exact: true })
      .fill("Skole Beta bekrefter Kari Kandidat møtte " + manifest.substituteServiceDate);
    await expect(
      substituteDecision.getByRole("button", { name: "Lagre uforanderlig beslutning" }),
    ).toBeDisabled();
    await substituteDecision
      .locator('input[name="attendedPersonId"][value="' + manifest.candidateId + '"]')
      .check();
    await submit(substituteDecision, "Lagre uforanderlig beslutning");
    await page.reload();
    await expect(substituted.getByRole("list", { name: "Faktisk møtte" })).toHaveText(
      "Kari Kandidat",
    );
    await checkpoint("substitute-completed");
    await page.screenshot({
      path: join(manifest.artifacts, "golden-substitute-completed.png"),
      fullPage: true,
    });
    await candidatePage.reload();

    const candidateService = candidatePage
      .getByRole("heading", {
        name: "Skole Beta, " + manifest.substituteServiceDate + " kl. 09:00–11:00, bolk 2",
        exact: true,
      })
      .locator("..");

    await expect(candidateService).toContainText("Gjennomført");
    await expect(candidateService).toContainText("Din rolle: bekreftet vikar.");
    await expect(
      candidatePage.getByRole("button", { name: "Registrer beslutning for denne datoen" }),
    ).toHaveCount(0);
    await checkpoint("substitute-independent-read");

    if (manifest.fault !== "absent-browser-evidence")
      await writeFile(
        join(manifest.artifacts, "browser-evidence.json"),
        JSON.stringify(
          {
            passed: true,
            revision: manifest.revision,
            journey: "golden-school-service",
            steps,
            http,
            network,
            browserVersion: browser.version(),
            nativeSessions: [
              "coordinator",
              "volunteer",
              "out-of-scope",
              "fresh-volunteer",
              "stale-coordinator",
              "addressed-substitute",
            ],
            visualAcceptance: false,
          },
          null,
          2,
        ),
      );
    passed = true;
  } finally {
    await writeFile(
      join(manifest.artifacts, "browser-network.json"),
      JSON.stringify({ steps, http, network, passed }, null, 2),
    );

    for (const [index, context] of contexts.entries()) {
      if (!passed)
        await context.tracing.stop({
          path: join(manifest.artifacts, `private-trace-${index}.zip`),
        });
      else await context.tracing.stop();
      await context.close();
    }
  }
});
