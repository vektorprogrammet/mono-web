import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  DepartmentId,
  NativeProblem,
  PeopleDirectoryResponse,
  SchoolCommand,
  SchoolCommandResult,
  SchoolManagement,
} from "@vektorprogrammet/http-api";
import { Predicate, Schema } from "effect";

const realNativeIdentity = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

const evidencePath = process.env.SCHOOLS_E2E_MANAGEMENT_EVIDENCE_PATH;

const departmentAlpha = "schools-e2e-0061-department-alpha";

const departmentBeta = "schools-e2e-0061-department-beta";

const semesterId = "schools-e2e-0061-semester";

const people = {
  administrator: {
    email: "administrator.schools.0061@example.invalid",
    password: "schools-admin-0061-password",
  },
  boardLeaderAlpha: {
    email: "board-leader.schools.0061@example.invalid",
    password: "schools-leader-0061-password",
  },
  directoryMember: {
    email: "one-department.schools.0061@example.invalid",
    password: "schools-one-0061-password",
  },
} as const;

const signIn = async (page: Page, person: (typeof people)[keyof typeof people]) => {
  await page.goto("/login?redirectTo=%2Fdashboard%2Fskoler");
  await page.getByLabel("E-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  await page.waitForURL((url) => url.pathname === "/dashboard/skoler", {
    timeout: 15_000,
    waitUntil: "commit",
  });
  await expect
    .poll(async () =>
      (await page.context().cookies()).some((cookie) => cookie.name === "better-auth.session_token"),
    )
    .toBe(true);
};

const nativeUrl = (page: Page, path: string) => new URL(path, page.url()).toString();

const nativeHeaders = (page: Page) => ({ origin: new URL(page.url()).origin });

const commandId = (caseName: string) => `schools-management-0061-${caseName}`;

const management = async (page: Page) => {
  const response = await page.context().request.get(nativeUrl(page, "/api/schools/management"), {
    headers: nativeHeaders(page),
  });

  expect(response.status()).toBe(200);

  return Schema.decodeUnknownSync(SchoolManagement)(await response.json());
};

const postCommand = async (page: Page, command: SchoolCommand) =>
  page.context().request.post(nativeUrl(page, "/api/schools/commands"), {
    headers: {
      ...nativeHeaders(page),
      "content-type": "application/json",
      "idempotency-key": command.commandId,
    },
    data: command,
  });

const submit = async (page: Page, label: string) => {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/schools/commands" &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: label, exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const command = Schema.decodeUnknownSync(SchoolCommand)(response.request().postDataJSON());
  const result = Schema.decodeUnknownSync(SchoolCommandResult)(await response.json());
  await expect(page.getByText("Endringen er lagret.")).toBeVisible();

  return { command, result, bytes: await response.body() };
};

const assertProblem = async (response: APIResponse, code: string, status: number) => {
  expect(response.status()).toBe(status);
  const problem = Schema.decodeUnknownSync(NativeProblem)(await response.json());
  expect(problem.code).toBe(code);
  expect(problem.status).toBe(status);
};

const schoolFacts = {
  name: "Prøveskolen",
  contactPerson: "Kontakt Test",
  email: "kontakt@proveskolen.example.invalid",
  phone: "+47 900 00 601",
  language: "Norwegian",
  active: true,
} as const;

