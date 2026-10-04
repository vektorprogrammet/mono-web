import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Schema } from "effect";
import { IdempotencyKey, OnboardingResource, OnboardingProblem, OnboardingCommandProblem, SchedulingBoard, PlacementScopes } from "@vektorprogrammet/http-api";

const manifestPath = process.env.ONBOARDING_JOURNEY_MANIFEST;

const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, "utf8")) : null;

const signIn = async (
  page: Page,
  person: { email: string; password: string },
  destination: string,
) => {
  await page.goto(
    manifest.dashboardOrigin + "/login?redirectTo=" + encodeURIComponent(destination),
  );
  await page.getByLabel("E-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(manifest.dashboardOrigin + destination);
};

const axe = async (page: Page) => {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
};


test.describe("R6 real onboarding route authority and problem status", () => {
  test.beforeEach(() => {
    test.skip(!manifest?.routeAuthority, "requires just e2e onboarding's private native fixture");
  });

  for (const actor of ["boardLeader", "global", "current", "ended", "wrongDepartment", "member"] as const) {
    const allowed = ["boardLeader", "global", "current"].includes(actor);
    test(`${actor}: selectable onboarding departments reflect issuance authority, not placement reach`, async ({ page }) => {
      const person = actor === "boardLeader" ? manifest.persons.leader : manifest.routeAuthority.persons[actor];
      await signIn(page, person, "/dashboard/onboarding");
      const native = await page.request.get(manifest.backendOrigin + "/api/onboarding?departmentId=" + manifest.departmentId);
      expect(native.status()).toBe(allowed ? 200 : 403);

      if (allowed) {
        const board = Schema.decodeUnknownSync(OnboardingResource)(await native.json());
        expect(board.departmentId).toBe(manifest.departmentId);
        expect(board.items.some((item) => item.applicationId === manifest.applicationId)).toBe(true);
      } else {
        const failure = Schema.decodeUnknownSync(OnboardingProblem)(await native.json());
        expect(failure.code).toBe("authority.denied");
      }

      const department = page.getByRole("combobox", { name: "Avdeling", exact: true });
      await expect(department.locator(`option[value="${manifest.departmentId}"]`)).toHaveCount(allowed ? 1 : 0);

      if (allowed) {
        await department.selectOption(manifest.departmentId);
        await page.getByRole("button", { name: "Vis søkere", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Onboarding Applicant", exact: true })).toBeVisible();
      }

      if (actor === "current") {
        // The native board succeeds while placement reach is absent: this is the actual R6 seam.
        const placements = await page.request.get(manifest.backendOrigin + "/api/placements/scopes");
        expect(placements.status()).toBe(200);
        const scopes = Schema.decodeUnknownSync(PlacementScopes)(await placements.json());
        expect(scopes.departments.find((entry) => entry.departmentId === manifest.departmentId)?.canManage ?? false).toBe(false);
      }
    });
  }

  test("department member without interviewer appointment retains scheduling visibility without other-department widening", async ({ page }) => {
    await signIn(page, manifest.routeAuthority.persons.member, "/dashboard/onboarding");
    const response = await page.request.get(manifest.backendOrigin + "/api/recruitment/interviews");
    expect(response.status()).toBe(200);
    const board = Schema.decodeUnknownSync(SchedulingBoard)(await response.json());
    expect(board.departmentId).toBe(manifest.departmentId);
    const widened = await page.request.get(manifest.backendOrigin + "/api/recruitment/interviews?departmentId=" + manifest.routeAuthority.otherDepartmentId);
    expect(widened.status()).toBe(400);
    // Neither board visibility nor ordinary membership grants onboarding issuance.
    await expect(page.getByRole("combobox", { name: "Avdeling" }).locator(`option[value="${manifest.departmentId}"]`)).toHaveCount(0);
  });

  const readBoard = async (page: Page) => {
    const response = await page.request.get(manifest.backendOrigin + "/api/onboarding?departmentId=" + manifest.departmentId);
    expect(response.status()).toBe(200);

    return Schema.decodeUnknownSync(OnboardingResource)(await response.json());
  };

  const nativeCommand = (page: Page, etag: string, key: IdempotencyKey, action: "Issue" | "Revoke") =>
    page.request.post(manifest.backendOrigin + "/api/onboarding?departmentId=" + manifest.departmentId, {
      headers: { origin: manifest.dashboardOrigin, "if-match": etag, "idempotency-key": key },
      data: { applicationId: manifest.applicationId, action },
    });

  const routeCommand = (page: Page, etag: string, key: IdempotencyKey, action: "Issue" | "Revoke") =>
    page.request.post(manifest.dashboardOrigin + "/dashboard/onboarding", {
      form: { departmentId: manifest.departmentId, applicationId: manifest.applicationId,
        etag, commandId: key, action },
    });

  test("actual SDKProblem 503 receipt outage remains 503 through the onboarding route", async ({ page }) => {
    await signIn(page, manifest.persons.leader, "/dashboard/onboarding");
    const board = await readBoard(page);
    const headers = { authorization: "Bearer " + manifest.mailboxToken };
    const enabled = await page.request.post(manifest.mailboxOrigin + "/r6/command-fault", { headers });
    expect(enabled.status()).toBe(204);

    try {
      const native = await nativeCommand(page, board.etag, IdempotencyKey.make("r6-native-receipt-outage-command"), "Revoke");
      const problem = Schema.decodeUnknownSync(OnboardingCommandProblem)(await native.json());
      expect(problem.code).toBe("idempotency.unavailable");
      expect(native.status()).toBe(503);
      const route = await routeCommand(page, board.etag, IdempotencyKey.make("r6-route-receipt-outage-command"), "Revoke");
      expect(route.status()).toBe(native.status());
      expect(route.headers()["cache-control"]).toContain("private");
    } finally {
      const disabled = await page.request.delete(manifest.mailboxOrigin + "/r6/command-fault", { headers });
      expect(disabled.status()).toBe(204);
    }
  });

  test("actual SDKProblem 409 digest conflict remains 409 through the onboarding route", async ({ page }) => {
    await signIn(page, manifest.persons.leader, "/dashboard/onboarding");
    const board = await readBoard(page);
    const key = IdempotencyKey.make("r6-real-digest-conflict");
    const accepted = await nativeCommand(page, board.etag, key, "Revoke");
    expect(accepted.status()).toBe(200);
    Schema.decodeUnknownSync(OnboardingResource)(await accepted.json());
    const native = await nativeCommand(page, board.etag, key, "Issue");
    const problem = Schema.decodeUnknownSync(OnboardingCommandProblem)(await native.json());
    expect(problem.code).toBe("idempotency.digest-conflict");
    expect(native.status()).toBe(409);
    const route = await routeCommand(page, board.etag, key, "Issue");
    expect(route.status()).toBe(native.status());
  });
});

test("0099 applicant claims an invited account then requests affiliation and receives a placement", async ({
  browser,
}) => {
  test.skip(!manifest, "requires the owned real PostgreSQL/backend fixture");
  const coordinator = await browser.newContext();
  const applicant = await browser.newContext();
  const managerPage = await coordinator.newPage();
  const page = await applicant.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.name));
  managerPage.on("pageerror", (e) => pageErrors.push(e.name));
  const onboarding = "/dashboard/onboarding?departmentId=" + manifest.departmentId;

  const placements =
    "/dashboard/assistenter?" +
    new URLSearchParams({ departmentId: manifest.departmentId, semesterId: manifest.semesterId });

  await signIn(managerPage, manifest.persons.leader, onboarding);

  const card = managerPage.getByRole("article").filter({
    has: managerPage.getByRole("heading", { name: "Onboarding Applicant", exact: true }),
  });

  await expect(card).toBeVisible();
  await axe(managerPage);
  await card.getByRole("button", { name: "Trekk tilbake", exact: true }).click();
  await expect(card.locator("form")).toHaveAttribute("data-pending", "false");
  await expect(card.getByRole("status")).toContainText("Endringen er lagret");
  await card.getByRole("button", { name: "Inviter", exact: true }).click();
  await expect(card.locator("form")).toHaveAttribute("data-pending", "false");
  await expect(card).toContainText("Levering: Delivered");

  const mailbox = await managerPage.request.get(manifest.mailboxOrigin + "/mail", {
    headers: { authorization: "Bearer " + manifest.mailboxToken },
  });

  expect(mailbox.status()).toBe(200);
  const messages = await mailbox.json();
  const message = messages.find((m: { to: string }) => m.to === manifest.persons.applicant.email);
  expect(Boolean(message)).toBe(true);
  const claimUrl = message.text.split(" ").at(-1);
  await page.goto(claimUrl);
  await expect(page.getByRole("heading", { name: "Knytt søknaden til din konto" })).toBeVisible();
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);

  // Opening the link cannot create a credential: native password login still fails.
  const before = await page.request.post(manifest.backendOrigin + "/api/auth/sign-in/email", {
    headers: { origin: manifest.dashboardOrigin },
    data: manifest.persons.applicant,
  });

  expect(before.status()).toBe(401);
  await page.getByLabel("Nytt passord", { exact: true }).fill(manifest.persons.applicant.password);
  await page.getByLabel("Gjenta passord").fill(manifest.persons.applicant.password);
  await page.getByRole("button", { name: "Opprett konto", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Kontoen er knyttet");
  await axe(page);
  await page.screenshot({
    path: join(manifest.artifacts, "onboarding-mobile.png"),
    fullPage: true,
  });
  await signIn(page, manifest.persons.applicant, placements);
  const own = page.getByRole("form", { name: "Min tilknytning" });
  await expect(own).toBeVisible();
  await own.getByRole("button", { name: "Be om tilknytning" }).click();
  await expect(own).toHaveAttribute("data-pending", "false");
  await managerPage.goto(manifest.dashboardOrigin + placements);

  const affiliation = managerPage.getByRole("article").filter({
    has: managerPage.getByRole("heading", { name: "Onboarding Applicant", exact: true }),
  });

  await affiliation.getByRole("button", { name: "Godkjenn tilknytning" }).click();
  await expect(affiliation.locator("form")).toHaveAttribute("data-pending", "false");
  const create = managerPage.getByRole("form", { name: "Ny skoleplassering" });
  await create
    .getByRole("combobox", { name: "Frivillig", exact: true })
    .selectOption({ label: "Onboarding Applicant" });
  await create
    .getByRole("combobox", { name: "Skole", exact: true })
    .selectOption(String(manifest.schoolId));
  await create.getByRole("combobox", { name: "Ukedag", exact: true }).selectOption("Monday");
  await create.getByLabel("Antall undervisningsdager").fill("4");
  await create.getByRole("combobox", { name: "Bolk", exact: true }).selectOption("1");
  await create.getByRole("button", { name: "Opprett plassering", exact: true }).click();
  await expect(create).toHaveAttribute("data-pending", "false");
  await expect(create.getByRole("status")).toHaveText("Endringen er lagret.");
  await managerPage.reload();
  await expect(managerPage.locator("[data-placement-id]")).toHaveCount(1);
  await axe(managerPage);
  await managerPage.screenshot({
    path: join(manifest.artifacts, "onboarding-placement.png"),
    fullPage: true,
  });
  await page.goto(claimUrl);
  await page.getByRole("button", { name: "Knytt min konto", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Invitasjonen kunne ikke brukes");
  expect(pageErrors).toEqual([]);
  await coordinator.close();
  await applicant.close();
  await writeFile(
    join(manifest.artifacts, "browser-evidence.json"),
    JSON.stringify(
      {
        revision: manifest.revision,
        passed: true,
        pageErrors,
        gates: [
          "coordinator UI invitation",
          "GET nonmutation",
          "mobile keyboard account claim",
          "native password login",
          "self affiliation and manager approval",
          "school placement",
          "consumed token refusal",
          "Axe zero violations",
        ],
      },
      null,
      2,
    ),
  );
});
