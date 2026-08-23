import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";
const ADMISSION_API_ORIGIN =
  process.env.ADMISSION_API_ORIGIN ?? "http://127.0.0.1:8791";
const REAL_ADMISSION_PERIOD_E2E = process.env.REAL_ADMISSION_PERIOD_E2E === "1";
const DEPARTMENT_ID = "department-trondheim";
const FOREIGN_DEPARTMENT_ID = "department-bergen";
const SEMESTER_ID = "semester-autumn-2031";
const FIELD_OF_STUDY_ID = "field-mathematics";
const OPEN_START_INPUT = "2031-09-01T08:00";
const OPEN_END_INPUT = "2031-10-01T20:00";
const CLOSED_END_INPUT = "2031-09-10T12:00";
const OPEN_START = `${OPEN_START_INPUT}:00.000Z`;
const OPEN_END = `${OPEN_END_INPUT}:00.000Z`;
const CLOSED_END = `${CLOSED_END_INPUT}:00.000Z`;

const periodSchema = Schema.Struct({
  id: Schema.String,
  departmentId: Schema.String,
  semesterId: Schema.String,
  startAt: Schema.String,
  endAt: Schema.String,
  revision: Schema.Int,
  lastCommandId: Schema.String,
});
const periodProjectionSchema = Schema.Struct({
  ...periodSchema.fields,
  eligible: Schema.Boolean,
});
const periodPageSchema = Schema.Struct({
  items: Schema.Array(periodProjectionSchema),
  totalItems: Schema.Int,
});
const createdObservationSchema = Schema.Struct({
  _tag: Schema.Literal("Created"),
  commandId: Schema.String,
  period: periodSchema,
});
const revisedObservationSchema = Schema.Struct({
  _tag: Schema.Literal("Revised"),
  commandId: Schema.String,
  period: periodSchema,
});
const originalObservationSchema = Schema.Union([
  createdObservationSchema,
  revisedObservationSchema,
]);
const replayedObservationSchema = Schema.Struct({
  _tag: Schema.Literal("Replayed"),
  commandId: Schema.String,
  original: originalObservationSchema,
});
const observationSchema = Schema.Union([
  createdObservationSchema,
  revisedObservationSchema,
  replayedObservationSchema,
]);
const errorSchema = Schema.Struct({
  error: Schema.Struct({ tag: Schema.String }),
});
const applicationSubmissionSchema = Schema.Struct({
  _tag: Schema.Literal("Submitted"),
  commandId: Schema.String,
  applicationId: Schema.String,
});

