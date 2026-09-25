import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type Locator, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Predicate } from "effect";

const manifestPath = process.env.PLACEMENT_JOURNEY_MANIFEST;

const m = manifestPath ? JSON.parse(await readFile(manifestPath, "utf8")) : null;

const card = (page: Page, name: string) =>
  page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });

const signIn = async (
  page: Page,
  person: { email: string; password: string },
  destination: string,
) => {
  await page.goto(m.dashboardOrigin + "/login?redirectTo=" + encodeURIComponent(destination));
  await page.getByLabel("E-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(m.dashboardOrigin + destination);
};

const saved = async (form: Locator) => {
  await expect(form).toHaveAttribute("data-pending", "false");
  await expect(form.getByRole("status")).toContainText("Endringen er lagret");
};

test("continuous recruitment to first placement", async ({ browser }) => {
  test.skip(!m?.recruitment, "Requires the isolated recruitment driver");
  test.setTimeout(180_000);

  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext({ viewport: { width: 1280, height: 900 } })),
  );

  const [staff, applicant, other, wrong] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );

  const pageErrors: string[] = [];
  const network: Array<{ method: string; path: string; status: number }> = [];
  const steps: string[] = [];

  const capture = (context: BrowserContext) => {
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(20_000);

    const capturePage = (page: Page) =>
      page.on("pageerror", (error) => pageErrors.push(error.name));

    context.pages().forEach(capturePage);
    context.on("page", capturePage);

    context.on("response", (response) => {
      const url = new URL(response.url());
      // Never retain link capabilities, query strings, bodies, or headers.
      network.push({
        method: response.request().method(),
        path: url.pathname.replace(/\/interview-response\/[^/]+/, "/interview-response/[REDACTED]"),
        status: response.status(),
      });
    });
  };

  contexts.forEach(capture);

  for (const context of contexts)
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });

  const checkpoint = async (step: string) => {
    const response = await staff.request.post(m.observerOrigin + "/observe/" + step);
    expect(response.status(), await response.text()).toBe(200);
    steps.push(step);

    return response.json();
  };

  const mailbox = async () => (await staff.request.get(m.observerOrigin + "/mail")).json();

  const claimUrl = async (email: string) => {
    const message = (await mailbox()).find((item: { to?: string }) => item.to === email);
    expect(Boolean(message)).toBe(true);

    const url = message.text.split(" ").at(-1);
    expect(Predicate.isString(url)).toBe(true);

    return String(url);
  };

  const placements =
    "/dashboard/assistenter?" +
    new URLSearchParams({ departmentId: m.departmentId, semesterId: m.semesterId });

  const onboarding = "/dashboard/onboarding?departmentId=" + m.departmentId;

  const submit = async (
    page: Page,
    person: { firstName: string; lastName: string; email: string },
  ) => {
    const publicOrigin = m.homepageOrigin.replace("127.0.0.1", "p000.vektor.phibkro.org");
    await page.route(publicOrigin + "/**", async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace(publicOrigin, m.homepageOrigin),
        headers: { ...route.request().headers(), host: new URL(publicOrigin).host },
      });

      await route.fulfill({ response });
    });
    await page.goto(publicOrigin + "/assistenter", { waitUntil: "domcontentloaded" });
    await page.waitForFunction("window.__MONO_WEB_HYDRATED__ === true");
    await page.getByLabel("Avdeling").selectOption(m.departmentId);
    await page.getByLabel("Studieretning").selectOption(m.fieldId);
    await page.getByLabel("Studieår").selectOption("3");
    await page.getByLabel("Fornavn").fill(person.firstName);
    await page.getByLabel("Etternavn").fill(person.lastName);
    await page.getByLabel("E-post").fill(person.email);
    await page.getByLabel("Telefonnummer").fill("90000925");
    await page.getByLabel("Kjønn").selectOption("0");
    await page.getByRole("button", { name: "Send søknad", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Søknaden er mottatt" })).toBeVisible();
  };

  const createAccount = async (page: Page, url: string, password: string) => {
    await page.goto(url);
    await page.getByLabel("Nytt passord", { exact: true }).fill(password);
    await page.getByLabel("Gjenta passord").fill(password);
    await page.getByRole("button", { name: "Opprett konto", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Kontoen er knyttet");
  };

  try {
    await submit(applicant, m.persons.applicant);
    await applicant.screenshot({
      path: join(m.artifacts, "recruitment-application.png"),
      fullPage: true,
    });
    await submit(other, m.persons.other);
    const submitted = await checkpoint("applications");

    const mainApplication = submitted.applications.find(
      (a: { email: string }) => a.email === m.persons.applicant.email,
    );

    await signIn(staff, m.persons.leader, "/dashboard/sokere");
    const row = staff.getByRole("row").filter({ hasText: "Ada Rekrutt" });
    await row.getByRole("button", { name: "Tildel intervju til Ada Rekrutt" }).click();
    const assign = staff.getByRole("dialog");
    await assign.getByLabel("Intervjuer").selectOption(m.persons.leader.personId);
    await assign.getByLabel("Intervjuskjema").selectOption(m.schemaId);
    await assign.getByRole("button", { name: "Tildel intervju", exact: true }).click();
    await expect(assign).toHaveCount(0);
    const assigned = await checkpoint("assigned");
    const interviewId = assigned.interviews[0].interview_id;

    await staff.goto(m.dashboardOrigin + "/dashboard/intervjuer");
    const interview = staff.getByRole("article").filter({ hasText: "Ada Rekrutt" });
    await interview.getByRole("button", { name: "Planlegg intervju" }).click();
    const schedule = staff.getByRole("dialog");
    await schedule.getByLabel("Tidspunkt").fill(new Date(Date.now() + 86400000).toISOString());
    await schedule.getByLabel("Rom").fill("Rekrutt 925");
    await schedule.getByLabel("Campus").fill("Gløshaugen");
    await schedule.getByLabel("Kartlenke").fill("https://maps.example.invalid/recruitment");
    await schedule.getByLabel("Melding").fill("Velkommen til intervju.");
    await schedule.getByRole("button", { name: "Lagre og legg i kø" }).click();
    await expect(schedule).toHaveCount(0);
    await checkpoint("scheduled");
    await expect
      .poll(async () =>
        (await mailbox()).some((item: { _tag?: string }) =>
          Predicate.isTagged(item, "SendInterviewInvitation"),
        ),
      )
      .toBe(true);

    const invitation = (await mailbox()).find((item: { _tag?: string }) =>
      Predicate.isTagged(item, "SendInterviewInvitation"),
    );

    await applicant.goto(
      m.dashboardOrigin + "/interview-response/" + invitation.responseCapability,
    );
    await applicant.getByRole("button", { name: "Bekreft intervjutid", exact: true }).click();
    await expect(applicant.getByText("Akseptert", { exact: true })).toBeVisible();
    await checkpoint("responded");

    await staff.reload();
    await interview.getByRole("button", { name: "Åpne intervju" }).click();
    await staff
      .locator("#question-recruitment-motivation")
      .fill("Jeg vil hjelpe elever med matematikk.");
    await staff.locator("#score-explanatoryPower").selectOption("7");
    await staff.locator("#score-roleModel").selectOption("8");
    await staff.locator("#score-suitability").selectOption("9");
    await staff.locator("#interviewer-recommendation").selectOption("Ja");
    await staff.getByRole("button", { name: "Fullfør intervju", exact: true }).click();
    await staff
      .getByRole("dialog")
      .getByRole("button", { name: "Fullfør intervju", exact: true })
      .click();
    await expect(staff.locator(".fs-conduct .fs-status")).toHaveText("Fullført");
    await checkpoint("recommended");
    await staff.screenshot({
      path: join(m.artifacts, "recruitment-recommendation.png"),
      fullPage: true,
    });
    await staff.reload();
    await interview.getByRole("button", { name: "Åpne intervju" }).click();
    await expect(staff.locator(".fs-conduct .fs-status")).toHaveText("Fullført");
    await expect(staff.locator("#interviewer-recommendation")).toHaveValue("Ja");
    await checkpoint("reloaded");

    await staff.goto(m.dashboardOrigin + onboarding);
    const mainCard = card(staff, "Ada Rekrutt");
    await mainCard.getByRole("button", { name: "Inviter", exact: true }).click();
    await saved(mainCard.locator("form"));
    await expect(mainCard).toContainText("Levering: Pending");
    await checkpoint("invitation-failed");
    await mainCard.getByRole("button", { name: "Prøv levering igjen", exact: true }).click();
    await saved(mainCard.locator("form"));
    await expect(mainCard).toContainText("Levering: Delivered");
    await checkpoint("invitation-delivered");
    const mainClaim = await claimUrl(m.persons.applicant.email);
    const otherCard = card(staff, "Olav Annen");
    await otherCard.getByRole("button", { name: "Inviter", exact: true }).click();
    await saved(otherCard.locator("form"));
    await createAccount(other, await claimUrl(m.persons.other.email), m.persons.other.password);
    await signIn(other, m.persons.other, placements);
    await checkpoint("other-claimed");

    // A different applicant cannot claim this invitation, read staff assessment, or issue an invitation.
    await other.goto(mainClaim);
    await other.getByRole("button", { name: "Knytt min konto", exact: true }).click();
    await expect(other.getByRole("status")).toContainText("Invitasjonen kunne ikke brukes");

    const privateRead = await other.request.get(
      m.backendOrigin + "/api/recruitment/interviews/" + interviewId,
    );

    expect([403, 404]).toContain(privateRead.status());
    expect(await privateRead.text()).not.toMatch(/Jeg vil hjelpe|explanatoryPower|ada@example/);

    const leaderBoard = await staff.request.get(
      m.backendOrigin + "/api/onboarding?departmentId=" + m.departmentId,
    );

    expect(leaderBoard.status()).toBe(200);

    const denied = await other.request.post(
      m.backendOrigin + "/api/onboarding?departmentId=" + m.departmentId,
      {
        headers: {
          origin: m.dashboardOrigin,
          "if-match": leaderBoard.headers().etag,
          "idempotency-key": "other-applicant-denied",
        },
        data: { applicationId: mainApplication.application_id, action: "Issue" },
      },
    );

    expect([403, 404]).toContain(denied.status());
    await checkpoint("other-applicant-denied");

    await applicant.goto(mainClaim);
    await expect(
      applicant.getByRole("heading", { name: "Knytt søknaden til din konto" }),
    ).toBeVisible();

    const beforeLogin = await applicant.request.post(m.backendOrigin + "/api/auth/sign-in/email", {
      headers: { origin: m.dashboardOrigin },
      data: { email: m.persons.applicant.email, password: m.persons.applicant.password },
    });

    expect(beforeLogin.status()).toBe(401);
    await checkpoint("claim-opened");
    await createAccount(applicant, mainClaim, m.persons.applicant.password);
    await checkpoint("claimed");
    await signIn(applicant, m.persons.applicant, placements);
    await applicant.goto(mainClaim);
    await applicant.getByRole("button", { name: "Knytt min konto", exact: true }).click();
    await expect(applicant.getByRole("status")).toContainText("Invitasjonen kunne ikke brukes");
    await checkpoint("claim-replayed");

    await applicant.goto(m.dashboardOrigin + placements);
    const own = applicant.getByRole("form", { name: "Min tilknytning" });
    await own.getByRole("button", { name: "Be om tilknytning" }).click();
    await saved(own);
    await checkpoint("affiliation-requested");
    await staff.goto(m.dashboardOrigin + placements);
    const approvalForm = card(staff, "Ada Rekrutt").locator("form");

    const fields = await approvalForm
      .locator('input[type="hidden"]')
      .evaluateAll((inputs) =>
        Object.fromEntries(
          inputs.map((input) => [
            input.getAttribute("name") ?? "",
            input.getAttribute("value") ?? "",
          ]),
        ),
      );

    await signIn(wrong, m.persons.wrongDepartment, "/dashboard");

    const wrongResult = await wrong.request.post(
      m.backendOrigin +
        "/api/placements?" +
        new URLSearchParams({ departmentId: m.departmentId, semesterId: m.semesterId }),
      {
        headers: {
          origin: m.dashboardOrigin,
          "if-match": fields.etag,
          "idempotency-key": fields.commandId,
        },
        data: { action: "Affiliation", personId: fields.personId, transition: "Establish" },
      },
    );

    expect(wrongResult.status()).toBe(403);
    expect((await wrongResult.json()).code).toBe("authority.denied");
    await checkpoint("wrong-scope-denied");
    await card(staff, "Ada Rekrutt").getByRole("button", { name: "Godkjenn tilknytning" }).click();
    await saved(card(staff, "Ada Rekrutt").locator("form"));
    await checkpoint("affiliation-approved");
    const create = staff.getByRole("form", { name: "Ny skoleplassering" });
    await create
      .getByRole("combobox", { name: "Frivillig", exact: true })
      .selectOption({ label: "Ada Rekrutt" });
    await create
      .getByRole("combobox", { name: "Skole", exact: true })
      .selectOption(String(m.schoolId));
    await create.getByRole("combobox", { name: "Ukedag", exact: true }).selectOption("Monday");
    await create.getByLabel("Antall undervisningsdager").fill("4");
    await create.getByRole("combobox", { name: "Bolk", exact: true }).selectOption("1");
    await create.getByRole("button", { name: "Opprett plassering", exact: true }).click();
    await saved(create);
    await checkpoint("placed");

    await contexts[1].tracing.stop();
    await contexts[1].close();
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(fresh);
    capture(fresh);
    await fresh.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const volunteer = await fresh.newPage();
    await signIn(volunteer, m.persons.applicant, placements);
    await expect(volunteer.locator("[data-placement-id]")).toHaveCount(1);
    await expect(volunteer.locator("[data-placement-id]")).toContainText("Rekrutt skole");
    await volunteer.reload();
    await expect(volunteer.locator("[data-placement-id]")).toHaveCount(1);
    await expect(volunteer.getByRole("form", { name: "Ny skoleplassering" })).toHaveCount(0);
    await other.goto(m.dashboardOrigin + placements);
    await expect(other.locator("[data-placement-id]")).toHaveCount(0);
    expect(await other.locator("body").innerText()).not.toContain("Ada Rekrutt");
    expect((await new AxeBuilder({ page: volunteer }).analyze()).violations).toEqual([]);
    await volunteer.screenshot({
      path: join(m.artifacts, "recruitment-first-placement.png"),
      fullPage: true,
    });
    await checkpoint("fresh-volunteer");
    expect(pageErrors).toEqual([]);
    await writeFile(
      join(m.artifacts, "browser-evidence.json"),
      JSON.stringify(
        {
          revision: m.revision,
          passed: true,
          steps,
          pageErrors,
          applicationId: mainApplication.application_id,
          interviewId,
          freshVolunteerSession: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await writeFile(join(m.artifacts, "browser-network.json"), JSON.stringify(network));

    for (const [index, context] of contexts.entries()) {
      if (context.pages().length === 0) continue;
      await context.tracing.stop({ path: join(m.artifacts, "private-trace-" + index + ".zip") });
      await context.close();
    }
  }
});
