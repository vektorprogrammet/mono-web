import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

const manifestPath = process.env.ADMISSION_OUTCOME_JOURNEY_MANIFEST;

const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, "utf8")) : null;

const applicant = (key: string): { applicationId: string; name: string } =>
  manifest.applicants[key];

const scopePath = (semesterId: string) =>
  `/dashboard/opptaksutfall?${new URLSearchParams({ departmentId: manifest.departmentId, semesterId })}`;

const templatePath = (kind: string) =>
  `/dashboard/opptaksutfall/maler?${new URLSearchParams({ departmentId: manifest.departmentId, kind })}`;

const signIn = async (page: Page, person: { email: string; password: string }) => {
  await page.goto(
    `${manifest.dashboardOrigin}/dashboard/login?redirectTo=${encodeURIComponent("/opptaksutfall")}`,
  );
  await page.getByLabel("E-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Opptaksutfall", exact: true }).first()).toBeVisible();
};

const axe = async (page: Page, state: string) => {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
    state,
  ).toEqual([]);
};

const decideForm = (page: Page, key: string) =>
  page.getByRole("form", { name: `Opptaksutfall: ${applicant(key).name}`, exact: true });

const announceForm = (page: Page, key: string) =>
  page.getByRole("form", { name: `Kunngjør utfall: ${applicant(key).name}`, exact: true });

const saved = (form: Locator) => form.getByRole("status").filter({ hasText: "Utfallet er lagret." });

const announcedText = (form: Locator) => form.getByText("Kunngjort:", { exact: false });

const announced = (form: Locator) =>
  form.getByRole("status").filter({ hasText: "Utfallet er kunngjort." });

const isOutcomeAction = (url: string) => new URL(url).pathname.endsWith("/opptaksutfall.data");

const readOutcome = async (page: Page, key: string) => {
  const response = await page.request.get(
    `${manifest.backendOrigin}/api/admission-outcomes/${applicant(key).applicationId}`,
    { headers: { Origin: manifest.dashboardOrigin } },
  );

  expect(response.status()).toBe(200);

  return response.json();
};

