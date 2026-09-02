import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Frame,
  type Page,
} from "@playwright/test";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8791";
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

const managementPeriodSchema = Schema.Struct({
  id: Schema.String,
  departmentId: Schema.String,
  semesterId: Schema.String,
  startAt: Schema.String,
  endAt: Schema.String,
  revision: Schema.Int,
  etag: Schema.String,
});
const managementPageSchema = Schema.Struct({
  items: Schema.Array(managementPeriodSchema),
  totalItems: Schema.Int,
});
const openPeriodSchema = Schema.Struct({
  id: Schema.String,
  departmentId: Schema.String,
  semesterId: Schema.String,
  startAt: Schema.String,
  endAt: Schema.String,
});
const openPeriodPageSchema = Schema.Struct({
  items: Schema.Array(openPeriodSchema),
  totalItems: Schema.Int,
});
const problemSchema = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Int,
  code: Schema.String,
  detail: Schema.String,
});
const applicationSubmissionSchema = Schema.Struct({
  _tag: Schema.Literal("ApplicationConfirmed"),
  applicationId: Schema.String,
});

const decodeStrict = <A>(schema: Schema.ConstraintDecoder<A, never>, value: unknown): A =>
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

const mutationHeaders = (
  token: string,
  idempotencyKey: string,
  ifMatch?: string,
): Record<string, string> => ({
  ...authorization(token),
  "Idempotency-Key": idempotencyKey,
  ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
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

const waitForNavigationQuiescence = (page: Page): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  let timeout: ReturnType<typeof setTimeout>;
  const settle = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      page.off("framenavigated", onFrameNavigated);
      resolve();
    }, 6_000);
  };
  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) settle();
  };
  page.on("framenavigated", onFrameNavigated);
  settle();
  return promise;
};

async function expectProblemCode(
  response: APIResponse,
  expectedStatus: number,
  expectedCode: string,
): Promise<{ readonly status: number; readonly code: string }> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()["content-type"]).toContain("application/problem+json");
  const problem = decodeStrict(problemSchema, await response.json());
  expect(problem).toMatchObject({
    status: expectedStatus,
    code: expectedCode,
    type: `urn:vektorprogrammet:problem:v0.2:${expectedCode}`,
  });
  return { status: problem.status, code: problem.code };
}

async function readManagementPage(
  request: APIRequestContext,
  token: string,
): Promise<typeof managementPageSchema.Type> {
  const response = await request.get(`${BACKEND_ORIGIN}/api/admission-periods`, {
    headers: authorization(token),
  });
  expect(response.ok()).toBe(true);
  return decodeStrict(managementPageSchema, await response.json());
}

