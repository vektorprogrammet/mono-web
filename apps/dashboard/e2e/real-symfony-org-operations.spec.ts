import { expect, test, type APIResponse, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const adminUsername = "org-ops-admin-0032";
const leaderUsername = "org-ops-leader-0032";
const memberUsername = "org-ops-member-0032";
const userUsername = "org-ops-user-0032";
const password = "org-operations-password-0032";
const fixtureDepartmentShortName = "OPS32";
const fixtureFieldShortName = "OPS32-STUDY";
const receiptDescription = "Org operations receipt 0032";
const createdIdentityEmail = "identity-admin-created-0032@example.invalid";
const createdDepartmentName = "Org operations created department 0032";
const createdTeamName = "Org operations created team 0032";
const createdFieldName = "Org operations created studies 0032";
const createdSchoolName = "Org operations created school 0032";
const createdSemester = { semesterTime: "Vår", year: "2032" };

const journeys = {
  financeOperations: {
    journeyRefId: "intent://journey:parity:finance_operations:v1",
    stepIds: [
      "finance-operations-api-operation",
      "finance-operations-command-write",
      "finance-operations-legacy-route",
      "finance-operations-mono-route",
    ],
  },
  identityAdmin: {
    journeyRefId: "intent://journey:parity:identity_admin:v1",
    stepIds: [
      "identity-admin-api-operation",
      "identity-admin-command-write",
      "identity-admin-legacy-route",
      "identity-admin-mono-route",
    ],
  },
  orgAdmin: {
    journeyRefId: "intent://journey:parity:org_admin:v1",
    stepIds: [
      "org-admin-api-operation",
      "org-admin-command-write",
      "org-admin-legacy-route",
      "org-admin-mono-route",
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

function requireOrgOperationsMode(): void {
  test.skip(
    process.env.REAL_SYMFONY_ORG_OPERATIONS_E2E !== "1",
    "requires the real Symfony organization operations command",
  );
  expect(process.env.REAL_SYMFONY_ORG_OPERATIONS_E2E).toBe("1");
  expect(process.env.API_MODE).not.toBe("fixture");
  expect(process.env.VITE_API_MODE).not.toBe("fixture");
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

async function requestJson(
  page: Page,
  token: string | undefined,
  method: string,
  path: string,
  body?: JsonObject,
): Promise<{ response: APIResponse; value: JsonValue }> {
  const response = await page.request.fetch(`${apiOrigin}${path}`, {
    method,
    headers: apiHeaders(token, body !== undefined),
    data: body,
  });
  return { response, value: await readJson(response) };
}

async function loginViaApi(page: Page, username: string): Promise<string> {
  const { response, value } = await requestJson(page, undefined, "POST", "/api/login", {
    username,
    password,
  });
  expect(response.status()).toBe(200);
  if (!isJsonObject(value) || typeof value.token !== "string") {
    throw new Error("Symfony login did not return a token");
  }
  return value.token;
}

async function loginDashboard(page: Page, username: string): Promise<string> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Vektorprogrammet", exact: true })).toBeVisible();
  await page.getByLabel("Brukernavn eller e-post").fill(username);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\/|$)/);
  return loginViaApi(page, username);
}

async function loginSymfony(page: Page, username: string): Promise<void> {
  await page.goto(`${apiOrigin}/login`);
  await expect(page.getByRole("heading", { name: "Innlogging", exact: true })).toBeVisible();
  await page.getByLabel("Brukernavn / e-post").fill(username);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(/\/kontrollpanel$/);
}

async function fixtureIds(
  page: Page,
  token: string,
): Promise<{ departmentId: number; fieldOfStudyId: number }> {
  const departments = await requestJson(page, token, "GET", "/api/departments");
  expect(departments.response.status()).toBe(200);
  const department = collectionItems(departments.value).find(
    (item) => item.shortName === fixtureDepartmentShortName,
  );
  if (!department) throw new Error("Org operations fixture department was not found");

  const fields = await requestJson(page, token, "GET", "/api/field_of_studies");
  expect(fields.response.status()).toBe(200);
  const field = collectionItems(fields.value).find(
    (item) => item.shortName === fixtureFieldShortName,
  );
  if (!field) throw new Error("Org operations fixture field of study was not found");

  return { departmentId: numericId(department), fieldOfStudyId: numericId(field) };
}

async function expectStatus(
  page: Page,
  token: string,
  method: string,
  path: string,
  status: number,
  body?: JsonObject,
): Promise<JsonValue> {
  const result = await requestJson(page, token, method, path, body);
  expect(result.response.status()).toBe(status);
  return result.value;
}

test.describe("Real Symfony organization operations journeys", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("finance-operations", async ({ page }) => {
    requireOrgOperationsMode();

    const leaderToken = await loginDashboard(page, leaderUsername);
    await page.goto("/dashboard/utlegg", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Utlegg", exact: true })).toBeVisible();

    const initialReceipts = await requestJson(page, leaderToken, "GET", "/api/admin/receipts");
    expect(initialReceipts.response.status()).toBe(200);
    const receipt = collectionItems(initialReceipts.value).find(
      (item) => item.description === receiptDescription,
    );
    if (!receipt) throw new Error("Org operations fixture receipt was not found");
    const receiptId = numericId(receipt);

    await expectStatus(page, leaderToken, "PUT", `/api/admin/receipts/${receiptId}/status`, 204, {
      status: "refunded",
    });

    const freshReceipts = await requestJson(page, leaderToken, "GET", "/api/admin/receipts");
    expect(freshReceipts.response.status()).toBe(200);
    const freshReceipt = collectionItems(freshReceipts.value).find(
      (item) => item.description === receiptDescription,
    );
    expect(freshReceipt?.status).toBe("refunded");
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Utlegg", exact: true })).toBeVisible();

    const userToken = await loginViaApi(page, userUsername);
    await expectStatus(page, userToken, "PUT", `/api/admin/receipts/${receiptId}/status`, 403, {
      status: "refunded",
    });
    await expectStatus(page, leaderToken, "PUT", `/api/admin/receipts/${receiptId}/status`, 422, {
      status: "pending",
    });
  });

  test("identity-admin", async ({ page }) => {
    requireOrgOperationsMode();

    const leaderToken = await loginDashboard(page, leaderUsername);
    await page.goto("/dashboard/brukere", { waitUntil: "networkidle" });
    await expect(
      page.locator("section").getByRole("heading", { name: "Brukere", exact: true }),
    ).toBeVisible();
    const { fieldOfStudyId } = await fixtureIds(page, leaderToken);

    const created = await requestJson(page, leaderToken, "POST", "/api/admin/users", {
      firstName: "Identity",
      lastName: "Admin Created",
      email: createdIdentityEmail,
      phone: "90000320",
      fieldOfStudyId,
    });
    expect(created.response.status(), JSON.stringify(created.value)).toBe(201);

    const freshUsers = await requestJson(page, leaderToken, "GET", "/api/admin/users");
    expect(freshUsers.response.status()).toBe(200);
    expect(isJsonObject(freshUsers.value)).toBe(true);
    const users = isJsonObject(freshUsers.value) ? freshUsers.value.activeUsers : null;
    expect(Array.isArray(users)).toBe(true);
    expect(
      (users as JsonValue[]).some(
        (item) => isJsonObject(item) && item.email === createdIdentityEmail,
      ),
    ).toBe(true);

    await expectStatus(page, leaderToken, "POST", "/api/admin/users", 422, {
      firstName: "Invalid",
      lastName: "Field",
      email: "identity-admin-invalid-0032@example.invalid",
      phone: "90000321",
      fieldOfStudyId: 2147483647,
    });
    const memberToken = await loginViaApi(page, memberUsername);
    await expectStatus(page, memberToken, "POST", "/api/admin/users", 403, {
      firstName: "Unauthorized",
      lastName: "Identity",
      email: "identity-admin-unauthorized-0032@example.invalid",
      phone: "90000322",
      fieldOfStudyId,
    });
  });

  test("org-admin", async ({ page }) => {
    requireOrgOperationsMode();

    const adminToken = await loginDashboard(page, adminUsername);
    await page.goto("/dashboard/team", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    const { departmentId } = await fixtureIds(page, adminToken);

    const createdDepartment = await requestJson(
      page,
      adminToken,
      "POST",
      "/api/admin/departments",
      {
        name: createdDepartmentName,
        shortName: "OPS32-NEW",
        email: "org-operations-created-department-0032@example.invalid",
        city: "OrgOps Created City 0032",
        address: "Created by the org admin journey",
        latitude: "63.4305",
        longitude: "10.3951",
      },
    );
    expect(createdDepartment.response.status()).toBe(201);
    const createdDepartmentId = numericId(createdDepartment.value);

    const freshDepartments = await requestJson(page, adminToken, "GET", "/api/departments");
    expect(freshDepartments.response.status()).toBe(200);
    expect(collectionItems(freshDepartments.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: createdDepartmentName })]),
    );

    const createdTeam = await requestJson(page, adminToken, "POST", "/api/admin/teams", {
      name: createdTeamName,
      email: "org-operations-created-team-0032@example.invalid",
      shortDescription: "Created team 0032",
      description: "Team created through the Symfony organization API.",
      departmentId: createdDepartmentId,
      acceptApplication: true,
      active: true,
      deadline: "2032-09-01",
    });
    expect(createdTeam.response.status()).toBe(201);
    expect(numericId(createdTeam.value)).toBeGreaterThan(0);

    const createdField = await requestJson(
      page,
      adminToken,
      "POST",
      "/api/admin/field-of-studies",
      {
        name: createdFieldName,
        shortName: "OPS32-LINE",
      },
    );
    expect(createdField.response.status()).toBe(201);
    expect(numericId(createdField.value)).toBeGreaterThan(0);

    const freshTeams = await requestJson(page, adminToken, "GET", "/api/teams");
    expect(freshTeams.response.status()).toBe(200);
    expect(collectionItems(freshTeams.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: createdTeamName })]),
    );
    const freshFields = await requestJson(page, adminToken, "GET", "/api/field_of_studies");
    expect(freshFields.response.status()).toBe(200);
    expect(collectionItems(freshFields.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: createdFieldName })]),
    );

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText(createdTeamName, { exact: true })).toBeVisible();
    await page.goto("/dashboard/linjer", { waitUntil: "networkidle" });
    await expect(page.getByText(createdFieldName, { exact: true })).toBeVisible();

    await expectStatus(page, adminToken, "POST", "/api/admin/teams", 422, {
      name: "Invalid organization team 0032",
      email: "org-operations-invalid-team-0032@example.invalid",
      departmentId: 2147483647,
      active: true,
    });
    const memberToken = await loginViaApi(page, memberUsername);
    await expectStatus(page, memberToken, "POST", "/api/admin/departments", 403, {
      name: "Unauthorized department 0032",
      shortName: "OPS32-NO",
      email: "org-operations-unauthorized-0032@example.invalid",
      city: "OrgOps Unauthorized City 0032",
    });
    expect(departmentId).toBeGreaterThan(0);
  });

  test("school-scheduling", async ({ browser, page }) => {
    requireOrgOperationsMode();

    const leaderToken = await loginDashboard(page, leaderUsername);
    const adminToken = await loginViaApi(page, adminUsername);
    await page.goto("/dashboard/skoler", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Skoler", exact: true })).toBeVisible();
    const { departmentId } = await fixtureIds(page, leaderToken);

    const semesterResponse = await page.request.fetch(`${apiOrigin}/api/admin/semesters`, {
      method: "POST",
      headers: { ...apiHeaders(adminToken, true), Accept: "application/json" },
      data: createdSemester,
    });
    const semester = { response: semesterResponse, value: await readJson(semesterResponse) };
    expect(semester.response.status()).toBe(201);
    expect(numericId(semester.value)).toBeGreaterThan(0);
    await expectStatus(page, adminToken, "POST", "/api/admin/semesters", 409, createdSemester);

    const school = await requestJson(page, leaderToken, "POST", "/api/admin/schools", {
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

    const symfonyAdminPage = await browser.newPage();
    try {
      await loginSymfony(symfonyAdminPage, adminUsername);
      await symfonyAdminPage.goto(`${apiOrigin}/kontrollpanel/semesteradmin`, {
        waitUntil: "networkidle",
      });
      await expect(symfonyAdminPage.getByText("Vår 2032", { exact: true })).toBeVisible();

      const symfonyLeaderPage = await browser.newPage();
      try {
        await loginSymfony(symfonyLeaderPage, leaderUsername);
        await symfonyLeaderPage.goto(`${apiOrigin}/kontrollpanel/skole/capacity/`, {
          waitUntil: "networkidle",
        });
        const capacityForm = symfonyLeaderPage.locator('form[name="schoolCapacity"]');
        expect(
          await capacityForm.count(),
          `Expected school capacity form at ${symfonyLeaderPage.url()}; body=${await symfonyLeaderPage.locator("body").innerText()}`,
        ).toBe(1);
        await capacityForm.getByLabel("Skole").selectOption({ label: createdSchoolName });
        await capacityForm.locator('input[name="schoolCapacity[monday]"]').fill("3");
        await capacityForm.locator('input[name="schoolCapacity[tuesday]"]').fill("3");
        await capacityForm.locator('input[name="schoolCapacity[wednesday]"]').fill("2");
        await capacityForm.locator('input[name="schoolCapacity[thursday]"]').fill("2");
        await capacityForm.locator('input[name="schoolCapacity[friday]"]').fill("1");
        await capacityForm.getByRole("button", { name: "Lagre", exact: true }).click();
        await expect(symfonyLeaderPage).toHaveURL(/\/kontrollpanel\/skole/);
      } finally {
        await symfonyLeaderPage.close();
      }
    } finally {
      await symfonyAdminPage.close();
    }

    const memberToken = await loginViaApi(page, memberUsername);
    await expectStatus(page, memberToken, "POST", "/api/admin/schools", 403, {
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