const decideByKeyboard = async (page: Page, key: string, outcome: string) => {
  const form = decideForm(page, key);
  const select = form.getByRole("combobox", { name: "Utfall", exact: true });
  await select.focus();
  await select.selectOption(outcome);
  await page.keyboard.press("Tab");
  await expect(form.getByRole("button", { name: "Lagre utfall", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
};

// The rich fields only ever receive appended content, so the caret position is always the end.
const append = async (page: Page, field: Locator, ...parts: ReadonlyArray<string>) => {
  for (const part of parts) {
    await field.focus();
    await page.keyboard.press("ControlOrMeta+End");

    if (part === "\n") await page.keyboard.press("Enter");
    else await page.keyboard.type(part);
  }
};

const placeholderButton = (page: Page, label: string) =>
  page.getByRole("button", { name: `Sett inn ${label}`, exact: true });

/** The closed document of one variant: placeholders as atoms, one bold word, no author HTML. */
const authorTemplate = async (page: Page, kind: string, label: string) => {
  const subject = page.getByRole("textbox", { name: "Emne", exact: true });
  const body = page.getByRole("textbox", { name: "Meldingstekst", exact: true });

  await subject.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await append(page, subject, "Opptaksresultat - ");
  await page.getByRole("button", { name: "Avdeling i emnet", exact: true }).click();
  await append(page, subject, ", ");
  await page.getByRole("button", { name: "Semester i emnet", exact: true }).click();
  await append(page, subject, `: Egendefinert ${label}`);

  await body.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await append(page, body, "Hei ");
  await placeholderButton(page, "Fornavn").click();
  await append(page, body, ",", "\n", "Egendefinert tekst for ");
  await placeholderButton(page, "Avdeling").click();
  await append(page, body, " ");
  await placeholderButton(page, "Semester").click();
  await append(page, body, ".");

  if (kind === "AdmittedWithSchool") {
    await append(page, body, "\n", "Skole: ");
    await placeholderButton(page, "Skole").click();
    await append(page, body, ".");
  }

  await append(page, body, "\n", "Hilsen oss");
  await body.focus();

  for (let step = 0; step < "oss".length; step += 1) await page.keyboard.press("Shift+ArrowLeft");

  await page.getByRole("button", { name: "Fet", exact: true }).click();
};

test("admission outcomes: Rekruttering decides, the coordinator announces, templates are edited", async ({
  browser,
}) => {
  test.skip(!manifest, "Requires the isolated native admission outcomes driver");
  test.setTimeout(420_000);
  const desktop = { viewport: { width: 1280, height: 900 } };
  const leader = await browser.newContext(desktop);
  const stale = await browser.newContext(desktop);
  const coordinator = await browser.newContext(desktop);
  const staleCoordinator = await browser.newContext(desktop);
  const member = await browser.newContext(desktop);
  const otherDepartment = await browser.newContext();
  const anonymous = await browser.newContext();

  const contexts = [
    leader,
    stale,
    coordinator,
    staleCoordinator,
    member,
    otherDepartment,
    anonymous,
  ];

  const actionObservations: Array<{
    url: string;
    status: number;
    request: string | null;
    response: string;
  }> = [];

  const actionReads: Array<Promise<void>> = [];
  const pageErrors: string[] = [];

  for (const context of contexts) {
    context.setDefaultTimeout(10_000);
    context.on("page", (observedPage) => {
      observedPage.on("pageerror", (error) => pageErrors.push(error.message));
      observedPage.on("response", (response) => {
        const { pathname } = new URL(response.url());

        if (
          response.request().method() !== "POST" ||
          !(pathname.endsWith("/opptaksutfall.data") || pathname.endsWith("/maler.data"))
        )
          return;
        actionReads.push(
          response.text().then((body) => {
            actionObservations.push({
              url: response.url(),
              status: response.status(),
              request: response.request().postData(),
              response: body,
            });
          }),
        );
      });
    });
  }

  const page = await leader.newPage();
  const gates: string[] = [];
  const announcements: Array<{ key: string; kind: string; template: "default" | "custom" }> = [];
  const templateSaves: string[] = [];

  try {
    const anon = await anonymous.newPage();
    await anon.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(anon).toHaveURL(/\/login/);
    await anon.goto(`${manifest.dashboardOrigin}${templatePath("Rejected")}`);
    await expect(anon).toHaveURL(/\/login/);
    gates.push("an anonymous browser is redirected to sign-in, also from the template editor");

    await signIn(page, manifest.persons.leader);
    await axe(page, "scope selection");
    const department = page.getByRole("combobox", { name: "Avdeling", exact: true });
    const semester = page.getByRole("combobox", { name: "Semester", exact: true });
    await department.focus();
    await department.selectOption(manifest.departmentId);
    await page.keyboard.press("Tab");
    await expect(semester).toBeFocused();
    await semester.selectOption(manifest.semesterId);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Vis opptaksutfall", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);

    for (const key of ["maybe", "returning", "undecided"]) {
      const select = decideForm(page, key).getByRole("combobox", { name: "Utfall", exact: true });
      await expect(select).toHaveValue("");
      await expect(select.locator("option:checked")).toHaveText("Velg utfall");
      await expect(select.locator("option")).toHaveText(["Velg utfall", "Tatt opp", "Ikke tatt opp"]);
    }

    await expect(page.getByText("Vikar", { exact: false })).toHaveCount(0);
    await expect(page.getByText("på vakt", { exact: false })).toHaveCount(0);
    // The page and its decision region are two landmarks, so they carry two names (axe landmark-unique).
    await expect(page.getByRole("region", { name: "Opptaksutfall", exact: true })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Avgjørelser", exact: true })).toHaveCount(1);
    await axe(page, "decide board without outcomes");
    gates.push(
      "keyboard scope selection shows one decide form per application with exactly two outcomes and no on-call list",
    );

    // Independently authenticated tabs keep the version they loaded before the next save.
    const stalePage = await stale.newPage();
    await signIn(stalePage, manifest.persons.leader);
    await stalePage.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    const staleMaybe = decideForm(stalePage, "maybe");
    await expect(staleMaybe.getByRole("combobox", { name: "Utfall", exact: true })).toHaveValue("");

    const coordinatorPage = await coordinator.newPage();
    await signIn(coordinatorPage, manifest.persons.coordinator);
    await coordinatorPage.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    const staleCoordinatorPage = await staleCoordinator.newPage();
    await signIn(staleCoordinatorPage, manifest.persons.coordinator);
    await staleCoordinatorPage.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(announceForm(staleCoordinatorPage, "maybe")).toBeVisible();

    let posts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && isOutcomeAction(request.url())) posts += 1;
    });

    const maybe = decideForm(page, "maybe");
    const maybeOutcome = maybe.getByRole("combobox", { name: "Utfall", exact: true });
    await maybeOutcome.selectOption("Admitted");
    await maybe
      .getByRole("button", { name: "Lagre utfall", exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(saved(maybe)).toBeVisible();
    expect(posts).toBe(1);
    await expect(saved(maybe)).toBeInViewport({ ratio: 1 });
    expect(await readOutcome(page, "maybe")).toMatchObject({ outcome: "Admitted", revision: 1 });
    gates.push("Rekruttering decides Kanskje once despite a double click");

    await stalePage.setViewportSize({ width: 390, height: 844 });
    const staleOutcome = staleMaybe.getByRole("combobox", { name: "Utfall", exact: true });
    const staleSave = staleMaybe.getByRole("button", { name: "Lagre utfall", exact: true });
    await staleOutcome.selectOption("Rejected");
    await staleSave.click();
    const conflict = staleMaybe.getByRole("alert");
    await expect(conflict).toContainText("Oversikten er endret av noen andre.");
    await expect(staleOutcome).toHaveValue("Rejected");
    await expect(conflict).toBeInViewport({ ratio: 1 });
    await axe(stalePage, "phone viewport with a stale draft");
    const rejectedKey = await staleMaybe.locator('input[name="commandId"]').inputValue();
    expect(rejectedKey).not.toBe("");

    const retryResponse = stalePage.waitForResponse(
      (response) => response.request().method() === "POST" && isOutcomeAction(response.url()),
    );

    await staleSave.click();
    expect((await retryResponse).status()).toBe(412);
    await expect(conflict).toContainText("Oversikten er endret av noen andre.");
    expect(await staleMaybe.locator('input[name="commandId"]').inputValue()).toBe(rejectedKey);
    expect(await readOutcome(stalePage, "maybe")).toMatchObject({
      outcome: "Admitted",
      revision: 1,
    });
    await staleMaybe.getByRole("button", { name: "Hent siste versjon", exact: true }).click();
    await expect(staleMaybe.getByText("Siste lagrede utfall: Tatt opp.", { exact: true })).toBeVisible();
    await staleMaybe
      .getByRole("button", { name: "Bruk siste versjon med mitt valg", exact: true })
      .click();
    await expect(
      staleMaybe.getByText("Siste versjon er valgt. Kontroller valget og lagre på nytt.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(staleOutcome).toHaveValue("Rejected");
    await staleSave.click();
    await expect(saved(staleMaybe)).toBeVisible();
    expect(await readOutcome(stalePage, "maybe")).toMatchObject({
      outcome: "Rejected",
      revision: 2,
    });
    gates.push(
      "a stale tab on a phone viewport gets the conflict alert (412), keeps its choice and key on an unchanged retry, and saves after taking the latest version",
    );

    // Consecutive keyboard saves on one mounted form each use the latest version and a new command.
    await page.reload();
    await expect(maybeOutcome).toHaveValue("Rejected");

    for (const [outcome, revision] of [
      ["Admitted", 3],
      ["Rejected", 4],
      ["Admitted", 5],
    ] as const) {
      await decideByKeyboard(page, "maybe", outcome);
      await expect.poll(async () => (await readOutcome(page, "maybe")).revision).toBe(revision);
      await expect(saved(maybe)).toBeInViewport({ ratio: 1 });
      expect((await readOutcome(page, "maybe")).outcome).toBe(outcome);
    }

    await decideByKeyboard(page, "returning", "Rejected");
    await expect(saved(decideForm(page, "returning"))).toBeVisible();
    expect(await readOutcome(page, "returning")).toMatchObject({
      outcome: "Rejected",
      revision: 1,
    });
    await axe(page, "decide board after decisions");
    await page.screenshot({
      path: join(manifest.artifacts, "admission-outcomes-leader.png"),
      fullPage: true,
    });
    gates.push(
      "consecutive keyboard saves on one form each apply as a new revision, and a returning assistant is decided once",
    );

    // Deciding is not announcing: the undecided Kanskje applicant has no outcome at all.
    const undecidedRead = await page.request.get(
      `${manifest.backendOrigin}/api/admission-outcomes/${applicant("undecided").applicationId}`,
      { headers: { Origin: manifest.dashboardOrigin } },
    );

    expect(undecidedRead.status()).toBe(200);
    expect((await undecidedRead.json()).outcome).toBeNull();

    // The members' on-call list is gone: a member holds neither decide nor announce authority.
    const readOnly = await member.newPage();
    await signIn(readOnly, manifest.persons.member);
    await readOnly.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);

    for (const hidden of [
      readOnly.getByRole("form", { name: /^Opptaksutfall: / }),
      readOnly.getByRole("form", { name: /^Kunngjør utfall: / }),
      readOnly.getByRole("combobox", { name: "Utfall" }),
      readOnly.getByRole("button", { name: "Lagre utfall" }),
      readOnly.getByRole("button", { name: "Kunngjør utfall" }),
      readOnly.getByText(applicant("maybe").name),
      readOnly.getByText("@example.invalid", { exact: false }),
      readOnly.getByRole("list", { name: "Vikarer på vakt" }),
    ])
      await expect(hidden).toHaveCount(0);

    const current = await readOutcome(page, "maybe");

    const memberRead = await readOnly.request.get(
      `${manifest.backendOrigin}/api/admission-outcomes/${applicant("maybe").applicationId}`,
      { headers: { Origin: manifest.dashboardOrigin } },
    );

    expect(memberRead.status()).toBe(403);

    for (const [suffix, data] of [
      [":decide", { outcome: "Rejected" }],
      [":announce", {}],
    ] as const) {
      const memberCommand = await readOnly.request.post(
        `${manifest.backendOrigin}/api/admission-outcomes/${applicant("maybe").applicationId}${suffix}`,
        {
          headers: {
            Origin: manifest.dashboardOrigin,
            "Idempotency-Key": `browser-member-denied-outcomes${suffix.slice(1)}`,
            "If-Match": current.etag,
          },
          data,
        },
      );

      expect(memberCommand.status(), suffix).toBe(403);
    }

    await axe(readOnly, "member without outcome authority");
    await readOnly.setViewportSize({ width: 390, height: 844 });
    await axe(readOnly, "phone viewport member without outcome authority");
    await readOnly.screenshot({
      path: join(manifest.artifacts, "admission-outcomes-member-mobile.png"),
      fullPage: true,
    });
    gates.push(
      "a member sees no applicant, e-mail, phone, decide or announce control and no on-call list, and the backend denies member reads, decisions and announcements",
    );

    // The coordinator's announce projection names each application but never its e-mail or phone.
    await coordinatorPage.reload();
    const announceBoard = coordinatorPage.getByRole("region", { name: "Kunngjøring", exact: true });
    await expect(announceBoard).toBeVisible();
    await expect(coordinatorPage.getByRole("button", { name: "Lagre utfall" })).toHaveCount(0);
    await expect(coordinatorPage.getByText("@example.invalid", { exact: false })).toHaveCount(0);
    await expect(announceForm(coordinatorPage, "maybe")).toBeVisible();
    await axe(coordinatorPage, "coordinator announce board");
    gates.push("the coordinator announces from a board that shows no e-mail or phone");

    // A coordinator tab loaded before the decisions holds an old version: its announcement is refused.
    const staleAnnounce = announceForm(staleCoordinatorPage, "maybe");
    await staleAnnounce.getByRole("button", { name: "Kunngjør utfall", exact: true }).click();
    await expect(staleAnnounce.getByRole("alert")).toContainText(
      "Oversikten er endret av noen andre.",
    );
    await expect(announcedText(announceForm(staleCoordinatorPage, "maybe"))).toHaveCount(0);
    gates.push("a stale coordinator tab is refused with the conflict alert (412) and announces nothing");

    const announceOnce = async (
      key: string,
      kind: string,
      template: "default" | "custom",
      mode: "double-click" | "keyboard" | "click",
    ) => {
      const form = announceForm(coordinatorPage, key);
      const button = form.getByRole("button", { name: "Kunngjør utfall", exact: true });
      let announceRequests = 0;

      const countRequest = (request: Request) => {
        if (request.method() === "POST" && isOutcomeAction(request.url())) announceRequests += 1;
      };

      coordinatorPage.on("request", countRequest);

      if (mode === "double-click")
        await button.evaluate((element: HTMLButtonElement) => {
          element.click();
          element.click();
        });
      else if (mode === "keyboard") {
        await button.focus();
        await coordinatorPage.keyboard.press("Enter");
      } else await button.click();

      await expect(announcedText(form)).toBeVisible();
      await expect(announced(form)).toBeVisible();
      await expect(button).toHaveCount(0);

      coordinatorPage.off("request", countRequest);

      if (mode === "double-click") expect(announceRequests).toBe(1);

      announcements.push({ key, kind, template });
    };

    // Default copy: all three variants.
    await announceOnce("neiFree", "Rejected", "default", "keyboard");
    await announceOnce("jaPlaced", "AdmittedWithSchool", "default", "click");
    await announceOnce("jaFree", "AdmittedPlacementPending", "default", "double-click");

    expect(await readOutcome(page, "neiFree")).toMatchObject({ outcome: "Rejected" });
    expect(await readOutcome(page, "jaPlaced")).toMatchObject({ outcome: "Admitted" });
    expect(await readOutcome(page, "jaFree")).toMatchObject({ outcome: "Admitted" });
    gates.push(
      "Ja and Nei are announced without a decision: Admitted with and without placement, and Rejected, each once, also after a double click",
    );

    for (const key of ["neiPlaced", "undecided"]) {
      const refused = announceForm(coordinatorPage, key);
      await refused.getByRole("button", { name: "Kunngjør utfall", exact: true }).click();
      await expect(refused.getByRole("alert")).toBeVisible();
      await expect(announcedText(refused)).toHaveCount(0);
    }

    expect(await readOutcome(page, "neiPlaced")).toMatchObject({ outcome: null });
    expect((await readOutcome(page, "undecided")).outcome).toBeNull();
    await axe(coordinatorPage, "coordinator announce board with refusals");
    gates.push(
      "a Rejected outcome with an active placement and an undecided Kanskje are refused with an alert and stay unannounced",
    );

    // Templates: the delegated coordinator edits the department's three variants.
    const editor = await coordinator.newPage();
    await editor.goto(`${manifest.dashboardOrigin}/dashboard/opptaksutfall/maler`);
    await expect(
      editor.getByRole("heading", { name: "E-postmaler for opptaksutfall", exact: true }),
    ).toBeVisible();
    await expect(editor.getByRole("textbox", { name: "Meldingstekst", exact: true })).toHaveCount(0);
    await editor.getByRole("combobox", { name: "Avdeling", exact: true }).selectOption(manifest.departmentId);
    await editor
      .getByRole("combobox", { name: "Variant", exact: true })
      .selectOption({ label: "Tatt opp, med skoleplassering" });
    await editor.getByRole("button", { name: "Vis mal", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "Meldingstekst", exact: true })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Lagre mal", exact: true })).toBeDisabled();
    await axe(editor, "template editor");

    const variants = [
      ["AdmittedWithSchool", "med skole"],
      ["AdmittedPlacementPending", "venter"],
      ["Rejected", "avslag"],
    ] as const;

    for (const [index, [kind, label]] of variants.entries()) {
      if (index > 0) {
        if (kind === "Rejected") await editor.setViewportSize({ width: 390, height: 844 });
        await editor.goto(`${manifest.dashboardOrigin}${templatePath(kind)}`);
        await expect(editor.getByRole("textbox", { name: "Meldingstekst", exact: true })).toBeVisible();
        await expect(editor.getByRole("button", { name: "Lagre mal", exact: true })).toBeDisabled();
      }

      await authorTemplate(editor, kind, label);
      await expect(editor.getByRole("button", { name: "Lagre mal", exact: true })).toBeDisabled();
      await editor.getByRole("button", { name: "Forhåndsvis", exact: true }).click();
      const preview = editor.getByRole("region", { name: "Forhåndsvisning", exact: true });
      await expect(preview).toContainText(`Egendefinert ${label}`);
      await expect(preview).toContainText("Egendefinert tekst for");
      await expect(
        editor
          .frameLocator('iframe[title="Forhåndsvisning av e-post"]')
          .getByText("Egendefinert tekst for", { exact: false }),
      ).toBeVisible();

      if (index === 0) {
        // Editing after the preview invalidates it until the draft is previewed again.
        await append(editor, editor.getByRole("textbox", { name: "Meldingstekst", exact: true }), "!");
        await expect(editor.getByRole("button", { name: "Lagre mal", exact: true })).toBeDisabled();
        await editor.getByRole("button", { name: "Forhåndsvis", exact: true }).click();
      }

      await expect(editor.getByRole("button", { name: "Lagre mal", exact: true })).toBeEnabled();
      await axe(editor, `template editor ${kind} with a preview`);
      await editor.getByRole("button", { name: "Lagre mal", exact: true }).click();
      await expect(editor.getByText("Malen er lagret.", { exact: true })).toBeVisible();
      templateSaves.push(kind);

      await editor.reload();
      await expect(editor.getByText("Avdelingsmal", { exact: false })).toBeVisible();
      await expect(editor.getByRole("textbox", { name: "Meldingstekst", exact: true })).toContainText(
        "Egendefinert tekst for",
      );
    }

    await editor.screenshot({
      path: join(manifest.artifacts, "admission-outcomes-template-mobile.png"),
      fullPage: true,
    });
    gates.push(
      "the delegated coordinator authors, previews (save is disabled until the draft is previewed) and saves all three variants as department templates, with axe and a phone viewport",
    );

    for (const [context, person] of [
      [member, "member"],
      [otherDepartment, "otherDepartment"],
    ] as const) {
      const denied = await context.newPage();
      await signIn(denied, manifest.persons[person]);
      await denied.goto(`${manifest.dashboardOrigin}${templatePath("Rejected")}`);
      await expect(denied.getByRole("textbox", { name: "Meldingstekst", exact: true })).toHaveCount(0);
      await expect(denied.getByRole("button", { name: "Lagre mal", exact: true })).toHaveCount(0);
      await expect(denied.getByRole("alert")).toBeVisible();
    }

    gates.push("a member and another department's coordinator cannot open the template editor");

    // Custom copy: the saved department templates now render each variant.
    await coordinatorPage.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await announceOnce("jaPlacedLate", "AdmittedWithSchool", "custom", "click");
    await announceOnce("maybe", "AdmittedPlacementPending", "custom", "click");
    await announceOnce("returning", "Rejected", "custom", "click");
    await announceOnce("markup", "Rejected", "custom", "click");

    expect(await readOutcome(page, "maybe")).toMatchObject({ outcome: "Admitted", revision: 5 });
    expect(await readOutcome(page, "returning")).toMatchObject({
      outcome: "Rejected",
      revision: 1,
    });
    await axe(coordinatorPage, "coordinator announce board after announcements");
    await coordinatorPage.screenshot({
      path: join(manifest.artifacts, "admission-outcomes-coordinator.png"),
      fullPage: true,
    });
    gates.push(
      "Kanskje and returning are announced after their decision, and every variant now uses the saved department template",
    );

    // Terminal: a finished outcome offers no decision and a markup first name stays text on the page.
    await page.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(
      decideForm(page, "maybe").getByRole("button", { name: "Lagre utfall", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(applicant("markup").name, { exact: false }).first()).toBeVisible();
    gates.push("an announced outcome is final on the decide board and markup names render as text");

    const forbidden = await otherDepartment.newPage();
    await signIn(forbidden, manifest.persons.otherDepartment);
    await forbidden.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(forbidden.getByRole("alert")).toContainText(
      "Velg en avdeling du har tilgang til og et gyldig semester.",
    );
    await expect(forbidden.getByRole("form", { name: /^Opptaksutfall/u })).toHaveCount(0);
    await expect(forbidden.getByRole("form", { name: /^Kunngjør utfall/u })).toHaveCount(0);
    await page.goto(`${manifest.dashboardOrigin}${scopePath(manifest.noPeriodSemesterId)}`);
    await expect(
      page.getByText("Det finnes ingen opptaksperiode for valgt avdeling og semester.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("form", { name: /^Opptaksutfall/u })).toHaveCount(0);
    gates.push(
      "another department's scope is refused and a semester without an admission period is empty",
    );
    expect(pageErrors).toEqual([]);
    await Promise.all(actionReads);
    await writeFile(
      join(manifest.artifacts, "browser-evidence.json"),
      JSON.stringify(
        {
          specId: "admission-outcomes",
          revision: manifest.revision,
          passed: true,
          runtime:
            "production React Router dashboard + real native Bun backend + PostgreSQL; Chromium",
          gates,
          announcements,
          templateSaves,
          finalHistory: {
            maybe: [
              { revision: 1, outcome: "Admitted", decidedBy: manifest.leaderPersonId },
              { revision: 2, outcome: "Rejected", decidedBy: manifest.leaderPersonId },
              { revision: 3, outcome: "Admitted", decidedBy: manifest.leaderPersonId },
              { revision: 4, outcome: "Rejected", decidedBy: manifest.leaderPersonId },
              { revision: 5, outcome: "Admitted", decidedBy: manifest.leaderPersonId },
            ],
            returning: [{ revision: 1, outcome: "Rejected", decidedBy: manifest.leaderPersonId }],
          },
          pageErrors,
          actionObservations,
        },
        null,
        2,
      ),
    );
  } catch (cause) {
    await Promise.allSettled(actionReads);
    const captures: Array<{ url: string; artifact: string; error?: string }> = [];

    for (const [contextIndex, context] of contexts.entries()) {
      for (const [pageIndex, failedPage] of context.pages().entries()) {
        if (failedPage.isClosed()) continue;
        const artifact = `failure-${contextIndex}-${pageIndex}`;

        try {
          await writeFile(
            join(manifest.artifacts, `${artifact}.yml`),
            await failedPage.locator("body").ariaSnapshot({ timeout: 5000 }),
            { mode: 0o600 },
          );
          await failedPage.screenshot({
            path: join(manifest.artifacts, `${artifact}.png`),
            fullPage: true,
            timeout: 5000,
          });
          captures.push({ url: failedPage.url(), artifact });
        } catch (captureError) {
          captures.push({ url: failedPage.url(), artifact, error: String(captureError) });
        }
      }
    }

    await writeFile(
      join(manifest.artifacts, "browser-failure.json"),
      JSON.stringify(
        {
          revision: manifest.revision,
          passed: false,
          failure: String(cause),
          gates,
          announcements,
          templateSaves,
          pageErrors,
          actionObservations,
          captures,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw cause;
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
