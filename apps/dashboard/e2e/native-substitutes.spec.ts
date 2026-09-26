import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const manifestPath = process.env.SUBSTITUTE_JOURNEY_MANIFEST;

const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, "utf8")) : null;

const guidance =
  "Avtal dekning direkte med vikaren, for eksempel i Slack. Registrer hvem som dekket fraværet under Assistenter.";

const noneOnCall = "Ingen vikarer på vakt i valgt semester.";

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
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
    state,
  ).toEqual([]);
};

const outcomeForm = (page: Page, name: string) =>
  page.getByRole("form", { name: `Opptaksutfall: ${name}`, exact: true });

const onCallItems = (page: Page) =>
  page.getByRole("list", { name: "Vikarer på vakt", exact: true }).getByRole("listitem");

const readOutcome = async (page: Page) => {
  const response = await page.request.get(
    `${manifest.backendOrigin}/api/admission-outcomes/${manifest.applicationId}`,
    { headers: { Origin: manifest.dashboardOrigin } },
  );

  expect(response.status()).toBe(200);

  return response.json();
};

test("admission management records substitutes; members see who is on call", async ({
  browser,
}) => {
  test.skip(!manifest, "Requires the isolated native substitutes driver");
  test.setTimeout(150_000);
  const leader = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const stale = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const member = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherDepartment = await browser.newContext();
  const anonymous = await browser.newContext();
  const contexts = [leader, stale, member, otherDepartment, anonymous];

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
        if (
          response.request().method() !== "POST" ||
          !new URL(response.url()).pathname.endsWith("/vikarer.data")
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

  try {
    const anon = await anonymous.newPage();
    await anon.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(anon).toHaveURL(/\/login/);
    gates.push("an anonymous browser is redirected to sign-in");

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
    await expect(page.getByRole("button", { name: "Vis vikarer", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    const sofie = outcomeForm(page, "Sofie Søker");
    const sofieOutcome = sofie.getByRole("combobox", { name: "Utfall", exact: true });
    await expect(sofieOutcome).toHaveValue("");
    await expect(sofieOutcome.locator("option:checked")).toHaveText("Velg utfall");
    await expect(outcomeForm(page, "Anne API")).toBeVisible();
    await expect(page.getByText(noneOnCall, { exact: true })).toBeVisible();
    await expect(page.getByText(guidance, { exact: true })).toBeVisible();
    await axe(page, "register without outcomes");
    gates.push(
      "keyboard scope selection shows one register form per application and an empty on-call list",
    );

    // An independently authenticated tab keeps the version it loaded before the next save.
    const stalePage = await stale.newPage();
    await signIn(stalePage, manifest.persons.leader);
    await stalePage.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    const staleSofie = outcomeForm(stalePage, "Sofie Søker");
    await expect(staleSofie.getByRole("combobox", { name: "Utfall", exact: true })).toHaveValue("");

    let posts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/vikarer.data"))
        posts += 1;
    });
    await sofieOutcome.selectOption("Substitute");
    await sofie
      .getByRole("button", { name: "Lagre utfall", exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    const saved = sofie.getByRole("status").filter({ hasText: "Utfallet er lagret." });
    await expect(saved).toBeVisible();
    expect(posts).toBe(1);
    await expect(saved).toBeInViewport({ ratio: 1 });
    await expect(onCallItems(page)).toHaveText([manifest.onCall]);
    expect(await readOutcome(page)).toMatchObject({ outcome: "Substitute", revision: 1 });
    gates.push("the register records Vikar once despite a double click, and the person is on call");

    await stalePage.setViewportSize({ width: 390, height: 844 });
    const staleOutcome = staleSofie.getByRole("combobox", { name: "Utfall", exact: true });
    const staleSave = staleSofie.getByRole("button", { name: "Lagre utfall", exact: true });
    await staleOutcome.selectOption("Admitted");
    await staleSave.click();
    const conflict = staleSofie.getByRole("alert");
    await expect(conflict).toContainText("Oversikten er endret av noen andre.");
    await expect(staleOutcome).toHaveValue("Admitted");
    await expect(conflict).toBeInViewport({ ratio: 1 });
    await axe(stalePage, "phone viewport with a stale draft");
    const rejectedKey = await staleSofie.locator('input[name="commandId"]').inputValue();
    expect(rejectedKey).not.toBe("");

    const retryResponse = stalePage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/vikarer.data"),
    );

    await staleSave.click();
    expect((await retryResponse).status()).toBe(412);
    await expect(conflict).toContainText("Oversikten er endret av noen andre.");
    expect(await staleSofie.locator('input[name="commandId"]').inputValue()).toBe(rejectedKey);
    expect(await readOutcome(stalePage)).toMatchObject({ outcome: "Substitute", revision: 1 });
    await staleSofie.getByRole("button", { name: "Hent siste versjon", exact: true }).click();
    await expect(staleSofie.getByText("Siste lagrede utfall: Vikar.", { exact: true })).toBeVisible();
    await staleSofie
      .getByRole("button", { name: "Bruk siste versjon med mitt valg", exact: true })
      .click();
    await expect(
      staleSofie.getByText("Siste versjon er valgt. Kontroller valget og lagre på nytt.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(staleOutcome).toHaveValue("Admitted");
    await staleSave.click();
    await expect(
      staleSofie.getByRole("status").filter({ hasText: "Utfallet er lagret." }),
    ).toBeVisible();
    expect(await readOutcome(stalePage)).toMatchObject({ outcome: "Admitted", revision: 2 });
    await expect(stalePage.getByText(noneOnCall, { exact: true })).toBeVisible();
    gates.push(
      "a stale tab on a phone viewport gets the conflict alert (412), keeps its choice and key on an unchanged retry, and saves after taking the latest version",
    );

    // Consecutive keyboard saves on one mounted form each use the latest version and a new command.
    await page.reload();
    await expect(sofieOutcome).toHaveValue("Admitted");
    await expect(page.getByText(noneOnCall, { exact: true })).toBeVisible();

    for (const [outcome, revision] of [
      ["Rejected", 3],
      ["Substitute", 4],
    ] as const) {
      await sofieOutcome.focus();
      await sofieOutcome.selectOption(outcome);
      await page.keyboard.press("Tab");
      await expect(sofie.getByRole("button", { name: "Lagre utfall", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await readOutcome(page)).revision).toBe(revision);
      await expect(
        sofie.getByRole("status").filter({ hasText: "Utfallet er lagret." }),
      ).toBeInViewport({ ratio: 1 });
      expect((await readOutcome(page)).outcome).toBe(outcome);
    }

    await expect(onCallItems(page)).toHaveText([manifest.onCall]);
    await axe(page, "register with a substitute on call");
    await page.screenshot({
      path: join(manifest.artifacts, "substitutes-leader.png"),
      fullPage: true,
    });
    gates.push("consecutive keyboard saves on one form each apply, and Vikar puts the person back on call");

    const readOnly = await member.newPage();
    await signIn(readOnly, manifest.persons.member);
    await readOnly.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(onCallItems(readOnly)).toHaveText([manifest.onCall]);
    await expect(readOnly.getByText(guidance, { exact: true })).toBeVisible();
    await expect(readOnly.getByRole("heading", { name: "Opptaksutfall" })).toHaveCount(0);
    await expect(readOnly.getByRole("combobox", { name: "Utfall" })).toHaveCount(0);
    await expect(readOnly.getByRole("button", { name: "Lagre utfall" })).toHaveCount(0);
    await expect(readOnly.getByText("Anne API")).toHaveCount(0);
    const current = await readOutcome(page);

    const memberRead = await readOnly.request.get(
      `${manifest.backendOrigin}/api/admission-outcomes/${manifest.applicationId}`,
      { headers: { Origin: manifest.dashboardOrigin } },
    );

    expect(memberRead.status()).toBe(403);

    const memberRecord = await readOnly.request.post(
      `${manifest.backendOrigin}/api/admission-outcomes/${manifest.applicationId}:record`,
      {
        headers: {
          Origin: manifest.dashboardOrigin,
          "Idempotency-Key": "browser-member-denied-substitutes",
          "If-Match": current.etag,
        },
        data: { outcome: "Rejected" },
      },
    );

    expect(memberRecord.status()).toBe(403);
    await axe(readOnly, "member on-call list");
    await readOnly.setViewportSize({ width: 390, height: 844 });
    await expect(onCallItems(readOnly)).toHaveText([manifest.onCall]);
    await axe(readOnly, "phone viewport member on-call list");
    await readOnly.screenshot({
      path: join(manifest.artifacts, "substitutes-member-mobile.png"),
      fullPage: true,
    });
    gates.push(
      "a member sees who is on call with e-mail and phone, has no register, and the backend denies member reads and records",
    );

    const forbidden = await otherDepartment.newPage();
    await signIn(forbidden, manifest.persons.otherDepartment);
    await forbidden.goto(`${manifest.dashboardOrigin}${scopePath(manifest.semesterId)}`);
    await expect(forbidden.getByRole("alert")).toContainText(
      "Velg en avdeling du har tilgang til og et gyldig semester.",
    );
    await expect(forbidden.getByRole("list", { name: "Vikarer på vakt" })).toHaveCount(0);
    await expect(forbidden.getByRole("form", { name: /^Opptaksutfall/u })).toHaveCount(0);
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
          specId: "substitutes",
          revision: manifest.revision,
          passed: true,
          runtime:
            "production React Router dashboard + real native Bun backend + PostgreSQL; Chromium",
          gates,
          finalHistory: [
            { revision: 1, outcome: "Substitute", decidedBy: manifest.leaderPersonId },
            { revision: 2, outcome: "Admitted", decidedBy: manifest.leaderPersonId },
            { revision: 3, outcome: "Rejected", decidedBy: manifest.leaderPersonId },
            { revision: 4, outcome: "Substitute", decidedBy: manifest.leaderPersonId },
          ],
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
