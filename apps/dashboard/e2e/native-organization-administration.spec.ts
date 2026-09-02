import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { createPromiseClient } from "@vektorprogrammet/sdk";
import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5185";
const API_ORIGIN = process.env.API_URL ?? "http://127.0.0.1:8797";
const REAL_NATIVE_ORGANIZATION_E2E = process.env.REAL_NATIVE_ORGANIZATION_E2E === "1";
const JOURNEY_REF_ID = "intent://journey:parity:org_admin:v1";
const ACCEPTED_STEP_IDS = [
  "org-admin-api-operation",
  "org-admin-command-write",
  "org-admin-legacy-route",
  "org-admin-mono-route",
] as const;

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the native Organization journey`);
  }
  return value;
};

const responseBody = async (response: { json(): Promise<unknown> }): Promise<unknown> => {
  try {
    return await response.json();
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
    test.setTimeout(120_000);
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
      await expect(adminPage.getByRole("heading", { level: 1, name: "Team" })).toBeVisible({
        timeout: 15_000,
      });
      const teamTable = adminPage.getByRole("table", {
        name: "Aktive og inaktive team i organisasjonen",
      });
      await expect(teamTable.getByRole("rowheader", { name: teamPayload.name })).toBeVisible();
      await expect(teamTable).toContainText(departmentPayload.name);
      const teamAccessibility = await new AxeBuilder({ page: adminPage })
        .include('section[aria-labelledby="organization-catalog-title"]')
        .analyze();
      teamAccessibilityViolations = teamAccessibility.violations.length;
      expect(teamAccessibility.violations).toEqual([]);

      const fieldPage = await adminContext.newPage();
      observePage(fieldPage, nativePublicRequests, legacyBrowserRequests, pageErrors);
      await fieldPage.goto("/dashboard/linjer");
      await expect(
        fieldPage.getByRole("heading", { level: 1, name: "Studieretninger" }),
      ).toBeVisible({ timeout: 15_000 });
      const fieldTable = fieldPage.getByRole("table", {
        name: "Aktive og inaktive studieretninger i organisasjonen",
      });
      await expect(fieldTable.getByRole("rowheader", { name: fieldPayload.name })).toBeVisible();
      await expect(fieldTable).toContainText("Felles for alle avdelinger");
      const fieldAccessibility = await new AxeBuilder({ page: fieldPage })
        .include('section[aria-labelledby="organization-catalog-title"]')
        .analyze();
      fieldAccessibilityViolations = fieldAccessibility.violations.length;
      expect(fieldAccessibility.violations).toEqual([]);

      expect([...nativePublicRequests].sort()).toEqual(
        [
          "GET /api/departments",
          "GET /api/teams",
          "GET /api/departments",
          "GET /api/field-of-studies",
        ].sort(),
      );
      expect(legacyBrowserRequests).toEqual([]);
      expect(pageErrors).toEqual([]);

      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(
        evidencePath,
        `${JSON.stringify({
          journeyRefId: JOURNEY_REF_ID,
          acceptedStepIds: ACCEPTED_STEP_IDS,
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
