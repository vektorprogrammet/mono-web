import { Option, Schema } from "effect";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DepartmentId } from "@vektorprogrammet/domain";
import { IdempotencyKey, nativeRpcPath } from "@vektorprogrammet/rpc";
import { makeScriptClient, type ScriptCallResult } from "@vektorprogrammet/rpc/script";
import { expect, test, type Page, type Request } from "@playwright/test";

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

const native = makeScriptClient(API_ORIGIN);

/** The JSON evidence of one RPC answer: its value, or its problem body. */
const answerBody = <A>(result: ScriptCallResult<A>): Schema.Json => {
  try {
    return Schema.decodeUnknownSync(Schema.Json)(
      result.ok ? result.value : "problem" in result ? result.problem : result.defect,
    );
  } catch {
    return null;
  }
};

/** An own-profile answer names its person, bare or beside its entity tag. */
const ProfileAnswer = Schema.Union([
  Schema.Struct({ personId: Schema.String }),
  Schema.Struct({ profile: Schema.Struct({ personId: Schema.String }) }),
]);

/** The native operations that the public Foldkit catalogs read. */
const publicCatalogTags = new Set([
  "organization.listDepartments",
  "organization.listTeams",
  "organization.listFieldOfStudies",
]);

/** The native RPC request that one browser request body carries. */
const RpcRequestBody = Schema.fromJsonString(Schema.Struct({ tag: Schema.String }));

/** The tag of the native RPC that one browser request body carries, if any. */
const rpcTagOf = (body: string | null): string | undefined =>
  body === null ? undefined : Option.getOrUndefined(Schema.decodeOption(RpcRequestBody)(body))?.tag;

type AuthenticatedPersona = {
  readonly cookie: string;
  readonly sessionCookieNames: ReadonlyArray<string>;
  readonly sessionPersonId: string;
};

const authenticate = async (
  page: Page,
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

  const headers = { cookie, origin: DASHBOARD_ORIGIN };
  const sessionResult = await native.call(headers, (client) => client["system.readSession"]());

  expect(sessionResult.status).toBe(200);
  expect(answerBody(sessionResult)).toMatchObject({ current: true });

  const profileResult = await native.call(headers, (client) =>
    client["profile.readOwnProfile"](),
  );

  expect(profileResult.status).toBe(200);
  const expectedPersonId = requiredEnvironment(personIdEnvironment);

  const profile = Option.getOrUndefined(
    Schema.decodeUnknownOption(ProfileAnswer)(profileResult.ok ? profileResult.value : undefined),
  );

  expect(profile === undefined ? undefined : "profile" in profile ? profile.profile.personId : profile.personId).toBe(expectedPersonId);

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
    const tag = rpcTagOf(request.postData());

    if (
      request.method() === "POST" &&
      url.pathname === nativeRpcPath &&
      tag !== undefined &&
      publicCatalogTags.has(tag)
    ) {
      nativePublicRequests.push(`${request.method()} ${url.pathname} ${tag}`);
    }

    const legacy = legacyOrganizationRequest(request);

    if (legacy !== undefined) legacyRequests.push(legacy);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
};

