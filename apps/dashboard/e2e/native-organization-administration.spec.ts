import { Schema } from "effect";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IdempotencyKey, OrganizationLifecycleCommand } from "@vektorprogrammet/http-api";
import { createPromiseClient } from "@vektorprogrammet/sdk";
import {
  expect,
  test,
  type APIResponse,
  type APIRequestContext,
  type Page,
  type Request,
} from "@playwright/test";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5185";

const API_ORIGIN = process.env.API_URL ?? "http://127.0.0.1:8797";

const REAL_NATIVE_ORGANIZATION_E2E = process.env.REAL_NATIVE_ORGANIZATION_E2E === "1";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the native Organization journey`);
  }

  return value;
};

const responseBody = async (response: APIResponse): Promise<Schema.Json> => {
  try {
    return Schema.decodeUnknownSync(Schema.Json)(await response.json());
  } catch {
    return null;
  }
};

type AuthenticatedPersona = {
  readonly cookie: string;
  readonly sessionCookieNames: ReadonlyArray<string>;
  readonly sessionPersonId: string;
};

const authenticate = async (
  page: Page,
  request: APIRequestContext,
  emailEnvironment: string,
  passwordEnvironment: string,
  personIdEnvironment: string,
): Promise<AuthenticatedPersona> => {
  await page.goto("/login");
  await page.getByLabel("E-post").fill(requiredEnvironment(emailEnvironment));
  await page.getByLabel("Passord", { exact: true }).fill(requiredEnvironment(passwordEnvironment));
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });

  try {
    await page.waitForURL((url) => url.pathname === "/dashboard", {
      timeout: 15_000,
      waitUntil: "commit",
    });
  } catch (cause) {
    throw new Error(
      `native login did not reach /dashboard; current URL ${page.url()}; body: ${await page.locator("body").innerText()}`,
      { cause },
    );
  }

  const sessionCookies = (await page.context().cookies(DASHBOARD_ORIGIN))
    .filter(
      ({ name }) =>
        name === "better-auth.session_token" || name === "__Secure-better-auth.session_token",
    )
    .sort(({ name: left }, { name: right }) => left.localeCompare(right));

  if (sessionCookies.length !== 1) {
    throw new Error(
      `native login issued ${sessionCookies.length} Better Auth session cookies instead of one`,
    );
  }

  const cookie = sessionCookies.map(({ name, value }) => `${name}=${value}`).join("; ");

  const sessionResponse = await request.get(`${API_ORIGIN}/api/session`, {
    headers: { Cookie: cookie },
  });

  expect(sessionResponse.status()).toBe(200);
  expect(await responseBody(sessionResponse)).toMatchObject({ current: true });

  const profileResponse = await request.get(`${API_ORIGIN}/api/profile`, {
    headers: { Cookie: cookie },
  });

  expect(profileResponse.status()).toBe(200);
  const expectedPersonId = requiredEnvironment(personIdEnvironment);
  expect(await responseBody(profileResponse)).toMatchObject({ personId: expectedPersonId });

  return {
    cookie,
    sessionCookieNames: sessionCookies.map(({ name }) => name),
    sessionPersonId: expectedPersonId,
  };
};

const legacyOrganizationRequest = (request: Request): string | undefined => {
  const url = new URL(request.url());
  const path = url.pathname;
  const usesHydraQuery = [...url.searchParams.keys()].some((key) => key.startsWith("hydra"));

  const usesLegacyAdminPath =
    path === "/api/admin/field_of_studies" || path.startsWith("/api/admin/departments/");

  return usesHydraQuery || usesLegacyAdminPath
    ? `${request.method()} ${url.pathname}${url.search}`
    : undefined;
};

const observePage = (
  page: Page,
  nativePublicRequests: string[],
  legacyRequests: string[],
  pageErrors: string[],
): void => {
  page.on("request", (request) => {
    const url = new URL(request.url());

    if (
      request.method() === "GET" &&
      ["/api/departments", "/api/teams", "/api/field-of-studies"].includes(url.pathname)
    ) {
      nativePublicRequests.push(`${request.method()} ${url.pathname}`);
    }

    const legacy = legacyOrganizationRequest(request);

    if (legacy !== undefined) legacyRequests.push(legacy);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
};

test.describe("Native Organization administration", () => {
  test.skip(!REAL_NATIVE_ORGANIZATION_E2E, "run through the disposable native Organization runner");

  test("creates native records, proves counterexamples, and renders fresh Foldkit catalogs", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const evidencePath = requiredEnvironment("ORGANIZATION_E2E_BROWSER_EVIDENCE_PATH");
    const nativePublicRequests: string[] = [];
    const legacyBrowserRequests: string[] = [];
    const pageErrors: string[] = [];

    const adminContext = await browser.newContext({
      baseURL: DASHBOARD_ORIGIN,
      viewport: { width: 1280, height: 800 },
    });

    const memberContext = await browser.newContext({
      baseURL: DASHBOARD_ORIGIN,
      viewport: { width: 1280, height: 800 },
    });

    try {
      const adminPage = await adminContext.newPage();

      const adminSession = await authenticate(
        adminPage,
        request,
        "ORGANIZATION_E2E_ADMIN_EMAIL",
        "ORGANIZATION_E2E_ADMIN_PASSWORD",
        "ORGANIZATION_E2E_ADMIN_PERSON_ID",
      );

      const memberPage = await memberContext.newPage();

      const memberSession = await authenticate(
        memberPage,
        request,
        "ORGANIZATION_E2E_MEMBER_EMAIL",
        "ORGANIZATION_E2E_MEMBER_PASSWORD",
        "ORGANIZATION_E2E_MEMBER_PERSON_ID",
      );

      const publicClient = createPromiseClient(API_ORIGIN);

      const adminClient = createPromiseClient(API_ORIGIN, {
        cookie: adminSession.cookie,
        origin: DASHBOARD_ORIGIN,
      });

      const memberClient = createPromiseClient(API_ORIGIN, {
        cookie: memberSession.cookie,
        origin: DASHBOARD_ORIGIN,
      });

      const semesterId = requiredEnvironment("ORGANIZATION_E2E_SEMESTER_ID");
      const journeyStart = requiredEnvironment("ORGANIZATION_E2E_START_AT");
      const journeyEnd = requiredEnvironment("ORGANIZATION_E2E_END_AT");
      const formInstant = (instant: string) => instant.slice(0, 16);

      const departmentKey = IdempotencyKey.make("organization-department-create-0052");

      const departmentPayload = {
        name: "Vektorprogrammet Nord",
        shortName: "Nord",
        email: "nord@example.invalid",
        address: "Realfagbygget 1",
        city: "Tromsø",
        latitude: "69.681",
        longitude: "18.971",
      };

      const fieldKey = IdempotencyKey.make("organization-field-create-0052");

      const fieldPayload = {
        name: "Romteknologi",
        shortName: "Romteknologi",
        departmentId: null,
      };

      const departmentResult = await adminClient.organization.createDepartment({
        headers: { "idempotency-key": departmentKey },
        payload: departmentPayload,
      });

      const departmentsAfterCreateResult = await publicClient.organization.listDepartments({
        headers: {},
      });

      if (departmentsAfterCreateResult.body === undefined) {
        throw new Error("listDepartments returned 304 without cache validators");
      }

      const departmentsAfterCreate = departmentsAfterCreateResult.body;

      const createdDepartment = departmentsAfterCreate.find(
        (department) => department.name === departmentPayload.name,
      );

      expect(createdDepartment).toBeDefined();

      if (createdDepartment === undefined)
        throw new Error("fresh Department read omitted the create");

      const teamKey = IdempotencyKey.make("organization-team-create-0052");

      const teamPayload = {
        departmentId: createdDepartment.departmentId,
        name: "Team Nordlys",
        email: "nordlys@example.invalid",
        description: "Bygger undervisningsteam i nord.",
        shortDescription: "Undervisning i nord",
        acceptApplication: true,
        deadline: null,
        active: true,
      };

      await adminClient.organization.createTeam({
        headers: { "idempotency-key": teamKey },
        payload: teamPayload,
      });
      await adminClient.organization.createFieldOfStudy({
        headers: { "idempotency-key": fieldKey },
        payload: fieldPayload,
      });

      const unknownReferenceResponse = await request.post(`${API_ORIGIN}/api/teams`, {
        headers: {
          Cookie: adminSession.cookie,
          Origin: DASHBOARD_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": "organization-team-unknown-department-0052",
        },
        data: {
          ...teamPayload,
          departmentId: "department-does-not-exist-0052",
        },
      });

      expect(unknownReferenceResponse.status()).toBe(422);
      const unknownReferenceBody = await responseBody(unknownReferenceResponse);
      expect(unknownReferenceBody).toMatchObject({
        status: 422,
        code: "organization.invalid-reference",
        type: "urn:vektorprogrammet:problem:v0.2:organization.invalid-reference",
      });

      const memberDeniedResponse = await request.post(`${API_ORIGIN}/api/departments`, {
        headers: {
          Cookie: memberSession.cookie,
          Origin: DASHBOARD_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": "organization-member-denied-0052",
        },
        data: departmentPayload,
      });

      expect(memberDeniedResponse.status()).toBe(403);
      const memberDeniedBody = await responseBody(memberDeniedResponse);
      expect(memberDeniedBody).toMatchObject({
        status: 403,
        code: "authority.denied",
        type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
      });

      const exactReplayResponse = await request.post(`${API_ORIGIN}/api/departments`, {
        headers: {
          Cookie: adminSession.cookie,
          Origin: DASHBOARD_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": departmentKey,
        },
        data: departmentPayload,
      });

      expect(exactReplayResponse.status()).toBe(201);
      const exactReplayBody = await responseBody(exactReplayResponse);
      expect(exactReplayBody).toEqual(departmentResult.body);

      const changedReplayResponse = await request.post(`${API_ORIGIN}/api/departments`, {
        headers: {
          Cookie: adminSession.cookie,
          Origin: DASHBOARD_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": departmentKey,
        },
        data: { ...departmentPayload, name: "Et annet navn" },
      });

      expect(changedReplayResponse.status()).toBe(409);
      const changedReplayBody = await responseBody(changedReplayResponse);
      expect(changedReplayBody).toMatchObject({
        status: 409,
        code: "idempotency.digest-conflict",
        type: "urn:vektorprogrammet:problem:v0.2:idempotency.digest-conflict",
      });

      const [freshDepartmentsResult, freshTeamsResult, freshFieldsResult] = await Promise.all([
        publicClient.organization.listDepartments({ headers: {} }),
        publicClient.organization.listTeams({ headers: {} }),
        publicClient.organization.listFieldOfStudies({ headers: {} }),
      ]);

      if (freshDepartmentsResult.body === undefined) {
        throw new Error("listDepartments returned 304 without cache validators");
      }

      if (freshTeamsResult.body === undefined) {
        throw new Error("listTeams returned 304 without cache validators");
      }

      if (freshFieldsResult.body === undefined) {
        throw new Error("listFieldOfStudies returned 304 without cache validators");
      }

      const freshDepartments = freshDepartmentsResult.body;
      const freshTeams = freshTeamsResult.body;
      const freshFields = freshFieldsResult.body;
      expect(freshDepartments).toContainEqual(
        expect.objectContaining({
          departmentId: createdDepartment.departmentId,
          name: departmentPayload.name,
        }),
      );
      expect(freshTeams).toContainEqual(
        expect.objectContaining({
          name: teamPayload.name,
          departmentId: createdDepartment.departmentId,
        }),
      );
      expect(freshFields).toContainEqual(
        expect.objectContaining({ name: fieldPayload.name, departmentId: null }),
      );

      let teamAccessibilityViolations = -1;
      let fieldAccessibilityViolations = -1;
      observePage(adminPage, nativePublicRequests, legacyBrowserRequests, pageErrors);
      await adminPage.goto("/dashboard/team");
      const teamChoice = adminPage.getByRole("combobox", { name: "Organisatorisk enhet" });

      const teamOption = teamChoice.getByRole("option", {
        name: `${teamPayload.name} (Lokalt team)`,
        exact: true,
      });

      await expect(teamOption).toBeAttached();
      const teamValue = await teamOption.getAttribute("value");

      if (teamValue === null) throw new Error("Created team cannot be selected for an appointment");
      await teamChoice.selectOption(teamValue);
      await expect(teamChoice).toHaveValue(teamValue);

      const teamAccessibility = await new AxeBuilder({ page: adminPage }).analyze();

      teamAccessibilityViolations = teamAccessibility.violations.length;
      expect(teamAccessibility.violations).toEqual([]);

      // The command is submitted by the mounted Foldkit program, not by this SDK client.
      const submitUiCommand = async (page: Page, button: string, path: string) => {
        const responsePromise = page.waitForResponse(
          (response) => new URL(response.url()).pathname === path && response.request().method() === "POST",
        );

        await page.getByRole("button", { name: button, exact: true }).click();
        const response = await responsePromise;
        expect(response.status()).toBe(200);

        return response;
      };

      const lifecyclePath = "/api/organization/appointments/commands";
      const delegationPath = "/api/organization/delegations/commands";
      const appointmentClient = await adminClient.organization.readAppointmentManagement();
      expect(appointmentClient.body.units.some((unit) => `${unit.target.kind}:${unit.target.id}` === teamValue)).toBe(true);
      await adminPage.getByRole("combobox", { name: "Person", exact: true }).selectOption(adminSession.sessionPersonId);
      await adminPage.getByLabel("Start (UTC)").fill(formInstant(journeyStart));
      await adminPage.getByLabel("Stilling (valgfritt)").fill("Veileder");
      await adminPage.getByLabel("Begrunnelse for handlingen").fill("Nytt verv i testteam");
      await submitUiCommand(adminPage, "Opprett verv", lifecyclePath);

      const appointed = (await adminClient.organization.readAppointmentManagement()).body.appointments.find(
        (row) => row.personId === adminSession.sessionPersonId && `${row.target.kind}:${row.target.id}` === teamValue,
      );

      expect(appointed).toBeDefined();

      if (appointed === undefined) throw new Error("Foldkit appointment write did not reach the backend");
      const appointmentRow = adminPage.getByRole("row").filter({ hasText: teamPayload.name }).filter({ hasText: "Ada Administrator" });
      await appointmentRow.getByRole("button", { name: "Endre verv for Ada Administrator" }).click();
      await adminPage.getByLabel("Slutt (UTC, valgfritt)").fill(formInstant(journeyEnd));
      await adminPage.getByLabel("Begrunnelse for handlingen").fill("Avsluttet etter oppdrag");
      await submitUiCommand(adminPage, "Avslutt verv på angitt sluttdato", lifecyclePath);

      const endedAppointment = (await adminClient.organization.readAppointmentManagement()).body.appointments.find(
        (row) => row.appointmentId === appointed.appointmentId,
      );

      expect(endedAppointment).toMatchObject({ revision: appointed.revision + 1, state: "Ended" });

      const delegationPage = await adminContext.newPage();
      observePage(delegationPage, nativePublicRequests, legacyBrowserRequests, pageErrors);
      await delegationPage.goto("/dashboard/delegeringer");
      await expect(delegationPage.getByRole("heading", { name: "Ny delegering" })).toBeVisible();
      const fixtureTeamId = requiredEnvironment("ORGANIZATION_E2E_FIXTURE_TEAM_ID");
      const fixtureDepartmentId = requiredEnvironment("ORGANIZATION_E2E_FIXTURE_DEPARTMENT_ID");

      const issueDelegation = async (name: string, capability: string) => {
        await delegationPage.getByLabel("Navn", { exact: true }).fill(name);
        await delegationPage.getByRole("combobox", { name: "Team", exact: true }).selectOption(fixtureTeamId);
        await delegationPage.getByRole("combobox", { name: "Kapasitet" }).selectOption(capability);
        await delegationPage.getByRole("combobox", { name: "Område" }).selectOption(fixtureDepartmentId);
        await delegationPage.getByRole("combobox", { name: "Mottakere" }).selectOption("AllMembers");
        await delegationPage.getByLabel("Start (UTC)").fill(formInstant(journeyStart));
        await delegationPage.getByLabel("Begrunnelse", { exact: true }).fill("Tidsavgrenset myndighet");
        await submitUiCommand(delegationPage, "Opprett delegering", delegationPath);
        const snapshot = (await adminClient.organization.readDelegationManagement()).body;
        const issued = snapshot.delegations.find((row) => row.name === name);
        expect(issued).toBeDefined();

        if (issued === undefined) throw new Error("Foldkit delegation issue did not persist");

        return issued;
      };

      const endDelegation = async (name: string, id: string) => {
        await delegationPage.getByRole("button", { name: `Velg ${name}` }).click();
        const scheduledEnd = new Date(Date.now() + 120_000).toISOString().slice(0, 16);
        await delegationPage.getByLabel("Slutt (UTC)", { exact: true }).fill(scheduledEnd);
        await delegationPage.getByLabel("Begrunnelse", { exact: true }).fill("Myndigheten er trukket tilbake");
        await submitUiCommand(delegationPage, "Avslutt delegering", delegationPath);

        const ended = (await adminClient.organization.readDelegationManagement()).body.delegations.find(
          (row) => row.delegationId === id,
        );

        expect(ended).toMatchObject({ revision: 1, endAt: `${scheduledEnd}:00.000Z` });
      };

      // A team leader's current appointment, not a scheduled delegation end, revokes this actor.
      await adminPage.getByRole("button", { name: "Nytt verv" }).click();
      await adminPage.getByRole("combobox", { name: "Person", exact: true }).selectOption(memberSession.sessionPersonId);
      await adminPage.getByRole("combobox", { name: "Organisatorisk enhet" }).selectOption(`Team:${fixtureTeamId}`);
      await adminPage.getByRole("checkbox", { name: "Leder av enheten" }).check();
      await adminPage.getByLabel("Start (UTC)").fill(formInstant(journeyStart));
      await adminPage.getByLabel("Begrunnelse for handlingen").fill("Tidsavgrenset teamleder");
      await submitUiCommand(adminPage, "Opprett verv", lifecyclePath);

      const leaderAppointment = (await adminClient.organization.readAppointmentManagement()).body.appointments.find(
        (row) => row.personId === memberSession.sessionPersonId && row.target.id === fixtureTeamId && row.leadership,
      );

      expect(leaderAppointment).toBeDefined();

      if (leaderAppointment === undefined) throw new Error("Leader appointment did not persist");

      const ordinaryAppointment = (await adminClient.organization.readAppointmentManagement()).body.appointments.find(
        (row) => row.appointmentId === "membership-organization-member-0052",
      );

      expect(ordinaryAppointment).toBeDefined();

      if (ordinaryAppointment === undefined) throw new Error("Fixture membership missing from management read");

      const delegatedCommand = OrganizationLifecycleCommand.cases.ReviseAppointment.make({
        commandId: "organization-delegated-appointment-0052",
        reason: "Delegert verv i medlemsteam",
        appointmentId: ordinaryAppointment.appointmentId,
        expectedRevision: ordinaryAppointment.revision,
        position: "Kontaktperson",
        leadership: false,
        startAt: ordinaryAppointment.startAt,
        endAt: ordinaryAppointment.endAt,
      });

      const delegatedKey = IdempotencyKey.make(delegatedCommand.commandId);

      const delegatedResult = await memberClient.organization.executeLifecycle({
        headers: { "idempotency-key": delegatedKey }, payload: delegatedCommand,
      });

      expect(delegatedResult.body.commandId).toBe(delegatedCommand.commandId);
      await adminPage.getByRole("row").filter({ hasText: "Mona Medlem" }).filter({ hasText: "Lederansvar" })
        .getByRole("button", { name: "Endre verv for Mona Medlem" }).click();
      await adminPage.getByLabel("Begrunnelse for handlingen").fill("Lederansvar tilbakekalt");
      await submitUiCommand(adminPage, "Suspender verv", lifecyclePath);

      const suspended = (await adminClient.organization.readAppointmentManagement()).body.appointments.find(
        (row) => row.appointmentId === leaderAppointment.appointmentId,
      );

      expect(suspended).toMatchObject({ suspended: true, revision: leaderAppointment.revision + 1 });

      const revokedReplay = await request.post(`${API_ORIGIN}${lifecyclePath}`, {
        headers: { Cookie: memberSession.cookie, Origin: DASHBOARD_ORIGIN,
          "Content-Type": "application/json", "Idempotency-Key": delegatedKey },
        data: delegatedCommand,
      });

      expect(revokedReplay.status()).toBe(403);
      expect(await responseBody(revokedReplay)).toMatchObject({ code: "authority.denied" });

      const mailingGrant = await issueDelegation("Kontaktmyndighet", "people.read");
      const mailingQuery = { department: fixtureDepartmentId, semester: semesterId, type: "team" as const };
      const mailingLists = (await memberClient.organization.listMailingLists({ query: mailingQuery })).body;
      const memberEmail = requiredEnvironment("ORGANIZATION_E2E_MEMBER_EMAIL");
      expect(mailingLists.flatMap((list) => list.emails)).toContain(memberEmail);
      const mailingUrl = `/dashboard/epostliste?department=${encodeURIComponent(fixtureDepartmentId)}&semester=${encodeURIComponent(semesterId)}&type=team`;
      const authorizedMailing = await memberContext.request.get(`${DASHBOARD_ORIGIN}${mailingUrl}`);
      expect(authorizedMailing.status()).toBe(200);
      expect(authorizedMailing.headers()["cache-control"]).toBe("private, no-store");
      expect(await authorizedMailing.text()).toContain(memberEmail);
      const mailingPage = await memberContext.newPage();
      observePage(mailingPage, nativePublicRequests, legacyBrowserRequests, pageErrors);
      await mailingPage.goto(mailingUrl);
      await expect(mailingPage.getByRole("textbox", { name: "E-postadresser" })).toHaveValue(new RegExp(memberEmail));
      await endDelegation(mailingGrant.name, mailingGrant.delegationId);
      // EndDelegation is scheduled at minute precision; the still-current grant must remain usable.
      const stillAuthorized = await memberClient.organization.listMailingLists({ query: mailingQuery });
      expect(stillAuthorized.body.flatMap((list) => list.emails)).toContain(memberEmail);

      // An ungranted member and an ungranted department are both denied immediately.
      const deniedMailing = await request.get(`${API_ORIGIN}/api/mailing-lists`, {
        headers: { Cookie: memberSession.cookie, Origin: DASHBOARD_ORIGIN },
        params: { ...mailingQuery, department: createdDepartment.departmentId },
      });

      expect(deniedMailing.status()).toBe(403);
      expect(await responseBody(deniedMailing)).toMatchObject({ code: "authority.denied" });
      const deniedUrl = `/dashboard/epostliste?department=${encodeURIComponent(createdDepartment.departmentId)}&semester=${encodeURIComponent(semesterId)}&type=team`;
      const deniedRoute = await memberContext.request.get(`${DASHBOARD_ORIGIN}${deniedUrl}`);
      expect(deniedRoute.status()).toBe(403);
      expect(deniedRoute.headers()["cache-control"]).toBe("private, no-store");
      await mailingPage.goto(deniedUrl);
      await expect(mailingPage.getByRole("alert")).toContainText("ikke tilgang");
      await expect(mailingPage.getByRole("textbox", { name: "E-postadresser" })).toHaveCount(0);
      const adminMailing = await adminClient.organization.listMailingLists({ query: mailingQuery });
      expect(adminMailing.body.flatMap((list) => list.emails)).toContain(memberEmail);
      const rosters = await adminClient.organization.readBoardRosters();
      expect(rosters.body).toBeDefined();

      const fieldPage = await adminContext.newPage();
      observePage(fieldPage, nativePublicRequests, legacyBrowserRequests, pageErrors);
      await fieldPage.goto("/dashboard/linjer");

      const fieldTable = fieldPage.getByRole("table", {
        name: "Aktive og inaktive studieretninger i organisasjonen",
      });

      await expect(fieldTable.getByRole("rowheader", { name: fieldPayload.name })).toBeVisible();

      const fieldAccessibility = await new AxeBuilder({ page: fieldPage })
        .include('section[aria-labelledby="organization-catalog-title"]')
        .analyze();

      fieldAccessibilityViolations = fieldAccessibility.violations.length;
      expect(fieldAccessibility.violations).toEqual([]);

      expect(legacyBrowserRequests).toEqual([]);
      expect(pageErrors).toEqual([]);

      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(
        evidencePath,
        `${JSON.stringify({
          sessions: {
            administrator: {
              nativeLogin: true,
              sessionCookieNames: adminSession.sessionCookieNames,
              apiSessionPath: "/api/session",
              personBindingPath: "/api/profile",
              personId: adminSession.sessionPersonId,
            },
            member: {
              nativeLogin: true,
              sessionCookieNames: memberSession.sessionCookieNames,
              apiSessionPath: "/api/session",
              personBindingPath: "/api/profile",
              personId: memberSession.sessionPersonId,
            },
          },
          acceptedCreates: {
            department: { idempotencyKey: departmentKey, status: 201 },
            team: { idempotencyKey: teamKey, status: 201 },
            fieldOfStudy: { idempotencyKey: fieldKey, status: 201 },
          },
          counterexamples: {
            unknownDepartment: {
              status: unknownReferenceResponse.status(),
              response: unknownReferenceBody,
            },
            memberDenied: {
              status: memberDeniedResponse.status(),
              response: memberDeniedBody,
            },
            exactReplay: { status: exactReplayResponse.status(), response: exactReplayBody },
            changedReplay: {
              status: changedReplayResponse.status(),
              response: changedReplayBody,
            },
          },
          organizationJourney: {
            appointmentId: appointed.appointmentId,
            leaderAppointmentId: leaderAppointment.appointmentId,
            delegatedCommandId: delegatedCommand.commandId,
            delegationId: mailingGrant.delegationId,
            revokedReplayStatus: revokedReplay.status(),
            mailingAuthorizedStatus: authorizedMailing.status(),
            mailingDeniedStatus: deniedMailing.status(),
            routeDeniedStatus: deniedRoute.status(),
            routeCacheControl: [authorizedMailing.headers()["cache-control"], deniedRoute.headers()["cache-control"]],
          },
          freshPublicReads: {
            departments: freshDepartments.map(({ departmentId, name }) => ({
              departmentId,
              name,
            })),
            teams: freshTeams.map(({ teamId, departmentId, name }) => ({
              teamId,
              departmentId,
              name,
            })),
            fieldOfStudies: freshFields.map(({ fieldOfStudyId, departmentId, name }) => ({
              fieldOfStudyId,
              departmentId,
              name,
            })),
          },
          browser: {
            teamRendered: teamPayload.name,
            fieldOfStudyRendered: fieldPayload.name,
            nativePublicRequests,
            legacyBrowserRequests,
            pageErrors,
            accessibilityViolations: {
              team: teamAccessibilityViolations,
              fieldOfStudy: fieldAccessibilityViolations,
            },
          },
        })}\n`,
        "utf8",
      );
    } finally {
      await Promise.all([adminContext.close(), memberContext.close()]);
    }
  });
});
