import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

const nativeApiOrigin = process.env.API_URL ?? "http://127.0.0.1:8872";
const legacyAdminUsername = "org-ops-admin-0032";
const legacyLeaderUsername = "org-ops-leader-0032";
const legacyMemberUsername = "org-ops-member-0032";
const legacyPassword = "org-operations-password-0032";
const nativeAdministrator = {
  email: "administrator.schools.0061@example.invalid",
  password: "schools-admin-0061-password",
} as const;
const nativeDirectoryEmail = "two-departments.schools.0061@example.invalid";
const fixtureDepartmentShortName = "OPS32";
const fixtureFieldShortName = "OPS32-STUDY";
const createdIdentityEmail = "identity-admin-created-0032@example.invalid";
const createdSchoolName = "Org operations created school 0032";
const createdSemester = { semesterTime: "Vår", year: "2032" };

const journeys = {
  identityAdmin: {
    journeyRefId: "intent://journey:parity:identity_admin:v1",
    stepIds: [
      "identity-admin-api-operation",
      "identity-admin-command-write",
      "identity-admin-legacy-route",
      "identity-admin-mono-route",
    ],
  },
  schoolScheduling: {
    journeyRefId: "intent://journey:parity:school_scheduling:v1",
    stepIds: [
      "school-scheduling-api-operation",
      "school-scheduling-command-write",
      "school-scheduling-legacy-route",
      "school-scheduling-mono-route",
    ],
  },
} as const;

export { journeys };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function requiredLegacyOrigin(): string {
  const origin = process.env.LEGACY_SYMFONY_URL;
  if (origin === undefined || origin.length === 0) {
    throw new Error("LEGACY_SYMFONY_URL is required for hybrid organization evidence");
  }
  return new URL(origin).origin;
}

function requireOrgOperationsMode(): void {
  test.skip(
    process.env.REAL_SYMFONY_ORG_OPERATIONS_E2E !== "1",
    "requires the real hybrid organization operations command",
  );
  expect(process.env.REAL_SYMFONY_ORG_OPERATIONS_E2E).toBe("1");
  expect(process.env.API_MODE).not.toBe("fixture");
  expect(process.env.VITE_API_MODE).not.toBe("fixture");
  expect(new URL(nativeApiOrigin).origin).not.toBe(requiredLegacyOrigin());
}