async function readOpenPage(
  request: APIRequestContext,
): Promise<typeof openPeriodPageSchema.Type> {
  const response = await request.get(`${BACKEND_ORIGIN}/api/open-admission-periods`);
  expect(response.ok()).toBe(true);
  return decodeStrict(openPeriodPageSchema, await response.json());
}

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
    const browserMutations: Array<{
      readonly method: string;
      readonly path: string;
      readonly idempotencyKey: string;
      readonly ifMatch?: string;
      readonly payload: Record<string, unknown>;
    }> = [];
    page.on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());
      if (
        url.origin !== BACKEND_ORIGIN ||
        !["POST", "PATCH"].includes(browserRequest.method()) ||
        !url.pathname.startsWith("/api/admission-periods")
      ) {
        return;
      }
      const headers = browserRequest.headers();
      const idempotencyKey = headers["idempotency-key"];
      if (idempotencyKey === undefined) return;
      browserMutations.push({
        method: browserRequest.method(),
        path: url.pathname,
        idempotencyKey,
        ...(headers["if-match"] === undefined ? {} : { ifMatch: headers["if-match"] }),
        payload: browserRequest.postDataJSON() as Record<string, unknown>,
      });
    });
    const evidencePath = requiredEnvironment("ADMISSION_E2E_LIFECYCLE_EVIDENCE_PATH");

    await authenticate(page);
    await page.goto("/dashboard/opptaksperioder");
    await expect(page.getByRole("heading", { level: 1, name: "Opptaksperioder" })).toBeVisible();
    await waitForNavigationQuiescence(page);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { level: 1, name: "Opptaksperioder" })).toBeVisible();
    await expect(page.getByText("Ingen opptaksperioder er opprettet.")).toBeVisible();

    await page.getByLabel("Semester-ID", { exact: false }).fill(SEMESTER_ID);
    await page.getByLabel("Starter (UTC)", { exact: false }).fill(OPEN_START_INPUT);
    await page.getByLabel("Slutter (UTC)", { exact: false }).fill("2031-08-31T12:00");
    await page.getByRole("button", { name: "Opprett opptaksperiode" }).click();
    const createError = page.locator('[data-error-tag="AdmissionPeriodFormError"]');
    await expect(createError).toBeVisible();
    await expect(page.getByLabel("Semester-ID", { exact: false })).toHaveValue(SEMESTER_ID);
    await expect(page.getByLabel("Starter (UTC)", { exact: false })).toHaveValue(OPEN_START_INPUT);
    await expect(
      page.locator('form[aria-labelledby="admission-period-create-title"] input[name="commandId"]'),
    ).toHaveCount(0);

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
      etag: expect.stringMatching(/^"vkr2\./u),
    });
    const foreignPage = await readManagementPage(request, foreignLeaderToken);
    expect(foreignPage.items).toEqual([]);
    const globalPage = await readManagementPage(request, globalAdminToken);
    expect(globalPage.items.map((period) => period.id)).toEqual([admissionPeriodId]);
    const openBeforeClose = await readOpenPage(request);
    expect(openBeforeClose.items.map((period) => period.id)).toContain(admissionPeriodId);

    const createMutation = browserMutations.find(
      ({ method, path }) => method === "POST" && path === "/api/admission-periods",
    );
    expect(createMutation).toBeDefined();
    if (createMutation === undefined) throw new Error("browser create request was not observed");
    expect(createMutation.payload).toEqual({
      semesterId: SEMESTER_ID,
      startAt: OPEN_START,
      endAt: OPEN_END,
    });
    expect(createMutation.payload).not.toHaveProperty("commandId");

    const unauthenticated = await request.get(`${BACKEND_ORIGIN}/api/admission-periods`);
    const unauthenticatedError = await expectProblemCode(
      unauthenticated,
      401,
      "credential.missing",
    );
    const inactive = await request.get(`${BACKEND_ORIGIN}/api/admission-periods`, {
      headers: authorization(inactiveToken),
    });
    const inactiveError = await expectProblemCode(inactive, 403, "authority.denied");
    const roleDenied = await request.get(`${BACKEND_ORIGIN}/api/admission-periods`, {
      headers: authorization(roleDeniedToken),
    });
    const roleDeniedError = await expectProblemCode(roleDenied, 403, "authority.denied");

    const originalCreate = createMutation.payload;
    const replayResponse = await request.post(`${BACKEND_ORIGIN}/api/admission-periods`, {
      headers: mutationHeaders(leaderToken, createMutation.idempotencyKey),
      data: originalCreate,
    });
    expect(replayResponse.status()).toBe(201);
    const replay = decodeStrict(managementPeriodSchema, await replayResponse.json());
    expect(replay.id).toBe(admissionPeriodId);

    const replayConflictResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admission-periods`,
      {
        headers: mutationHeaders(leaderToken, createMutation.idempotencyKey),
        data: { ...originalCreate, endAt: "2031-09-30T20:00:00.000Z" },
      },
    );
    const replayConflict = await expectProblemCode(
      replayConflictResponse,
      409,
      "idempotency.digest-conflict",
    );

    const duplicateResponse = await request.post(`${BACKEND_ORIGIN}/api/admission-periods`, {
      headers: mutationHeaders(leaderToken, "admission-e2e-duplicate"),
      data: originalCreate,
    });
    const duplicate = await expectProblemCode(
      duplicateResponse,
      409,
      "admission-period.already-exists",
    );
    const invalidWindowResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admission-periods`,
      {
        headers: mutationHeaders(leaderToken, "admission-e2e-invalid-window"),
        data: {
          ...originalCreate,
          startAt: OPEN_END,
          endAt: OPEN_START,
        },
      },
    );
    const invalidWindow = await expectProblemCode(
      invalidWindowResponse,
      422,
      "admission-period.invalid-window",
    );
    const crossScopeResponse = await request.post(`${BACKEND_ORIGIN}/api/admission-periods`, {
      headers: mutationHeaders(leaderToken, "admission-e2e-cross-scope"),
      data: {
        ...originalCreate,
        departmentId: FOREIGN_DEPARTMENT_ID,
      },
    });
    const crossScope = await expectProblemCode(crossScopeResponse, 403, "authority.denied");
    const malformedResponse = await request.post(`${BACKEND_ORIGIN}/api/admission-periods`, {
      headers: {
        ...mutationHeaders(leaderToken, "admission-e2e-malformed"),
        "content-type": "application/json",
      },
      data: JSON.stringify({ ...originalCreate, browserAuthority: true }),
    });
    const malformed = await expectProblemCode(malformedResponse, 422, "validation.failed");

    const applicationIdempotencyKey = "admission-e2e-application-before-close";
    const applicationResponse = await request.post(`${BACKEND_ORIGIN}/api/applications`, {
      headers: { "Idempotency-Key": applicationIdempotencyKey },
      data: {
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
    expect(applicationResponse.status()).toBe(201);
    const applicationSubmission = decodeStrict(
      applicationSubmissionSchema,
      await applicationResponse.json(),
    );
    expect(applicationSubmission.applicationId).toBeTruthy();

    const initialEtag = leaderPage.items[0].etag;
    const concurrentRequests = [
      {
        idempotencyKey: "admission-e2e-concurrent-a",
        payload: {
          startAt: OPEN_START,
          endAt: "2031-09-25T20:00:00.000Z",
        },
      },
      {
        idempotencyKey: "admission-e2e-concurrent-b",
        payload: {
          startAt: OPEN_START,
          endAt: "2031-09-26T20:00:00.000Z",
        },
      },
    ] as const;
    const concurrentResponses = await Promise.all(
      concurrentRequests.map(({ idempotencyKey, payload }) =>
        request.patch(`${BACKEND_ORIGIN}/api/admission-periods/${admissionPeriodId}`, {
          headers: {
            ...mutationHeaders(leaderToken, idempotencyKey, initialEtag),
            "content-type": "application/merge-patch+json",
          },
          data: payload,
        }),
      ),
    );
    const winnerIndexes = concurrentResponses
      .map((response, index) => (response.ok() ? index : -1))
      .filter((index) => index >= 0);
    expect(winnerIndexes).toHaveLength(1);
    const winnerIndex = winnerIndexes[0];
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winner = decodeStrict(
      managementPeriodSchema,
      await concurrentResponses[winnerIndex].json(),
    );
    expect(winner.revision).toBe(1);
    const concurrentLoser = await expectProblemCode(
      concurrentResponses[loserIndex],
      412,
      "precondition.failed",
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
    const outsideSemesterError = page.locator('[data-error-tag="AdmissionWindowOutsideSemester"]');
    await expect(outsideSemesterError).toBeVisible();
    await expect(revisionEnd).toHaveValue("2032-01-01T12:00");
    await expect(revisionPanel.locator('input[name="commandId"]')).toHaveCount(0);
    await expect(revisionPanel.locator('input[name="expectedRevision"]')).toHaveCount(0);

    await revisionEnd.fill(CLOSED_END_INPUT);
    await revisionPanel.getByRole("button", { name: "Lagre ny versjon" }).click();
    const closedRow = page.locator(
      `tr[data-admission-period-id=${JSON.stringify(admissionPeriodId)}]`,
    );
    await expect(closedRow).toHaveAttribute("data-revision", "2");
    await expect(closedRow).toHaveAttribute("data-eligible", "false");
    await expect(closedRow.locator('[data-eligibility="ineligible"]')).toBeVisible();

    const closeMutation = browserMutations.findLast(
      ({ method, path }) =>
        method === "PATCH" && path === `/api/admission-periods/${admissionPeriodId}`,
    );
    expect(closeMutation).toBeDefined();
    if (closeMutation === undefined) throw new Error("browser close request was not observed");
    expect(closeMutation.payload).toEqual({ startAt: OPEN_START, endAt: CLOSED_END });
    expect(closeMutation.payload).not.toHaveProperty("expectedRevision");
    expect(closeMutation.ifMatch).toMatch(/^"vkr2\./u);

    const staleResponse = await request.patch(
      `${BACKEND_ORIGIN}/api/admission-periods/${admissionPeriodId}`,
      {
        headers: {
          ...mutationHeaders(
            leaderToken,
            "admission-e2e-stale-after-close",
            initialEtag,
          ),
          "content-type": "application/merge-patch+json",
        },
        data: {
          startAt: OPEN_START,
          endAt: CLOSED_END,
        },
      },
    );
    const stale = await expectProblemCode(staleResponse, 412, "precondition.failed");
    const openAfterClose = await readOpenPage(request);
    expect(openAfterClose.items).toEqual([]);

    const rejectedApplicationResponse = await request.post(`${BACKEND_ORIGIN}/api/applications`, {
      headers: { "Idempotency-Key": "admission-e2e-application-after-close" },
      data: {
        departmentId: DEPARTMENT_ID,
        firstName: "Closed Period",
        lastName: "Applicant",
        phone: "+47 900 00 138",
        email: "admission-proof-after-close@example.invalid",
        gender: 1,
        fieldOfStudyId: FIELD_OF_STUDY_ID,
        yearOfStudy: 2,
      },
    });
    const rejectedApplication = await expectProblemCode(
      rejectedApplicationResponse,
      409,
      "application.no-eligible-period",
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
          createIdempotencyKey: createMutation.idempotencyKey,
          concurrentWinnerIdempotencyKey: concurrentRequests[winnerIndex].idempotencyKey,
          closeIdempotencyKey: closeMutation.idempotencyKey,
          startAt: OPEN_START,
          openEndAt: OPEN_END,
          closedEndAt: CLOSED_END,
          initialRevision: 0,
          finalRevision: 2,
        },
        application: {
          id: applicationSubmission.applicationId,
          idempotencyKey: applicationIdempotencyKey,
        },
        publicEligibility: {
          beforeClose: openBeforeClose.items.map((period) => period.id),
          afterClose: openAfterClose.items.map((period) => period.id),
        },
        replay: { periodId: replay.id },
        concurrent: {
          winnerIdempotencyKey: concurrentRequests[winnerIndex].idempotencyKey,
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