const decodeStrict = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  value: unknown,
): A =>
  Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the real admission-period journey`);
  }
  return value;
};

const authorization = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

async function authenticate(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: "jwt_token",
      value: requiredEnvironment("ADMISSION_E2E_LEADER_TOKEN"),
      url: DASHBOARD_ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function errorTag(response: APIResponse): Promise<string> {
  return decodeStrict(errorSchema, await response.json()).error.tag;
}

async function expectErrorTag(
  response: APIResponse,
  expectedTag: string,
): Promise<{ readonly status: number; readonly tag: string }> {
  expect(response.ok()).toBe(false);
  const tag = await errorTag(response);
  expect(tag).toBe(expectedTag);
  return { status: response.status(), tag };
}

async function readManagementPage(
  request: APIRequestContext,
  token: string,
): Promise<typeof periodPageSchema.Type> {
  const response = await request.get(`${ADMISSION_API_ORIGIN}/api/admin/admission-periods`, {
    headers: authorization(token),
  });
  expect(response.ok()).toBe(true);
  return decodeStrict(periodPageSchema, await response.json());
}

async function readOpenPage(
  request: APIRequestContext,
): Promise<typeof periodPageSchema.Type> {
  const response = await request.get(`${ADMISSION_API_ORIGIN}/api/admission-periods/open`);
  expect(response.ok()).toBe(true);
  return decodeStrict(periodPageSchema, await response.json());
}

const periodFromObservation = (
  observation: typeof observationSchema.Type,
): typeof periodSchema.Type =>
  observation._tag === "Replayed" ? observation.original.period : observation.period;

test.describe("Native admission-period management", () => {
  test.skip(!REAL_ADMISSION_PERIOD_E2E, "run through the disposable PostgreSQL runner");

  test("opens and closes eligibility without moving an existing application", async ({
    browser,
    page,
    request,
  }) => {
    const leaderToken = requiredEnvironment("ADMISSION_E2E_LEADER_TOKEN");
    const foreignLeaderToken = requiredEnvironment("ADMISSION_E2E_FOREIGN_LEADER_TOKEN");
    const globalAdminToken = requiredEnvironment("ADMISSION_E2E_GLOBAL_ADMIN_TOKEN");
    const inactiveToken = requiredEnvironment("ADMISSION_E2E_INACTIVE_TOKEN");
    const roleDeniedToken = requiredEnvironment("ADMISSION_E2E_ROLE_DENIED_TOKEN");
    const evidencePath = requiredEnvironment("ADMISSION_E2E_LIFECYCLE_EVIDENCE_PATH");

    await authenticate(page);
    await page.goto("/dashboard/opptaksperioder");
    await expect(page.getByRole("heading", { level: 1, name: "Opptaksperioder" })).toBeVisible();
    await expect(page.getByText("Ingen opptaksperioder er opprettet.")).toBeVisible();

    await page.getByLabel("Semester-ID", { exact: false }).fill(SEMESTER_ID);
    await page.getByLabel("Starter (UTC)", { exact: false }).fill(OPEN_START_INPUT);
    await page.getByLabel("Slutter (UTC)", { exact: false }).fill("2031-08-31T12:00");
    await page.getByRole("button", { name: "Opprett opptaksperiode" }).click();
    const createError = page.locator('[data-error-tag="AdmissionPeriodFormError"]');
    await expect(createError).toBeVisible();
    await expect(page.getByLabel("Semester-ID", { exact: false })).toHaveValue(SEMESTER_ID);
    await expect(page.getByLabel("Starter (UTC)", { exact: false })).toHaveValue(
      OPEN_START_INPUT,
    );
    const createCommandId = await page
      .locator('form[aria-labelledby="admission-period-create-title"] input[name="commandId"]')
      .inputValue();
    expect(createCommandId.length).toBeGreaterThan(0);

    await page.getByLabel("Slutter (UTC)", { exact: false }).fill(OPEN_END_INPUT);
    await page.getByRole("button", { name: "Opprett opptaksperiode" }).click();
    await expect(page.getByRole("status").filter({ hasText: "opprettet" })).toBeVisible();
    const row = page.locator("tr[data-admission-period-id]");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-department-id", DEPARTMENT_ID);
    await expect(row).toHaveAttribute("data-revision", "0");
    await expect(row).toHaveAttribute("data-eligible", "true");
    const admissionPeriodId = await row.getAttribute("data-admission-period-id");
    expect(admissionPeriodId).not.toBeNull();
    if (admissionPeriodId === null) throw new Error("created admission-period ID was absent");

    const accessibility = await new AxeBuilder({ page })
      .include('section[aria-labelledby="admission-period-page-title"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);

    const leaderPage = await readManagementPage(request, leaderToken);
    expect(leaderPage.items).toHaveLength(1);
    expect(leaderPage.items[0]).toMatchObject({
      id: admissionPeriodId,
      departmentId: DEPARTMENT_ID,
      semesterId: SEMESTER_ID,
      revision: 0,
      eligible: true,
    });
    const foreignPage = await readManagementPage(request, foreignLeaderToken);
    expect(foreignPage.items).toEqual([]);
    const globalPage = await readManagementPage(request, globalAdminToken);
    expect(globalPage.items.map((period) => period.id)).toEqual([admissionPeriodId]);
    const openBeforeClose = await readOpenPage(request);
    expect(openBeforeClose.items.map((period) => period.id)).toContain(admissionPeriodId);

    const unauthenticated = await request.get(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods`,
    );
    const unauthenticatedError = await expectErrorTag(
      unauthenticated,
      "UnauthenticatedActor",
    );
    const inactive = await request.get(`${ADMISSION_API_ORIGIN}/api/admin/admission-periods`, {
      headers: authorization(inactiveToken),
    });
    const inactiveError = await expectErrorTag(inactive, "InactiveActor");
    const roleDenied = await request.get(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods`,
      { headers: authorization(roleDeniedToken) },
    );
    const roleDeniedError = await expectErrorTag(roleDenied, "AdmissionRoleDenied");

    const originalCreate = {
      commandId: createCommandId,
      semesterId: SEMESTER_ID,
      startAt: OPEN_START,
      endAt: OPEN_END,
    };
    const replayResponse = await request.post(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods`,
      { headers: authorization(leaderToken), data: originalCreate },
    );
    expect(replayResponse.ok()).toBe(true);
    const replay = decodeStrict(observationSchema, await replayResponse.json());
    expect(replay._tag).toBe("Replayed");
    expect(periodFromObservation(replay).id).toBe(admissionPeriodId);

    const replayConflictResponse = await request.post(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods`,
      {
        headers: authorization(leaderToken),
        data: { ...originalCreate, endAt: "2031-09-30T20:00:00.000Z" },
      },
    );
    const replayConflict = await expectErrorTag(
      replayConflictResponse,
      "DuplicateAdmissionPeriodCommandConflict",
    );

    const duplicateResponse = await request.post(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods`,
      {
        headers: authorization(leaderToken),
        data: { ...originalCreate, commandId: "admission-e2e-duplicate" },
      },
    );
    const duplicate = await expectErrorTag(
      duplicateResponse,
      "AdmissionPeriodAlreadyExists",
    );
    const invalidWindowResponse = await request.post(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods`,
      {
        headers: authorization(leaderToken),
        data: {
          ...originalCreate,
          commandId: "admission-e2e-invalid-window",
          startAt: OPEN_END,
          endAt: OPEN_START,
        },
      },
    );
    const invalidWindow = await expectErrorTag(
      invalidWindowResponse,
      "InvalidAdmissionPeriodWindow",
    );
    const crossScopeResponse = await request.post(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods`,
      {
        headers: authorization(leaderToken),
        data: {
          ...originalCreate,
          commandId: "admission-e2e-cross-scope",
          departmentId: FOREIGN_DEPARTMENT_ID,
        },
      },
    );
    const crossScope = await expectErrorTag(crossScopeResponse, "AdmissionScopeDenied");
    const malformedResponse = await request.post(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods`,
      {
        headers: {
          ...authorization(leaderToken),
          "content-type": "application/json",
        },
        data: JSON.stringify({ ...originalCreate, browserAuthority: true }),
      },
    );
    const malformed = await expectErrorTag(
      malformedResponse,
      "AdmissionPeriodDecodeError",
    );

    const applicationCommandId = "admission-e2e-application-before-close";
    const applicationResponse = await request.post(`${ADMISSION_API_ORIGIN}/api/applications`, {
      data: {
        commandId: applicationCommandId,
        departmentId: DEPARTMENT_ID,
        firstName: "Admission Proof",
        lastName: "Applicant",
        phone: "+47 900 00 038",
        email: "admission-proof-before-close@example.invalid",
        gender: 0,
        fieldOfStudyId: FIELD_OF_STUDY_ID,
        yearOfStudy: 3,
      },
    });
    expect(applicationResponse.ok()).toBe(true);
    const applicationSubmission = decodeStrict(
      applicationSubmissionSchema,
      await applicationResponse.json(),
    );
    expect(applicationSubmission.commandId).toBe(applicationCommandId);
    expect(applicationSubmission.applicationId).toBeTruthy();

    const concurrentBodies = [
      {
        commandId: "admission-e2e-concurrent-a",
        expectedRevision: 0,
        startAt: OPEN_START,
        endAt: "2031-09-25T20:00:00.000Z",
      },
      {
        commandId: "admission-e2e-concurrent-b",
        expectedRevision: 0,
        startAt: OPEN_START,
        endAt: "2031-09-26T20:00:00.000Z",
      },
    ] as const;
    const concurrentResponses = await Promise.all(
      concurrentBodies.map((data) =>
        request.post(
          `${ADMISSION_API_ORIGIN}/api/admin/admission-periods/${admissionPeriodId}/revise`,
          { headers: authorization(leaderToken), data },
        ),
      ),
    );
    const winnerIndexes = concurrentResponses
      .map((response, index) => (response.ok() ? index : -1))
      .filter((index) => index >= 0);
    expect(winnerIndexes).toHaveLength(1);
    const winnerIndex = winnerIndexes[0];
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winner = decodeStrict(
      observationSchema,
      await concurrentResponses[winnerIndex].json(),
    );
    expect(periodFromObservation(winner).revision).toBe(1);
    const concurrentLoser = await expectErrorTag(
      concurrentResponses[loserIndex],
      "StaleAdmissionPeriodRevision",
    );

    await page.reload();
    const revisedRow = page.locator(
      `tr[data-admission-period-id=${JSON.stringify(admissionPeriodId)}]`,
    );
    await expect(revisedRow).toHaveAttribute("data-revision", "1");
    await revisedRow.getByRole("button", { name: "Revider" }).click();
    const revisionPanel = page.locator("tr[data-admission-period-revision-panel]");
    const revisionEnd = revisionPanel.getByLabel("Slutter (UTC)", { exact: false });
    await revisionEnd.fill("2032-01-01T12:00");
    await revisionPanel.getByRole("button", { name: "Lagre ny versjon" }).click();
    const outsideSemesterError = page.locator(
      '[data-error-tag="AdmissionWindowOutsideSemester"]',
    );
    await expect(outsideSemesterError).toBeVisible();
    await expect(revisionEnd).toHaveValue("2032-01-01T12:00");
    const closeCommandId = await revisionPanel.locator('input[name="commandId"]').inputValue();
    expect(closeCommandId.length).toBeGreaterThan(0);

    await revisionEnd.fill(CLOSED_END_INPUT);
    await revisionPanel.getByRole("button", { name: "Lagre ny versjon" }).click();
    const closedRow = page.locator(
      `tr[data-admission-period-id=${JSON.stringify(admissionPeriodId)}]`,
    );
    await expect(closedRow).toHaveAttribute("data-revision", "2");
    await expect(closedRow).toHaveAttribute("data-eligible", "false");
    await expect(closedRow.locator('[data-eligibility="ineligible"]')).toBeVisible();

    const staleResponse = await request.post(
      `${ADMISSION_API_ORIGIN}/api/admin/admission-periods/${admissionPeriodId}/revise`,
      {
        headers: authorization(leaderToken),
        data: {
          commandId: "admission-e2e-stale-after-close",
          expectedRevision: 0,
          startAt: OPEN_START,
          endAt: CLOSED_END,
        },
      },
    );
    const stale = await expectErrorTag(staleResponse, "StaleAdmissionPeriodRevision");
    const openAfterClose = await readOpenPage(request);
    expect(openAfterClose.items).toEqual([]);

    const rejectedApplicationResponse = await request.post(
      `${ADMISSION_API_ORIGIN}/api/applications`,
      {
        data: {
          commandId: "admission-e2e-application-after-close",
          departmentId: DEPARTMENT_ID,
          firstName: "Closed Period",
          lastName: "Applicant",
          phone: "+47 900 00 138",
          email: "admission-proof-after-close@example.invalid",
          gender: 1,
          fieldOfStudyId: FIELD_OF_STUDY_ID,
          yearOfStudy: 2,
        },
      },
    );
    const rejectedApplication = await expectErrorTag(
      rejectedApplicationResponse,
      "NoEligibleAdmissionPeriod",
    );

    const invalidBrowserContext = await browser.newContext({ baseURL: DASHBOARD_ORIGIN });
    try {
      await invalidBrowserContext.addCookies([
        {
          name: "jwt_token",
          value: "invalid-admission-token",
          url: DASHBOARD_ORIGIN,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const invalidPage = await invalidBrowserContext.newPage();
      await invalidPage.goto("/dashboard/opptaksperioder");
      await expect(invalidPage).toHaveURL(/\/login\?expired=true$/);
    } finally {
      await invalidBrowserContext.close();
    }

    await writeFile(
      evidencePath,
      `${JSON.stringify({
        fixedClock: "2031-09-15T12:00:00.000Z",
        departmentScope: {
          leaderItems: leaderPage.items.length,
          foreignLeaderItems: foreignPage.items.length,
          globalItems: globalPage.items.length,
        },
        period: {
          id: admissionPeriodId,
          createCommandId,
          concurrentWinnerCommandId: concurrentBodies[winnerIndex].commandId,
          closeCommandId,
          startAt: OPEN_START,
          openEndAt: OPEN_END,
          closedEndAt: CLOSED_END,
          initialRevision: 0,
          finalRevision: 2,
        },
        application: {
          id: applicationSubmission.applicationId,
          commandId: applicationCommandId,
        },
        publicEligibility: {
          beforeClose: openBeforeClose.items.map((period) => period.id),
          afterClose: openAfterClose.items.map((period) => period.id),
        },
        replay: { tag: replay._tag, periodId: periodFromObservation(replay).id },
        concurrent: {
          winnerCommandId: concurrentBodies[winnerIndex].commandId,
          loser: concurrentLoser,
        },
        rejections: {
          unauthenticated: unauthenticatedError,
          inactive: inactiveError,
          roleDenied: roleDeniedError,
          replayConflict,
          duplicate,
          invalidWindow,
          crossScope,
          malformed,
          stale,
          rejectedApplication,
        },
      })}\n`,
      "utf8",
    );
  });
});