test.describe("Native Organization administration", () => {
  test.skip(!REAL_NATIVE_ORGANIZATION_E2E, "run through the disposable native Organization runner");

  test.afterAll(() => native.dispose());

  test("creates native records, proves counterexamples, and renders fresh Foldkit catalogs", async ({
    browser,
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
        "ORGANIZATION_E2E_ADMIN_EMAIL",
        "ORGANIZATION_E2E_ADMIN_PASSWORD",
        "ORGANIZATION_E2E_ADMIN_PERSON_ID",
      );

      const memberPage = await memberContext.newPage();

      const memberSession = await authenticate(
        memberPage,
        "ORGANIZATION_E2E_MEMBER_EMAIL",
        "ORGANIZATION_E2E_MEMBER_PASSWORD",
        "ORGANIZATION_E2E_MEMBER_PERSON_ID",
      );

      const publicHeaders = { origin: DASHBOARD_ORIGIN };
      const adminHeaders = { cookie: adminSession.cookie, origin: DASHBOARD_ORIGIN };
      const memberHeaders = { cookie: memberSession.cookie, origin: DASHBOARD_ORIGIN };

      /** The value of an RPC answer that the journey requires to succeed. */
      const required = <A>(result: ScriptCallResult<A>, operation: string): A => {
        if (!result.ok) throw new Error(`${operation} failed: ${JSON.stringify(answerBody(result))}`);

        return result.value;
      };

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

      const departmentResult = await native.call(adminHeaders, (client) =>
        client["organization.createDepartment"]({
          idempotencyKey: departmentKey,
          request: departmentPayload,
        }),
      );

      const createdDepartmentBody = required(departmentResult, "createDepartment");

      const departmentsAfterCreate = required(
        await native.call(publicHeaders, (client) => client["organization.listDepartments"]()),
        "listDepartments",
      );

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

      const teamResult = await native.call(adminHeaders, (client) =>
        client["organization.createTeam"]({ idempotencyKey: teamKey, request: teamPayload }),
      );

      required(teamResult, "createTeam");

      const fieldResult = await native.call(adminHeaders, (client) =>
        client["organization.createFieldOfStudy"]({ idempotencyKey: fieldKey, request: fieldPayload }),
      );

      required(fieldResult, "createFieldOfStudy");

      const unknownReferenceResponse = await native.call(adminHeaders, (client) =>
        client["organization.createTeam"]({
          idempotencyKey: IdempotencyKey.make("organization-team-unknown-department-0052"),
          request: {
            ...teamPayload,
            departmentId: DepartmentId.make("department-does-not-exist-0052"),
          },
        }),
      );

      expect(unknownReferenceResponse.status).toBe(422);
      const unknownReferenceBody = answerBody(unknownReferenceResponse);
      expect(unknownReferenceBody).toMatchObject({
        status: 422,
        code: "organization.invalid-reference",
        type: "urn:vektorprogrammet:problem:v0.2:organization.invalid-reference",
      });

      const memberDeniedResponse = await native.call(memberHeaders, (client) =>
        client["organization.createDepartment"]({
          idempotencyKey: IdempotencyKey.make("organization-member-denied-0052"),
          request: departmentPayload,
        }),
      );

      expect(memberDeniedResponse.status).toBe(403);
      const memberDeniedBody = answerBody(memberDeniedResponse);
      expect(memberDeniedBody).toMatchObject({
        status: 403,
        code: "authority.denied",
        type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
      });

      const exactReplayResponse = await native.call(adminHeaders, (client) =>
        client["organization.createDepartment"]({
          idempotencyKey: departmentKey,
          request: departmentPayload,
        }),
      );

      expect(exactReplayResponse.status).toBe(200);
      const exactReplayBody = answerBody(exactReplayResponse);
      expect(exactReplayBody).toEqual(answerBody(departmentResult));
      expect(exactReplayResponse.ok && exactReplayResponse.value).toEqual(createdDepartmentBody);

      const changedReplayResponse = await native.call(adminHeaders, (client) =>
        client["organization.createDepartment"]({
          idempotencyKey: departmentKey,
          request: { ...departmentPayload, name: "Et annet navn" },
        }),
      );

      expect(changedReplayResponse.status).toBe(409);
      const changedReplayBody = answerBody(changedReplayResponse);
      expect(changedReplayBody).toMatchObject({
        status: 409,
        code: "idempotency.digest-conflict",
        type: "urn:vektorprogrammet:problem:v0.2:idempotency.digest-conflict",
      });

      const [freshDepartmentsResult, freshTeamsResult, freshFieldsResult] = await Promise.all([
        native.call(publicHeaders, (client) => client["organization.listDepartments"]()),
        native.call(publicHeaders, (client) => client["organization.listTeams"]()),
        native.call(publicHeaders, (client) => client["organization.listFieldOfStudies"]()),
      ]);

      const freshDepartments = required(freshDepartmentsResult, "listDepartments");
      const freshTeams = required(freshTeamsResult, "listTeams");
      const freshFields = required(freshFieldsResult, "listFieldOfStudies");
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
              apiSessionRpc: "system.readSession",
              personBindingRpc: "profile.readOwnProfile",
              personId: adminSession.sessionPersonId,
            },
            member: {
              nativeLogin: true,
              sessionCookieNames: memberSession.sessionCookieNames,
              apiSessionRpc: "system.readSession",
              personBindingRpc: "profile.readOwnProfile",
              personId: memberSession.sessionPersonId,
            },
          },
          acceptedCreates: {
            department: { idempotencyKey: departmentKey, status: departmentResult.status },
            team: { idempotencyKey: teamKey, status: teamResult.status },
            fieldOfStudy: { idempotencyKey: fieldKey, status: fieldResult.status },
          },
          counterexamples: {
            unknownDepartment: {
              status: unknownReferenceResponse.status,
              response: unknownReferenceBody,
            },
            memberDenied: {
              status: memberDeniedResponse.status,
              response: memberDeniedBody,
            },
            exactReplay: { status: exactReplayResponse.status, response: exactReplayBody },
            changedReplay: {
              status: changedReplayResponse.status,
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
