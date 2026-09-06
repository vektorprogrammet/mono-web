import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
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
  const affiliation = managerPage
    .getByRole("article")
    .filter({
      has: managerPage.getByRole("heading", { name: "Onboarding Applicant", exact: true }),
    })
    .filter({ has: managerPage.getByRole("button", { name: "Godkjenn tilknytning" }) });
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