test.describe("Native Schools management through generated DirectoryApi", () => {
  test.skip(!realNativeIdentity, "run through the disposable PostgreSQL Schools runner");

  test("commits scoped facts, associations and capacity with replay, denial and history", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    const pageErrors: string[] = [];
    admin.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await signIn(admin, people.administrator);
      await expect(admin.getByRole("heading", { name: "Skoler", exact: true })).toBeVisible();
      await admin.getByRole("button", { name: "Administrer skoler" }).click();
      await expect(admin.getByRole("heading", { name: "Skoleadministrasjon" })).toBeVisible();
      await admin.getByLabel("Begrunnelse").fill("Ny samarbeidsskole");
      await admin.getByLabel("Skolenavn").fill(schoolFacts.name);
      await admin.getByLabel("Kontaktperson").fill(schoolFacts.contactPerson);
      await admin.getByLabel("E-postadresse").fill(schoolFacts.email);
      await admin.getByLabel("Telefonnummer").fill(schoolFacts.phone);
      await admin.getByRole("checkbox", { name: "Avdeling Alfa" }).check();
      const created = await submit(admin, "Lagre skole");
      expect(created.command._tag).toBe("CreateSchool");
      expect(created.result.revision).toBe(0);
      await expect(admin.getByLabel("Skolenavn")).toHaveValue(schoolFacts.name);
      await expect(admin.getByText("Skolerevisjon: 0")).toBeVisible();

      await admin.getByLabel("Begrunnelse").fill("Oppdatert kontakt");
      await admin.getByLabel("Skolenavn").fill("Prøveskolen oppdatert");
      const revised = await submit(admin, "Lagre skole");
      expect(revised.command._tag).toBe("ReviseSchool");
      expect(revised.result.schoolId).toBe(created.result.schoolId);
      expect(revised.result.revision).toBe(1);
      await expect(admin.getByText("Skolerevisjon: 1")).toBeVisible();

      await admin.getByLabel("Begrunnelse").fill("Deles mellom avdelinger");
      await admin.getByRole("checkbox", { name: "Avdeling Beta" }).check();
      const associated = await submit(admin, "Lagre avdelinger");
      expect(associated.command._tag).toBe("ReplaceSchoolDepartments");
      expect(associated.result.revision).toBe(2);
      await expect(admin.getByText("Skolerevisjon: 2")).toBeVisible();

      await admin.getByLabel("Begrunnelse").fill("Kapasitet i Alfa");
      await admin.getByLabel("Kapasitetsavdeling").selectOption(departmentAlpha);
      await admin.getByLabel("Kapasitetssemester").selectOption(semesterId);
      await admin.getByLabel("Mandag").fill("2");
      const capacity = await submit(admin, "Lagre kapasitet");
      expect(capacity.command._tag).toBe("CreateCapacity");
      expect(capacity.result.capacityId).not.toBeNull();
      await expect(admin.getByText(/Kapasitetsrevisjon: 0/u)).toBeVisible();

      await admin.getByLabel("Begrunnelse").fill("Økt mandagskapasitet");
      await admin.getByLabel("Mandag").fill("3");
      const revisedCapacity = await submit(admin, "Lagre kapasitet");
      expect(revisedCapacity.command._tag).toBe("ReviseCapacity");
      expect(revisedCapacity.result.capacityId).toBe(capacity.result.capacityId);
      await expect(admin.getByText(/Kapasitetsrevisjon: 1/u)).toBeVisible();

      if (!Predicate.isTagged(capacity.command, "CreateCapacity"))
        throw new Error("expected the browser to submit CreateCapacity");

      if (!Predicate.isTagged(revisedCapacity.command, "ReviseCapacity"))
        throw new Error("expected the browser to submit ReviseCapacity");

      const replay = await postCommand(admin, capacity.command);
      expect(replay.status()).toBe(200);
      expect(await replay.body()).toEqual(capacity.bytes);
      await assertProblem(
        await postCommand(admin, { ...capacity.command, monday: 7 }),
        "idempotency.digest-conflict",
        409,
      );
      await assertProblem(
        await postCommand(admin, {
          ...revisedCapacity.command,
          commandId: commandId("stale-capacity"),
          monday: 8,
        }),
        "precondition.failed",
        412,
      );

      await assertProblem(
        await postCommand(
          admin,
          SchoolCommand.cases.ReplaceSchoolDepartments.make({
            commandId: commandId("remove-in-use-association"),
            reason: "Kapasitet må verne tilknytningen",
            schoolId: created.result.schoolId,
            expectedRevision: associated.result.revision,
            departmentIds: [DepartmentId.make(departmentBeta)],
          }),
        ),
        "schools.association-in-use",
        409,
      );

      const invalidId = commandId("invalid-capacity");
      await assertProblem(
        await adminContext.request.post(nativeUrl(admin, "/api/schools/commands"), {
          headers: {
            ...nativeHeaders(admin),
            "content-type": "application/json",
            "idempotency-key": invalidId,
          },
          data: { ...capacity.command, commandId: invalidId, monday: -1 },
        }),
        "schools.invalid-command",
        422,
      );

      const adminSnapshot = await management(admin);
      const saved = adminSnapshot.schools.find((row) => row.school.schoolId === created.result.schoolId);
      expect(saved?.school.name).toBe("Prøveskolen oppdatert");
      expect(saved?.departmentIds).toEqual([departmentAlpha, departmentBeta]);
      expect(saved?.capacities).toHaveLength(1);
      expect(saved?.capacities[0]?.monday).toBe(3);

      for (const command of [created.command, revised.command, associated.command, capacity.command, revisedCapacity.command]) {
        expect(adminSnapshot.history.filter((item) => item.commandId === command.commandId)).toHaveLength(1);
      }

      const leaderContext = await browser.newContext();
      const leader = await leaderContext.newPage();

      try {
        await signIn(leader, people.boardLeaderAlpha);
        const scoped = await management(leader);
        expect(scoped.departments.map((item) => item.departmentId)).toEqual([departmentAlpha]);
        expect(scoped.schools.find((row) => row.school.schoolId === created.result.schoolId)?.canEditShared).toBe(false);
        expect(scoped.schools.some((row) => row.school.name === "Betaskolen")).toBe(false);
        const shared = scoped.schools.find((row) => row.school.schoolId === created.result.schoolId);
        expect(shared?.capacityDepartmentIds).toEqual([departmentAlpha]);
        expect(shared?.capacities.every((plan) => plan.departmentId === departmentAlpha)).toBe(true);
        await assertProblem(
          await postCommand(
            leader,
            SchoolCommand.cases.ReviseSchool.make({
              ...schoolFacts,
              commandId: commandId("shared-facts-denied"),
              reason: "Uten delt myndighet",
              schoolId: created.result.schoolId,
              expectedRevision: associated.result.revision,
            }),
          ),
          "authority.denied",
          403,
        );
        await assertProblem(
          await postCommand(leader, {
            ...capacity.command,
            commandId: commandId("other-department-denied"),
            departmentId: DepartmentId.make(departmentBeta),
          }),
          "authority.denied",
          403,
        );
      } finally {
        await leaderContext.close();
      }

      const memberContext = await browser.newContext();
      const member = await memberContext.newPage();

      try {
        await signIn(member, people.directoryMember);

        const forbiddenRead = await memberContext.request.get(nativeUrl(member, "/api/schools/management"), {
          headers: nativeHeaders(member),
        });

        await assertProblem(forbiddenRead, "authority.denied", 403);
        await expect(member.getByRole("button", { name: "Administrer skoler" })).toHaveCount(0);
      } finally {
        await memberContext.close();
      }

      await admin.getByLabel("Begrunnelse").fill("Samarbeidet avsluttet");
      await admin.getByLabel("Aktiv status").selectOption("false");
      const deactivated = await submit(admin, "Lagre skole");
      expect(deactivated.command._tag).toBe("ReviseSchool");
      expect(deactivated.result.revision).toBe(3);
      const inactive = await management(admin);
      const inactiveSchool = inactive.schools.find((row) => row.school.schoolId === created.result.schoolId);
      expect(inactiveSchool?.school.active).toBe(false);
      expect(inactiveSchool?.capacities).toHaveLength(1);
      expect(inactive.history.filter((item) => item.commandId === deactivated.command.commandId)).toHaveLength(1);
      const axe = await new AxeBuilder({ page: admin }).analyze();
      expect(axe.violations.filter((issue) => issue.impact === "serious" || issue.impact === "critical")).toEqual([]);

      await admin.goto("/dashboard/brukere");
      await expect(admin.getByRole("heading", { name: "Brukere" }).first()).toBeVisible();

      const peopleResponse = await adminContext.request.get(nativeUrl(admin, "/api/people"), {
        headers: nativeHeaders(admin),
      });

      expect(peopleResponse.status()).toBe(200);
      const peopleDirectory = Schema.decodeUnknownSync(PeopleDirectoryResponse)(await peopleResponse.json());
      expect(
        [...peopleDirectory.activePeople, ...peopleDirectory.inactivePeople].filter(
          (entry) => entry.email === people.administrator.email,
        ),
      ).toHaveLength(1);
      expect(pageErrors).toEqual([]);

      if (evidencePath !== undefined)
        await writeFile(
          evidencePath,
          JSON.stringify({
            specId: "0011",
            passed: true,
            schoolId: created.result.schoolId,
            schoolRevision: deactivated.result.revision,
            capacityRevision: revisedCapacity.result.revision,
            commandIds: [created.command, revised.command, associated.command, capacity.command, revisedCapacity.command, deactivated.command].map((command) => command.commandId),
            replayByteEqual: true,
            scopedManagement: true,
            peopleDirectory: true,
            pageErrors,
          }),
        );
    } finally {
      await adminContext.close();
    }
  });
});
