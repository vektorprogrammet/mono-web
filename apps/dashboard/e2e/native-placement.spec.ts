import AxeBuilder from "@axe-core/playwright";
import type { AdmissionOutcomeCommand } from "@vektorprogrammet/domain/admissions";
import type {
  CoverageCommand,
  OwnCoverageCommand,
  PlacementCommand,
} from "@vektorprogrammet/domain/placements";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page, type Locator } from "@playwright/test";
import { Order } from "effect";

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

const readOwnCoverage = async (page: Page) => {
  const response = await page.request.get(
    `${manifest.backendOrigin}/api/placements/coverage/own?${new URLSearchParams({
      departmentId: manifest.departmentId,
      semesterId: manifest.semesterId,
    })}`,
    { headers: { origin: manifest.dashboardOrigin } },
  );

  expect(response.status()).toBe(200);

  return response.json();
};

/** Admission management reads one application's outcome entry with its version. */
const readOutcome = async (page: Page, applicationId: string) => {
  const response = await page.request.get(
    `${manifest.backendOrigin}/api/admission-outcomes/${applicationId}`,
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
    const candidateName = `${manifest.coverage.candidateFirstName} ${manifest.coverage.candidateLastName}`;
    const slot = (serviceDate: string) => `Skole Beta, ${serviceDate}, bolk 2`;

    // The absent volunteer names the substitute who agreed to cover; people agree outside the system.
    const ownCoverage = self.getByRole("form", {
      name: `Dekning for mitt fravær: ${slot(manifest.coverage.serviceDate)}`,
      exact: true,
    });

    const ownAbsenceArticle = self.getByRole("article").filter({ has: ownCoverage });
    await expect(ownAbsenceArticle).toContainText("Ingen dekning er registrert.");
    await ownCoverage
      .getByRole("combobox", { name: "Dekkes av", exact: true })
      .selectOption({ label: `${candidateName} (vikar)` });
    await ownCoverage.getByRole("button", { name: "Registrer dekning", exact: true }).click();
    await saved(ownCoverage);
    await self.reload();
    await expect(ownAbsenceArticle).toContainText(`Dekket av: ${candidateName}`);
    await axe(self, "own coverage record on mobile");

    const recordedCoverage = (await readCoverageBoard(page)).coverage.find(
      (item: { absenceId: string }) => item.absenceId === coveredAbsence.absenceId,
    );

    expect(recordedCoverage).toMatchObject({
      coveringPersonId: manifest.coverage.candidateId,
      covererKind: "Substitute",
      recordedByPersonId: manifest.volunteerId,
    });
    await wrongPage.reload();
    await expect(
      wrongPage.getByRole("form", {
        name: `Dekning: Irene Intervjuer, ${slot(manifest.coverage.serviceDate)}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await page.reload();

    const coordinatorFirst = page.getByRole("form", {
      name: `Dekning: Irene Intervjuer, ${slot(manifest.coverage.serviceDate)}`,
      exact: true,
    });

    await expect(page.getByRole("article").filter({ has: coordinatorFirst })).toContainText(
      `Dekket av: ${candidateName} (vikar)`,
    );
    await page
      .locator(`article[data-commitment-id="${firstCommitment.commitmentId}"]`)
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();

    const completedForm = page.getByRole("form", {
      name: `Beslutning for Skole Beta, ${manifest.coverage.serviceDate} kl. 09:00–11:00, bolk 2`,
      exact: true,
    });

    await completedForm.getByLabel("Tjenesteutfall").selectOption("CompleteService");
    await completedForm
      .getByLabel("Kilde for dokumentasjonen", { exact: true })
      .fill(`Skole Beta kontakt, telefon ${manifest.coverage.serviceDate}`);

    // Attendance is derived: the scheduled coordinator plus the substitute covering the absence.
    const completedAttendance = completedForm.getByRole("list", {
      name: "Beregnet oppmøte",
      exact: true,
    });

    await expect(completedAttendance.getByRole("listitem")).toHaveCount(2);
    await expect(completedAttendance).toContainText("Lina Lagleder (planlagt frivillig)");
    await expect(completedAttendance).toContainText(`${candidateName} (dekker fravær)`);
    await expect(completedForm).toContainText("2 møter av 2 som trengs.");
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
    expect([...completed.decision.attendedPersonIds].sort(Order.String)).toEqual(
      [manifest.leaderId, manifest.coverage.candidateId].sort(Order.String),
    );

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

    const secondCoverage = page.getByRole("form", {
      name: `Dekning: Lina Lagleder, ${slot(manifest.coverage.secondServiceDate)}`,
      exact: true,
    });

    const secondAbsenceArticle = page.getByRole("article").filter({ has: secondCoverage });

    // The other scheduled volunteer is already booked in the same interval.
    await secondCoverage
      .getByRole("combobox", { name: "Dekkes av", exact: true })
      .selectOption({ label: "Irene Intervjuer (assistent)" });

    const unavailable = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/assistenter(?:\.data)?$/.test(new URL(response.url()).pathname),
    );

    await secondCoverage.getByRole("button", { name: "Registrer dekning", exact: true }).click();
    expect((await unavailable).status()).toBe(409);
    await expect(secondCoverage.getByRole("alert")).toContainText(
      "Personen er allerede opptatt i samme tidsrom.",
    );
    expect(
      (await readCoverageBoard(page)).coverage.filter(
        (item: { absenceId: string }) => item.absenceId === uncoveredAbsence.absenceId,
      ),
    ).toEqual([]);
    await secondCoverage
      .getByRole("combobox", { name: "Dekkes av", exact: true })
      .selectOption({ label: `${candidateName} (vikar)` });
    await secondCoverage.getByRole("button", { name: "Registrer dekning", exact: true }).click();
    await saved(secondCoverage);
    await page.reload();
    await expect(secondAbsenceArticle).toContainText(`Dekket av: ${candidateName} (vikar)`);

    const withdrawnCoverageId = (await readCoverageBoard(page)).coverage.find(
      (item: { absenceId: string }) => item.absenceId === uncoveredAbsence.absenceId,
    )?.coverageId;

    expect(withdrawnCoverageId).toMatch(/^school-service-coverage-[a-f0-9]{64}$/);

    const withdrawSecond = page.getByRole("form", {
      name: `Trekk tilbake dekning: Lina Lagleder, ${slot(manifest.coverage.secondServiceDate)}`,
      exact: true,
    });

    await withdrawSecond.getByRole("button", { name: "Trekk tilbake dekning", exact: true }).click();
    await submittedAndRemoved(withdrawSecond);
    await page.reload();
    await expect(secondAbsenceArticle).toContainText("Ingen dekning er registrert.");
    await page
      .locator(`article[data-commitment-id="${secondCommitment.commitmentId}"]`)
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();

    const unfulfilledForm = page.getByRole("form", {
      name: `Beslutning for Skole Beta, ${manifest.coverage.secondServiceDate} kl. 09:00–11:00, bolk 2`,
      exact: true,
    });

    await unfulfilledForm.getByLabel("Tjenesteutfall").selectOption("MarkUnfulfilledService");
    await unfulfilledForm
      .getByLabel("Kilde for dokumentasjonen", { exact: true })
      .fill(`Skole Beta kontakt, telefon ${manifest.coverage.secondServiceDate}`);
    await unfulfilledForm
      .getByLabel("Begrunnelse", { exact: true })
      .fill("Bare én av to frivillige møtte");
    await expect(
      unfulfilledForm
        .getByRole("list", { name: "Beregnet oppmøte", exact: true })
        .getByRole("listitem"),
    ).toHaveText(["Irene Intervjuer (planlagt frivillig)"]);
    await expect(unfulfilledForm).toContainText("1 møter av 2 som trengs.");
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

    await cancelledForm.getByLabel("Tjenesteutfall").selectOption("CancelService");
    await cancelledForm
      .getByLabel("Kilde for dokumentasjonen", { exact: true })
      .fill(`Skole Beta kontakt, telefon ${manifest.coverage.cancelledServiceDate}`);
    await cancelledForm.getByLabel("Begrunnelse", { exact: true }).fill("Skolen avlyste tjenesten");
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

    expect(coveredOccurrence).toBeDefined();
    expect(uncoveredOccurrence).toBeDefined();
    expect([...coveredOccurrence.attendedPersonIds].sort(Order.String)).toEqual(
      [manifest.leaderId, manifest.coverage.candidateId].sort(Order.String),
    );
    expect(uncoveredOccurrence.attendedPersonIds).toEqual([manifest.volunteerId]);
    expect(
      finalCoverage.closures.find(
        (item: { absenceId: string }) => item.absenceId === coveredAbsence.absenceId,
      ),
    ).toMatchObject({
      outcome: "Covered",
      coverageId: recordedCoverage.coverageId,
      coveringPersonId: manifest.coverage.candidateId,
    });
    expect(
      finalCoverage.closures.find(
        (item: { absenceId: string }) => item.absenceId === uncoveredAbsence.absenceId,
      ),
    ).toMatchObject({ outcome: "Uncovered", coverageId: null, coveringPersonId: null });

    // The substitute reads the service she covered, with no coordinator control.
    const candidatePage = await substitute.newPage();
    monitor(candidatePage);
    await signIn(candidatePage, manifest.persons.candidate);
    await selectScope(candidatePage);
    await candidatePage.setViewportSize({ width: 390, height: 844 });

    const coveredService = candidatePage
      .getByRole("heading", {
        name: `Skole Beta, ${manifest.coverage.serviceDate} kl. 09:00–11:00, bolk 2`,
        exact: true,
      })
      .locator("..");

    await expect(coveredService).toContainText("Gjennomført");
    await expect(coveredService).toContainText("Din rolle: dekker fravær.");
    // The API cohort left other covered dates in the same scope; this date is listed once.
    await expect(
      candidatePage
        .getByRole("region", { name: "Fravær jeg dekker", exact: true })
        .getByRole("listitem")
        .filter({ hasText: slot(manifest.coverage.serviceDate) }),
    ).toHaveCount(1);
    await expect(
      candidatePage.getByRole("button", { name: "Registrer beslutning for denne datoen" }),
    ).toHaveCount(0);
    await axe(candidatePage, "covering substitute on mobile");
    expect(
      await candidatePage.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
    ).toBe(true);
    await candidatePage.screenshot({
      path: join(manifest.artifacts, "coverage-substitute-mobile.png"),
      fullPage: true,
    });

    const browserCoverageExpected = {
      absencePosts,
      proposalId: serviceProposalId,
      completedCommitmentId: firstCommitment.commitmentId,
      unfulfilledCommitmentId: secondCommitment.commitmentId,
      cancelledCommitmentId: cancelledCommitment.commitmentId,
      coveredAbsenceId: coveredAbsence.absenceId,
      uncoveredAbsenceId: uncoveredAbsence.absenceId,
      coverageId: recordedCoverage.coverageId,
      withdrawnCoverageId,
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
      "confirmed two-person demand; scheduled dates; own absence and own coverage record; derived attendance and Completed evidence",
    );
    gates.push(
      "coordinator absence report, unavailable scheduled coverer, coverage record and withdrawal, partial Unfulfilled and cancellation without occurrence",
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

  const steps: string[] = [];
  const http: { check: string; status: number; boundary: string }[] = [];
  const network: { method: string; path: string; status: number }[] = [];
  const contexts: BrowserContext[] = [];

  // Each native session is its own context. It records dashboard and backend responses and keeps
  // a private trace that only a failed run retains.
  const session = async (viewport?: { width: number; height: number }) => {
    const context = await browser.newContext(viewport === undefined ? {} : { viewport });
    contexts.push(context);
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

    return context.newPage();
  };

  const page = await session();
  const self = await session();
  const outsider = await session();

  const checkpoint = async (step: string) => {
    const response = await fetch(`${manifest.observerOrigin}/observe/${step}`, { method: "POST" });
    expect(response.status, await response.text()).toBe(200);
    steps.push(step);
  };

  // Submits one form through its dashboard route action and checks the answered status.
  const submitOn = async (
    actor: Page,
    form: Locator,
    name: string,
    route = "assistenter",
    status = 200,
  ) => {
    const response = actor.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new RegExp(`/${route}(?:\\.data)?$`).test(new URL(response.url()).pathname),
    );

    await form.getByRole("button", { name, exact: true }).click();
    expect((await response).status()).toBe(status);
  };

  const submit = (form: Locator, name: string) => submitOn(page, form, name);

  const scope = new URLSearchParams({
    departmentId: manifest.departmentId,
    semesterId: manifest.semesterId,
  });

  // Sends one command outside the controls and records the refusal; the observer then proves that
  // it changed no persisted fact.
  const rejected = async (
    actor: Page,
    path: string,
    etag: string,
    payload: CoverageCommand | OwnCoverageCommand | PlacementCommand | AdmissionOutcomeCommand,
    check: string,
    expected: number,
    expectedCode?: string,
  ) => {
    const response = await actor.request.post(`${manifest.backendOrigin}${path}`, {
      headers: {
        origin: manifest.dashboardOrigin,
        "if-match": etag,
        "idempotency-key": crypto.randomUUID(),
      },
      data: payload,
    });

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
    await rejected(
      outsider,
      `/api/placements?${scope}`,
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

    const stalePage = await session();
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

    const evidenceSource = `Skole Beta kontakt, telefon ${manifest.serviceDate}`;
    const saveDecision = decision.getByRole("button", { name: "Lagre uforanderlig beslutning" });
    await decision.getByLabel("Tjenesteutfall").selectOption("MarkUnfulfilledService");
    await decision.getByLabel("Kilde for dokumentasjonen", { exact: true }).fill(evidenceSource);
    await decision.getByLabel("Begrunnelse", { exact: true }).fill("Ingen møtte");
    // Attendance is derived from the roster: the one scheduled volunteer meets the demand of one,
    // so the service cannot be marked unfulfilled.
    await expect(
      decision.getByRole("list", { name: "Beregnet oppmøte", exact: true }).getByRole("listitem"),
    ).toHaveText(["Irene Intervjuer (planlagt frivillig)"]);
    await expect(decision).toContainText("1 møter av 1 som trengs.");
    await expect(saveDecision).toBeDisabled();
    const staleEtag = (await readCoverageBoard(page)).etag;
    await rejected(
      page,
      `/api/placements/coverage?${scope}`,
      staleEtag,
      {
        action: "MarkUnfulfilledService",
        commitmentId: commitment.commitmentId,
        reason: "Ingen møtte",
        evidenceSource,
      },
      "derived attendance meets demand, so the service is not unfulfilled",
      422,
      "commitment.outcome-invalid",
    );
    await checkpoint("insufficient");

    // A new outcome clears the source and reason fields, so the coordinator enters the source again.
    await decision.getByLabel("Tjenesteutfall").selectOption("CompleteService");
    await decision.getByLabel("Kilde for dokumentasjonen", { exact: true }).fill(evidenceSource);
    await expect(saveDecision).toBeEnabled();
    await submit(decision, "Lagre uforanderlig beslutning");
    await page.reload();
    const completed = page.locator(`article[data-commitment-id="${commitment.commitmentId}"]`);
    await expect(completed).toContainText("Gjennomført");
    await expect(completed.getByRole("list", { name: "Faktisk møtte" })).toHaveText(
      "Irene Intervjuer",
    );
    await checkpoint("completed");

    await rejected(
      page,
      `/api/placements/coverage?${scope}`,
      staleEtag,
      {
        action: "CancelService",
        commitmentId: commitment.commitmentId,
        evidenceSource,
        reason: "must not overwrite accepted outcome",
      },
      "stale terminal decision cannot overwrite",
      412,
    );
    await submitOn(stalePage, staleDecision, "Lagre uforanderlig beslutning", "assistenter", 412);
    await expect(stalePage.getByRole("alert")).toContainText("Oversikten er endret");
    await checkpoint("stale");

    const fresh = await session();
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
    // A second date: the volunteer is absent and names who covers. People agree on cover outside
    // the system; the system records the absence, the admission outcome and who covered.
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
      `form:has(input[name="action"][value="ReportAbsence"]):has(input[name="commitmentId"][value="${substituteCommitment.commitmentId}"])`,
    );

    await absenceForm.getByRole("button", { name: "Rapporter fravær for denne tjenesten" }).click();
    await expect.poll(async () => (await readCoverageBoard(page)).absences.length).toBe(1);
    const [absence] = (await readCoverageBoard(page)).absences;
    await checkpoint("substitute-absence");

    // Before any admission outcome nobody is on call, so the volunteer cannot name the applicant.
    const slot = `Skole Beta, ${manifest.substituteServiceDate}, bolk 2`;
    await self.reload();

    const ownAbsence = self
      .getByRole("region", { name: "Registrerte fravær", exact: true })
      .getByRole("article")
      .filter({ hasText: `Skole Beta, ${manifest.substituteServiceDate} —` });

    await expect(ownAbsence).toContainText("Ingen dekning er registrert.");
    await expect(ownAbsence).toContainText(
      "Ingen assistenter eller vikarer kan registreres som dekning i valgt semester.",
    );
    const unrecordedView = await readOwnCoverage(self);
    expect(unrecordedView.coverers).toEqual([]);
    await rejected(
      self,
      `/api/placements/coverage/own?${scope}`,
      unrecordedView.etag,
      {
        action: "RecordCoverage",
        absenceId: absence.absenceId,
        coveringPersonId: manifest.candidateId,
      },
      "an applicant without the Substitute outcome cannot cover",
      422,
      "coverage.coverer-ineligible",
    );
    await checkpoint("coverer-ineligible");

    const openOutcomes = async (actor: Page) => {
      await actor.goto(`${manifest.dashboardOrigin}/dashboard/vikarer`);
      await actor
        .getByRole("combobox", { name: "Avdeling", exact: true })
        .selectOption(manifest.departmentId);
      await actor
        .getByRole("combobox", { name: "Semester", exact: true })
        .selectOption(manifest.semesterId);
      await actor.getByRole("button", { name: "Vis vikarer", exact: true }).click();
      await expect(actor).toHaveURL(/\/dashboard\/vikarer\?(?=.*departmentId=)(?=.*semesterId=)/);
      await expect(
        actor.getByRole("heading", { name: "Vikarer på vakt", exact: true }),
      ).toBeVisible();
    };

    const onCall = [
      "Kari Kandidat, kari.kandidat@example.invalid, 90000111",
      "Vera Vikar, vera.vikar@example.invalid, 90000222",
    ];

    // A second leader session opens the outcomes before they change; its later save must be refused.
    await openOutcomes(stalePage);

    const staleOutcome = stalePage.getByRole("form", {
      name: "Opptaksutfall: Kari Kandidat",
      exact: true,
    });

    await expect(staleOutcome.getByRole("combobox", { name: "Utfall", exact: true })).toHaveValue(
      "",
    );
    const unrecordedOutcome = await readOutcome(page, manifest.applicationId);
    await openOutcomes(page);
    await expect(
      page.getByText("Ingen vikarer på vakt i valgt semester.", { exact: true }),
    ).toBeVisible();

    for (const name of ["Kari Kandidat", "Vera Vikar"]) {
      const outcome = page.getByRole("form", { name: `Opptaksutfall: ${name}`, exact: true });
      await outcome.getByRole("combobox", { name: "Utfall", exact: true }).selectOption("Substitute");
      await submitOn(page, outcome, "Lagre utfall", "vikarer");
      await expect(outcome.getByRole("status")).toHaveText("Utfallet er lagret.");
    }

    await page.reload();
    await expect(
      page.getByRole("list", { name: "Vikarer på vakt", exact: true }).getByRole("listitem"),
    ).toHaveText(onCall);
    await checkpoint("outcome-recorded");

    await rejected(
      page,
      `/api/admission-outcomes/${manifest.applicationId}:record`,
      unrecordedOutcome.etag,
      { outcome: "Rejected" },
      "a stale admission outcome version cannot overwrite",
      412,
      "precondition.failed",
    );
    await staleOutcome
      .getByRole("combobox", { name: "Utfall", exact: true })
      .selectOption("Rejected");
    await submitOn(stalePage, staleOutcome, "Lagre utfall", "vikarer", 412);
    await expect(staleOutcome.getByRole("alert")).toContainText("Oversikten er endret");
    await checkpoint("outcome-stale");

    // A department member reads who is on call and how to reach them, and decides nothing.
    const member = await session();
    await signIn(member, manifest.persons.member);
    await openOutcomes(member);
    await expect(
      member.getByRole("list", { name: "Vikarer på vakt", exact: true }).getByRole("listitem"),
    ).toHaveText(onCall);
    await expect(
      member.getByText("Avtal dekning direkte med vikaren, for eksempel i Slack."),
    ).toBeVisible();
    await expect(member.getByRole("heading", { name: "Opptaksutfall", exact: true })).toHaveCount(
      0,
    );
    await expect(member.getByRole("form", { name: /^Opptaksutfall:/ })).toHaveCount(0);
    await rejected(
      member,
      `/api/admission-outcomes/${manifest.applicationId}:record`,
      (await readOutcome(page, manifest.applicationId)).etag,
      { outcome: "Rejected" },
      "a department member records no admission outcome",
      403,
      "authority.denied",
    );
    await checkpoint("on-call-read");

    const candidate = await session();
    await signIn(candidate, manifest.persons.candidate);
    const candidateView = await readOwnCoverage(candidate);
    expect(candidateView.coverers).toEqual([]);
    await rejected(
      candidate,
      `/api/placements/coverage/own?${scope}`,
      candidateView.etag,
      {
        action: "RecordCoverage",
        absenceId: absence.absenceId,
        coveringPersonId: manifest.candidateId,
      },
      "a substitute cannot record cover on another person's absence",
      403,
      "coverage.owner-invalid",
    );
    await checkpoint("wrong-owner");

    // The absent volunteer names the substitute who agreed to cover.
    const ownCoverage = self.getByRole("form", {
      name: `Dekning for mitt fravær: ${slot}`,
      exact: true,
    });

    await self.reload();
    await ownCoverage
      .getByRole("combobox", { name: "Dekkes av", exact: true })
      .selectOption({ label: "Kari Kandidat (vikar)" });
    await submitOn(self, ownCoverage, "Registrer dekning");
    await self.reload();
    await expect(ownAbsence).toContainText("Dekket av: Kari Kandidat");
    await checkpoint("coverage-recorded");

    // The coordinator replaces the record when another substitute takes the lesson.
    await page.goto(`${manifest.dashboardOrigin}${scopePath()}`);

    const coordinatorAbsence = page
      .getByRole("region", { name: "Registrert fravær og dekning", exact: true })
      .getByRole("article")
      .filter({ hasText: "Fraværende: Irene Intervjuer" });

    const coordinatorCoverage = page.getByRole("form", {
      name: `Dekning: Irene Intervjuer, ${slot}`,
      exact: true,
    });

    await expect(coordinatorAbsence).toContainText("Dekket av: Kari Kandidat (vikar)");
    await coordinatorCoverage
      .getByRole("combobox", { name: "Dekkes av", exact: true })
      .selectOption({ label: "Vera Vikar (vikar)" });
    await submit(coordinatorCoverage, "Registrer dekning");
    await page.reload();
    await expect(coordinatorAbsence).toContainText("Dekket av: Vera Vikar (vikar)");
    await checkpoint("coverage-replaced");

    const withdrawCoverage = page.getByRole("form", {
      name: `Trekk tilbake dekning: Irene Intervjuer, ${slot}`,
      exact: true,
    });

    await submit(withdrawCoverage, "Trekk tilbake dekning");
    await page.reload();
    await expect(coordinatorAbsence).toContainText("Ingen dekning er registrert.");
    await expect(withdrawCoverage).toHaveCount(0);
    await rejected(
      page,
      `/api/placements/coverage?${scope}`,
      (await readCoverageBoard(page)).etag,
      { action: "WithdrawCoverage", absenceId: absence.absenceId },
      "no current coverage record to withdraw",
      409,
      "coverage.not-recorded",
    );
    await checkpoint("coverage-withdrawn");

    // The omit-coverage fault skips this record. Attendance then misses the demand, so the
    // completion below must fail.
    if (manifest.fault !== "omit-coverage") {
      await self.reload();
      await ownCoverage
        .getByRole("combobox", { name: "Dekkes av", exact: true })
        .selectOption({ label: "Kari Kandidat (vikar)" });
      await submitOn(self, ownCoverage, "Registrer dekning");
      await self.reload();
      await expect(ownAbsence).toContainText("Dekket av: Kari Kandidat");
      await checkpoint("coverage-rerecorded");
    }

    await page.reload();

    const substituted = page.locator(
      `article[data-commitment-id="${substituteCommitment.commitmentId}"]`,
    );

    await substituted
      .getByRole("button", { name: "Registrer beslutning for denne datoen" })
      .click();

    const substituteDecision = page.getByRole("form", {
      name: `Beslutning for Skole Beta, ${manifest.substituteServiceDate} kl. 09:00–11:00, bolk 2`,
      exact: true,
    });

    await substituteDecision.getByLabel("Tjenesteutfall").selectOption("CompleteService");
    await substituteDecision
      .getByLabel("Kilde for dokumentasjonen", { exact: true })
      .fill(`Skole Beta bekrefter Kari Kandidat møtte ${manifest.substituteServiceDate}`);
    await expect(
      substituteDecision.getByRole("button", { name: "Lagre uforanderlig beslutning" }),
    ).toBeEnabled();
    await expect(
      substituteDecision
        .getByRole("list", { name: "Beregnet oppmøte", exact: true })
        .getByRole("listitem"),
    ).toHaveText(["Kari Kandidat (dekker fravær)"]);
    await expect(substituteDecision).toContainText("1 møter av 1 som trengs.");
    await submit(substituteDecision, "Lagre uforanderlig beslutning");
    await page.reload();
    await expect(substituted).toContainText("Gjennomført");
    await expect(substituted.getByRole("list", { name: "Faktisk møtte" })).toHaveText(
      "Kari Kandidat",
    );
    await expect(coordinatorAbsence).toContainText("Dekket av: Kari Kandidat (vikar)");
    await checkpoint("substitute-completed");

    const freshCandidate = await session({ width: 390, height: 844 });
    await signIn(freshCandidate, manifest.persons.candidate);
    await selectScope(freshCandidate);

    const candidateService = freshCandidate
      .getByRole("heading", {
        name: `Skole Beta, ${manifest.substituteServiceDate} kl. 09:00–11:00, bolk 2`,
        exact: true,
      })
      .locator("..");

    await expect(candidateService).toContainText("Gjennomført");
    await expect(candidateService).toContainText("Din rolle: dekker fravær.");
    await expect(
      freshCandidate
        .getByRole("region", { name: "Fravær jeg dekker", exact: true })
        .getByRole("listitem"),
    ).toHaveText([slot]);
    await expect(
      freshCandidate.getByRole("button", { name: "Registrer beslutning for denne datoen" }),
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
              "stale-coordinator",
              "fresh-volunteer",
              "department-member",
              "substitute",
              "fresh-substitute",
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