function apiHeaders(token?: string, withBody = false): Record<string, string> {
  return {
    Accept: "application/json",
    ...(withBody ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function readJson(response: APIResponse): Promise<JsonValue> {
  const text = await response.text();
  if (text.length === 0) return null;
  return JSON.parse(text) as JsonValue;
}

function collectionItems(value: JsonValue): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isJsonObject);
  if (!isJsonObject(value)) return [];
  const members = value["hydra:member"] ?? value.member ?? value.items;
  return Array.isArray(members) ? members.filter(isJsonObject) : [];
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericId(value: JsonValue): number {
  if (!isJsonObject(value) || typeof value.id !== "number") {
    throw new Error("Expected a numeric API identifier");
  }
  return value.id;
}

async function requestLegacyJson(
  request: APIRequestContext,
  token: string | undefined,
  method: string,
  path: string,
  body?: JsonObject,
): Promise<{ response: APIResponse; value: JsonValue }> {
  const response = await request.fetch(`${requiredLegacyOrigin()}${path}`, {
    method,
    headers: apiHeaders(token, body !== undefined),
    data: body,
  });
  return { response, value: await readJson(response) };
}

async function loginViaLegacyApi(request: APIRequestContext, username: string): Promise<string> {
  const { response, value } = await requestLegacyJson(request, undefined, "POST", "/api/login", {
    username,
    password: legacyPassword,
  });
  expect(response.status()).toBe(200);
  if (!isJsonObject(value) || typeof value.token !== "string") {
    throw new Error("Symfony login did not return a token");
  }
  return value.token;
}

async function loginDashboard(
  page: Page,
  redirectTo: "/dashboard/brukere" | "/dashboard/skoler",
  nativeReadPath: "/api/admin/users" | "/api/admin/schools",
): Promise<APIResponse> {
  await page.goto(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  await expect(page.getByRole("heading", { name: "Vektorprogrammet", exact: true })).toBeVisible();
  await page.getByLabel("E-post").fill(nativeAdministrator.email);
  await page.getByLabel("Passord", { exact: true }).fill(nativeAdministrator.password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click({ noWaitAfter: true });
  await page.waitForURL((url) => url.pathname === redirectTo, { waitUntil: "commit" });
  await expect
    .poll(async () =>
      (await page.context().cookies()).some(
        (cookie) => cookie.name === "better-auth.session_token",
      ),
    )
    .toBe(true);
  const response = await page.request.get(`${nativeApiOrigin}${nativeReadPath}`, {
    headers: { Accept: "application/json" },
  });
  expect(response.status()).toBe(200);
  return response;
}

async function loginSymfony(page: Page, username: string): Promise<void> {
  await page.goto(`${requiredLegacyOrigin()}/login`);
  await expect(page.getByRole("heading", { name: "Innlogging", exact: true })).toBeVisible();
  await page.getByLabel("Brukernavn / e-post").fill(username);
  await page.getByLabel("Passord").fill(legacyPassword);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(`${requiredLegacyOrigin()}/kontrollpanel`);
}

async function fixtureIds(
  request: APIRequestContext,
  token: string,
): Promise<{ departmentId: number; fieldOfStudyId: number }> {
  const departments = await requestLegacyJson(request, token, "GET", "/api/departments");
  expect(departments.response.status()).toBe(200);
  const department = collectionItems(departments.value).find(
    (item) => item.shortName === fixtureDepartmentShortName,
  );
  if (!department) throw new Error("Org operations fixture department was not found");

  const fields = await requestLegacyJson(request, token, "GET", "/api/field_of_studies");
  expect(fields.response.status()).toBe(200);
  const field = collectionItems(fields.value).find(
    (item) => item.shortName === fixtureFieldShortName,
  );
  if (!field) throw new Error("Org operations fixture field of study was not found");

  return { departmentId: numericId(department), fieldOfStudyId: numericId(field) };
}

async function expectLegacyStatus(
  request: APIRequestContext,
  token: string,
  method: string,
  path: string,
  status: number,
  body?: JsonObject,
): Promise<JsonValue> {
  const result = await requestLegacyJson(request, token, method, path, body);
  expect(result.response.status()).toBe(status);
  return result.value;
}

test.describe("Hybrid cross-line identity and school evidence", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("identity-admin hybrid cross-line evidence", async ({ browser, page, request }) => {
    requireOrgOperationsMode();

    const nativeUsersResponse = await loginDashboard(
      page,
      "/dashboard/brukere",
      "/api/admin/users",
    );
    const nativeUsers = (await nativeUsersResponse.json()) as JsonValue;
    expect(isJsonObject(nativeUsers)).toBe(true);
    const activeUsers = isJsonObject(nativeUsers) ? nativeUsers.activeUsers : null;
    expect(Array.isArray(activeUsers)).toBe(true);
    expect(
      (activeUsers as JsonValue[]).some(
        (item) => isJsonObject(item) && item.email === nativeDirectoryEmail,
      ),
    ).toBe(true);
    await expect(
      page.locator("section").getByRole("heading", { name: "Brukere", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(nativeDirectoryEmail, { exact: true })).toBeVisible();

    const leaderToken = await loginViaLegacyApi(request, legacyLeaderUsername);
    const { fieldOfStudyId } = await fixtureIds(request, leaderToken);
    const created = await requestLegacyJson(request, leaderToken, "POST", "/api/admin/users", {
      firstName: "Identity",
      lastName: "Admin Created",
      email: createdIdentityEmail,
      phone: "90000320",
      fieldOfStudyId,
    });
    expect(created.response.status(), JSON.stringify(created.value)).toBe(201);

    const freshUsers = await requestLegacyJson(request, leaderToken, "GET", "/api/admin/users");
    expect(freshUsers.response.status()).toBe(200);
    expect(isJsonObject(freshUsers.value)).toBe(true);
    const users = isJsonObject(freshUsers.value) ? freshUsers.value.activeUsers : null;
    expect(Array.isArray(users)).toBe(true);
    expect(
      (users as JsonValue[]).some(
        (item) => isJsonObject(item) && item.email === createdIdentityEmail,
      ),
    ).toBe(true);

    await expectLegacyStatus(request, leaderToken, "POST", "/api/admin/users", 422, {
      firstName: "Invalid",
      lastName: "Field",
      email: "identity-admin-invalid-0032@example.invalid",
      phone: "90000321",
      fieldOfStudyId: 2147483647,
    });
    const memberToken = await loginViaLegacyApi(request, legacyMemberUsername);
    await expectLegacyStatus(request, memberToken, "POST", "/api/admin/users", 403, {
      firstName: "Unauthorized",
      lastName: "Identity",
      email: "identity-admin-unauthorized-0032@example.invalid",
      phone: "90000322",
      fieldOfStudyId,
    });

    const legacyIdentityPage = await browser.newPage();
    try {
      await loginSymfony(legacyIdentityPage, legacyLeaderUsername);
      await legacyIdentityPage.goto(`${requiredLegacyOrigin()}/kontrollpanel/brukeradmin`, {
        waitUntil: "networkidle",
      });
      await expect(legacyIdentityPage.getByRole("heading", { name: /Brukere/u })).toBeVisible();
      await expect(legacyIdentityPage.locator("body")).toContainText(createdIdentityEmail);
    } finally {
      await legacyIdentityPage.close();
    }
  });

  test("school-scheduling hybrid cross-line evidence", async ({ browser, page, request }) => {
    requireOrgOperationsMode();

    const nativeSchoolsResponse = await loginDashboard(
      page,
      "/dashboard/skoler",
      "/api/admin/schools",
    );
    const nativeSchools = (await nativeSchoolsResponse.json()) as JsonValue;
    expect(isJsonObject(nativeSchools)).toBe(true);
    const activeSchools = isJsonObject(nativeSchools) ? nativeSchools.activeSchools : null;
    expect(Array.isArray(activeSchools)).toBe(true);
    expect(
      (activeSchools as JsonValue[]).some(
        (item) => isJsonObject(item) && item.name === "Alfaskolen",
      ),
    ).toBe(true);
    await expect(page.getByRole("heading", { name: "Skoler", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Aktive (4)" })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "Alfaskolen" })).toBeVisible();

    const leaderToken = await loginViaLegacyApi(request, legacyLeaderUsername);
    const adminToken = await loginViaLegacyApi(request, legacyAdminUsername);
    const { departmentId } = await fixtureIds(request, leaderToken);

    const semester = await requestLegacyJson(
      request,
      adminToken,
      "POST",
      "/api/admin/semesters",
      createdSemester,
    );
    expect(semester.response.status()).toBe(201);
    expect(numericId(semester.value)).toBeGreaterThan(0);
    await expectLegacyStatus(
      request,
      adminToken,
      "POST",
      "/api/admin/semesters",
      409,
      createdSemester,
    );

    const school = await requestLegacyJson(request, leaderToken, "POST", "/api/admin/schools", {
      name: createdSchoolName,
      contactPerson: "Created scheduling contact 0032",
      email: "org-operations-created-school-0032@example.invalid",
      phone: "00000033",
      international: false,
      active: true,
      departmentId,
    });
    expect(school.response.status()).toBe(201);
    const schoolId = numericId(school.value);

    const legacyAdminPage = await browser.newPage();
    try {
      await loginSymfony(legacyAdminPage, legacyAdminUsername);
      await legacyAdminPage.goto(`${requiredLegacyOrigin()}/kontrollpanel/semesteradmin`, {
        waitUntil: "networkidle",
      });
      await expect(legacyAdminPage.getByText("Vår 2032", { exact: true })).toBeVisible();

      const legacyLeaderPage = await browser.newPage();
      try {
        await loginSymfony(legacyLeaderPage, legacyLeaderUsername);
        await legacyLeaderPage.goto(`${requiredLegacyOrigin()}/kontrollpanel/skole/capacity/`, {
          waitUntil: "networkidle",
        });
        const capacityForm = legacyLeaderPage.locator('form[name="schoolCapacity"]');
        expect(
          await capacityForm.count(),
          `Expected school capacity form at ${legacyLeaderPage.url()}; body=${await legacyLeaderPage.locator("body").innerText()}`,
        ).toBe(1);
        await capacityForm.getByLabel("Skole").selectOption({ label: createdSchoolName });
        await capacityForm.locator('input[name="schoolCapacity[monday]"]').fill("3");
        await capacityForm.locator('input[name="schoolCapacity[tuesday]"]').fill("3");
        await capacityForm.locator('input[name="schoolCapacity[wednesday]"]').fill("2");
        await capacityForm.locator('input[name="schoolCapacity[thursday]"]').fill("2");
        await capacityForm.locator('input[name="schoolCapacity[friday]"]').fill("1");
        await capacityForm.getByRole("button", { name: "Lagre", exact: true }).click();
        await expect(legacyLeaderPage).toHaveURL(/\/kontrollpanel\/skole/u);
      } finally {
        await legacyLeaderPage.close();
      }
    } finally {
      await legacyAdminPage.close();
    }

    const memberToken = await loginViaLegacyApi(request, legacyMemberUsername);
    await expectLegacyStatus(request, memberToken, "POST", "/api/admin/schools", 403, {
      name: "Unauthorized scheduling school 0032",
      contactPerson: "Unauthorized contact",
      email: "org-operations-unauthorized-school-0032@example.invalid",
      phone: "00000034",
      international: false,
      active: true,
      departmentId,
    });
    expect(schoolId).toBeGreaterThan(0);
  });
});
