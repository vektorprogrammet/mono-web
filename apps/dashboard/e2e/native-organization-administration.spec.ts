import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CreateDepartmentCommandSchema,
  CreateFieldOfStudyCommandSchema,
  CreateTeamCommandSchema,
  createClient,
} from "@vektorprogrammet/sdk";
import { Schema } from "effect";
import { expect, test, type Page, type Request } from "@playwright/test";

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
      ["/api/departments", "/api/teams", "/api/field_of_studies"].includes(url.pathname)
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
    const adminToken = requiredEnvironment("ORGANIZATION_E2E_ADMIN_TOKEN");
    const memberToken = requiredEnvironment("ORGANIZATION_E2E_MEMBER_TOKEN");
    const evidencePath = requiredEnvironment("ORGANIZATION_E2E_BROWSER_EVIDENCE_PATH");
    const publicClient = createClient(API_ORIGIN);
    const adminClient = createClient(API_ORIGIN, { auth: adminToken });
    const departmentCommand = Schema.decodeUnknownSync(CreateDepartmentCommandSchema)({
      _tag: "CreateDepartment",
      commandId: "organization-department-create-0052",
      name: "Vektorprogrammet Nord",
      shortName: "Nord",
      email: "nord@example.invalid",
      address: "Realfagbygget 1",
      city: "Tromsø",
      latitude: "69.681",
      longitude: "18.971",
    });
    const fieldCommand = Schema.decodeUnknownSync(CreateFieldOfStudyCommandSchema)({
      _tag: "CreateFieldOfStudy",
      commandId: "organization-field-create-0052",
      name: "Romteknologi",
      shortName: "Romteknologi",
      departmentId: null,
    });

    const departmentResult =
      await adminClient.admin.organization.createDepartment(departmentCommand);
    expect(departmentResult.committed).toBe(true);
    const departmentsAfterCreate = await publicClient.public.organization.listDepartments();
    const createdDepartment = departmentsAfterCreate.find(
      (department) => department.name === departmentCommand.name,
    );
    expect(createdDepartment).toBeDefined();
    if (createdDepartment === undefined)
      throw new Error("fresh Department read omitted the create");

    const teamCommand = Schema.decodeUnknownSync(CreateTeamCommandSchema)({
      _tag: "CreateTeam",
      commandId: "organization-team-create-0052",
      departmentId: createdDepartment.departmentId,
      name: "Team Nordlys",
      email: "nordlys@example.invalid",
      description: "Bygger undervisningsteam i nord.",
      shortDescription: "Undervisning i nord",
      acceptApplication: true,
      deadline: null,
      active: true,
    });
    const teamResult = await adminClient.admin.organization.createTeam(teamCommand);
    const fieldResult = await adminClient.admin.organization.createFieldOfStudy(fieldCommand);
    expect(teamResult.committed).toBe(true);
    expect(fieldResult.committed).toBe(true);

    const unknownReferenceResponse = await request.post(`${API_ORIGIN}/api/admin/teams`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      data: {
        ...teamCommand,
        commandId: "organization-team-unknown-department-0052",
        departmentId: "department-does-not-exist-0052",
      },
    });
    expect(unknownReferenceResponse.status()).toBe(422);

    const memberDeniedResponse = await request.post(`${API_ORIGIN}/api/admin/departments`, {
      headers: {
        Authorization: `Bearer ${memberToken}`,
        "Content-Type": "application/json",
      },
      data: { ...departmentCommand, commandId: "organization-member-denied-0052" },
    });
    expect(memberDeniedResponse.status()).toBe(403);

    const exactReplayResponse = await request.post(`${API_ORIGIN}/api/admin/departments`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      data: departmentCommand,
    });
    expect(exactReplayResponse.status()).toBe(200);
    const exactReplayBody = await responseBody(exactReplayResponse);
    expect(exactReplayBody).toMatchObject({ committed: false });

    const changedReplayResponse = await request.post(`${API_ORIGIN}/api/admin/departments`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      data: { ...departmentCommand, name: "Et annet navn" },
    });
    expect(changedReplayResponse.status()).toBe(409);

    const [freshDepartments, freshTeams, freshFields] = await Promise.all([
      publicClient.public.organization.listDepartments(),
      publicClient.public.organization.listTeams(),
      publicClient.public.organization.listFieldOfStudies(),
    ]);
    expect(freshDepartments).toContainEqual(
      expect.objectContaining({
        departmentId: createdDepartment.departmentId,
        name: departmentCommand.name,
      }),
    );
    expect(freshTeams).toContainEqual(
      expect.objectContaining({
        name: teamCommand.name,
        departmentId: createdDepartment.departmentId,
      }),
    );
    expect(freshFields).toContainEqual(
      expect.objectContaining({ name: fieldCommand.name, departmentId: null }),
    );

    const nativePublicRequests: string[] = [];
    const legacyBrowserRequests: string[] = [];
    const pageErrors: string[] = [];
    const context = await browser.newContext({
      baseURL: DASHBOARD_ORIGIN,
      viewport: { width: 1280, height: 800 },
    });
    await context.addCookies([
      {
        name: "jwt_token",
        value: adminToken,
        url: DASHBOARD_ORIGIN,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    let teamAccessibilityViolations = -1;
    let fieldAccessibilityViolations = -1;
    try {
      const teamPage = await context.newPage();
      observePage(teamPage, nativePublicRequests, legacyBrowserRequests, pageErrors);
      await teamPage.goto("/dashboard/team");
      await expect(teamPage.getByRole("heading", { level: 1, name: "Team" })).toBeVisible({
        timeout: 15_000,
      });
      const teamTable = teamPage.getByRole("table", {
        name: "Aktive og inaktive team i organisasjonen",
      });
      await expect(teamTable.getByRole("rowheader", { name: teamCommand.name })).toBeVisible();
      await expect(teamTable).toContainText(departmentCommand.name);
      const teamAccessibility = await new AxeBuilder({ page: teamPage })
        .include('section[aria-labelledby="organization-catalog-title"]')
        .analyze();
      teamAccessibilityViolations = teamAccessibility.violations.length;
      expect(teamAccessibility.violations).toEqual([]);

      const fieldPage = await context.newPage();
      observePage(fieldPage, nativePublicRequests, legacyBrowserRequests, pageErrors);
      await fieldPage.goto("/dashboard/linjer");
      await expect(
        fieldPage.getByRole("heading", { level: 1, name: "Studieretninger" }),
      ).toBeVisible({ timeout: 15_000 });
      const fieldTable = fieldPage.getByRole("table", {
        name: "Aktive og inaktive studieretninger i organisasjonen",
      });
      await expect(fieldTable.getByRole("rowheader", { name: fieldCommand.name })).toBeVisible();
      await expect(fieldTable).toContainText("Felles for alle avdelinger");
      const fieldAccessibility = await new AxeBuilder({ page: fieldPage })
        .include('section[aria-labelledby="organization-catalog-title"]')
        .analyze();
      fieldAccessibilityViolations = fieldAccessibility.violations.length;
      expect(fieldAccessibility.violations).toEqual([]);
    } finally {
      await context.close();
    }

    expect([...nativePublicRequests].sort()).toEqual(
      [
        "GET /api/departments",
        "GET /api/teams",
        "GET /api/departments",
        "GET /api/field_of_studies",
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
        acceptedCreates: {
          department: { commandId: departmentCommand.commandId, committed: true },
          team: { commandId: teamCommand.commandId, committed: true },
          fieldOfStudy: { commandId: fieldCommand.commandId, committed: true },
        },
        counterexamples: {
          unknownDepartment: {
            status: unknownReferenceResponse.status(),
            response: await responseBody(unknownReferenceResponse),
          },
          memberDenied: {
            status: memberDeniedResponse.status(),
            response: await responseBody(memberDeniedResponse),
          },
          exactReplay: { status: exactReplayResponse.status(), response: exactReplayBody },
          changedReplay: {
            status: changedReplayResponse.status(),
            response: await responseBody(changedReplayResponse),
          },
        },
        freshPublicReads: {
          departments: freshDepartments.map(({ departmentId, name }) => ({ departmentId, name })),
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
          teamRendered: teamCommand.name,
          fieldOfStudyRendered: fieldCommand.name,
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
  });
});
