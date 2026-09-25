import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";
import {
  AdmissionPeriodManagementItem,
  AdmissionPeriodManagementListResponse,
  AdmissionPeriodMergePatch,
  AdmissionsCreateAdmissionPeriodProblem,
  AdmissionsListAdmissionPeriodsProblem,
  AdmissionsReviseAdmissionPeriodProblem,
  AdmissionsSubmitApplicationProblem,
  CreateAdmissionPeriodRequest,
  NativeProblemRegistry,
  OpenAdmissionPeriodListResponse,
  PublicApplicationConfirmationSchema,
  SessionUnauthorizedProblem,
} from "@vektorprogrammet/http-api";
import { DateTime, Schema } from "effect";
import { dashboardMount, dashboardPagePath } from "../dashboard-base";

const REAL_ADMISSION_PERIOD_E2E = process.env.REAL_ADMISSION_PERIOD_E2E === "1";

const OPEN_START_INPUT = "2025-09-01T08:00";

const OPEN_END_INPUT = "2025-10-01T20:00";

const BEFORE_START_INPUT = "2025-08-31T12:00";

const CLOSED_END_INPUT = "2025-09-10T12:00";

const OUTSIDE_SEMESTER_END_INPUT = "2026-01-01T12:00";

const OPEN_START = `${OPEN_START_INPUT}:00.000Z`;

const OPEN_END = `${OPEN_END_INPUT}:00.000Z`;

const BEFORE_START = `${BEFORE_START_INPUT}:00.000Z`;

const CLOSED_END = `${CLOSED_END_INPUT}:00.000Z`;

const OUTSIDE_SEMESTER_END = `${OUTSIDE_SEMESTER_END_INPUT}:00.000Z`;

const CONFLICTING_END = "2025-09-30T20:00:00.000Z";

const CONCURRENT_ENDS = ["2025-09-25T20:00:00.000Z", "2025-09-26T20:00:00.000Z"] as const;

const exact = { onExcessProperty: "error" } as const;

const JourneyReference = Schema.fromJsonString(
  Schema.Struct({
    fixedNow: Schema.DateTimeUtcFromString,
    departmentId: Schema.String,
    foreignDepartmentId: Schema.String,
    semester: Schema.Struct({
      id: Schema.String,
      startAt: Schema.DateTimeUtcFromString,
      endAt: Schema.DateTimeUtcFromString,
    }),
    fieldOfStudyId: Schema.String,
  }),
);

type JourneyReference = typeof JourneyReference.Type;

const Persona = Schema.Struct({ email: Schema.String, password: Schema.String });

type Persona = typeof Persona.Type;

const JourneyPersonas = Schema.fromJsonString(
  Schema.Struct({
    leader: Persona,
    foreignLeader: Persona,
    globalAdministrator: Persona,
    inactiveLeader: Persona,
    member: Persona,
  }),
);

/** One dashboard-server request to the backend, as the runner's recording proxy saw it. */
const LedgerRecord = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.String,
    path: Schema.String,
    idempotencyKey: Schema.NullOr(Schema.String),
    ifMatch: Schema.NullOr(Schema.String),
    body: Schema.Json,
    status: Schema.Int,
    problemCode: Schema.NullOr(Schema.String),
  }),
);

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the real admission-period journey`);
  }

  return value;
};

const readLedger = async (path: string) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(LedgerRecord)(line));

/** The windows below must sit where the laws need them in the calendar that the runner seeds. */
const assertCalendar = ({ fixedNow, semester }: JourneyReference) => {
  const instants = [
    semester.startAt,
    DateTime.makeUnsafe(BEFORE_START),
    DateTime.makeUnsafe(OPEN_START),
    DateTime.makeUnsafe(CLOSED_END),
    fixedNow,
    ...CONCURRENT_ENDS.map((instant) => DateTime.makeUnsafe(instant)),
    DateTime.makeUnsafe(OPEN_END),
    semester.endAt,
    DateTime.makeUnsafe(OUTSIDE_SEMESTER_END),
  ];

  expect(
    instants.every(
      (instant, index) => index === 0 || DateTime.isLessThan(instants[index - 1]!, instant),
    ),
    "journey windows are ordered against the seeded semester and pinned clock",
  ).toBe(true);
};

/**
 * The closed Problem Details unions that the admission endpoints declare, and the credential
 * problems that their person security middleware declares once for all of them.
 */
type AdmissionProblems =
  | typeof SessionUnauthorizedProblem
  | typeof AdmissionsListAdmissionPeriodsProblem
  | typeof AdmissionsCreateAdmissionPeriodProblem
  | typeof AdmissionsReviseAdmissionPeriodProblem
  | typeof AdmissionsSubmitApplicationProblem;

/** The union names the codes that the operation may answer; the registry owns each status. */
async function expectProblem<const Problems extends AdmissionProblems>(
  response: Response,
  problems: Problems,
  expectedCode: Problems["Type"]["code"],
): Promise<{ readonly status: number; readonly code: string }> {
  const body: unknown = await response.json();

  expect({ status: response.status, body }).toMatchObject({
    status: NativeProblemRegistry[expectedCode].status,
    body: { code: expectedCode },
  });
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  let problem: Problems["Type"];

  try {
    problem = Schema.decodeUnknownSync(problems, exact)(body);
  } catch (error) {
    throw new Error(`${JSON.stringify(body)} is not a declared problem: ${String(error)}`);
  }

  return { status: problem.status, code: problem.code };
}

const nativeApi = (backendOrigin: string, dashboardOrigin: string) => {
  const request = (
    method: "GET" | "POST" | "PATCH",
    path: string,
    options: {
      readonly session?: string;
      readonly idempotencyKey?: string;
      readonly ifMatch?: string;
      readonly contentType?: string;
      readonly body?: Schema.Json;
    } = {},
  ) => {
    const headers = new Headers();

    if (options.session !== undefined) {
      headers.set("cookie", options.session);
      headers.set("origin", dashboardOrigin);
    }

    if (options.idempotencyKey !== undefined) {
      headers.set("idempotency-key", options.idempotencyKey);
    }

    if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);

    if (options.body !== undefined) {
      headers.set("content-type", options.contentType ?? "application/json");
    }

    const requestBody: Pick<RequestInit, "body"> =
      options.body === undefined ? {} : { body: JSON.stringify(options.body) };

    return fetch(`${backendOrigin}${path}`, {
      method,
      headers,
      ...requestBody,
      redirect: "manual",
    });
  };

  return {
    request,
    signIn: async ({ email, password }: Persona): Promise<string> => {
      const response = await fetch(`${backendOrigin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: dashboardOrigin },
        body: JSON.stringify({ email, password }),
        redirect: "manual",
      });

      expect(response.status, `native sign-in of ${email}`).toBe(200);

      const session = response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";", 1)[0] ?? "")
        .find((pair) => pair.startsWith("better-auth.session_token="));

      if (session === undefined) {
        throw new Error(`native sign-in of ${email} issued no session cookie`);
      }

      return session;
    },
    readManagementPage: async (session: string) => {
      const response = await request("GET", "/api/admission-periods", { session });
      expect(response.status).toBe(200);

      return Schema.decodeUnknownSync(AdmissionPeriodManagementListResponse, exact)(
        await response.json(),
      );
    },
    readOpenPage: async () => {
      const response = await request("GET", "/api/open-admission-periods");
      expect(response.status).toBe(200);

      return Schema.decodeUnknownSync(OpenAdmissionPeriodListResponse, exact)(
        await response.json(),
      );
    },
  };
};

/** A click that lands before hydration has no handler, so retry until the panel reports open. */
const openRevisionPanel = async (row: Locator) => {
  const toggle = row.locator("button[aria-controls]");

  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass();
};

test.describe("Native admission-period management", () => {
  test.skip(!REAL_ADMISSION_PERIOD_E2E, "run through the disposable PostgreSQL runner");

  test("opens and closes eligibility without moving an existing application", async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);

    const reference = Schema.decodeUnknownSync(JourneyReference)(
      requiredEnvironment("ADMISSION_E2E_REFERENCE"),
    );

    const personas = Schema.decodeUnknownSync(JourneyPersonas)(
      requiredEnvironment("ADMISSION_E2E_PERSONAS"),
    );

    const dashboardOrigin = requiredEnvironment("DASHBOARD_ORIGIN");
    const ledgerPath = requiredEnvironment("ADMISSION_E2E_PROXY_LEDGER_PATH");
    const evidencePath = requiredEnvironment("ADMISSION_E2E_LIFECYCLE_EVIDENCE_PATH");
    const api = nativeApi(requiredEnvironment("BACKEND_ORIGIN"), dashboardOrigin);
    const mount = dashboardMount(process.env);
    const pagePath = dashboardPagePath("/opptaksperioder");
    const routeWithinMount = pagePath.slice(mount.length - 1);
    const semesterId = reference.semester.id;
    assertCalendar(reference);

    await page.goto(`${mount}login?redirectTo=${encodeURIComponent(routeWithinMount)}`);
    await page.getByLabel("E-post").fill(personas.leader.email);
    await page.getByLabel("Passord", { exact: true }).fill(personas.leader.password);
    await page.getByRole("button", { name: "Logg inn", exact: true }).click();
    await page.waitForURL((url) => url.pathname === pagePath);
    expect((await page.context().cookies(dashboardOrigin)).map(({ name }) => name)).toContain(
      "better-auth.session_token",
    );
    await expect(page.getByRole("heading", { level: 1, name: "Opptaksperioder" })).toBeVisible();
    await expect(page.getByText("Ingen opptaksperioder er opprettet.")).toBeVisible();

    await page.getByLabel("Semester-ID", { exact: false }).fill(semesterId);
    await page.getByLabel("Starter (UTC)", { exact: false }).fill(OPEN_START_INPUT);
    await page.getByLabel("Slutter (UTC)", { exact: false }).fill(BEFORE_START_INPUT);
    await page.getByRole("button", { name: "Opprett opptaksperiode" }).click();
    const createError = page.locator('[data-error-tag="AdmissionPeriodFormError"]');
    await expect(createError).toBeVisible();
    await expect(createError).toHaveAttribute("data-error-field", "endAt");
    await expect(page.getByLabel("Semester-ID", { exact: false })).toHaveValue(semesterId);
    await expect(page.getByLabel("Starter (UTC)", { exact: false })).toHaveValue(OPEN_START_INPUT);
    const rejectedCreateKey = await createError.getAttribute("data-command-id");
    expect(rejectedCreateKey).not.toBeNull();

    await page.getByLabel("Slutter (UTC)", { exact: false }).fill(OPEN_END_INPUT);
    await page.getByRole("button", { name: "Opprett opptaksperiode" }).click();
    await expect(page.getByRole("status").filter({ hasText: "opprettet" })).toBeVisible();
    const row = page.locator("tr[data-admission-period-id]");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-department-id", reference.departmentId);
    await expect(row).toHaveAttribute("data-semester-id", semesterId);
    await expect(row).toHaveAttribute("data-revision", "0");
    await expect(row.locator(`time[datetime="${OPEN_END}"]`)).toBeVisible();
    const admissionPeriodId = await row.getAttribute("data-admission-period-id");
    expect(admissionPeriodId).not.toBeNull();

    if (admissionPeriodId === null) throw new Error("created admission-period ID was absent");

    const periodPath = `/api/admission-periods/${encodeURIComponent(admissionPeriodId)}`;

    const accessibility = await new AxeBuilder({ page })
      .include('section[aria-labelledby="admission-period-page-title"]')
      .analyze();

    expect(accessibility.violations).toEqual([]);

    // The form's own window check rejected the first attempt before any command left the
    // dashboard; the corrected attempt reuses that attempt's key and sends it only as a header.
    const createCommands = (await readLedger(ledgerPath)).filter(
      ({ method, path }) => method === "POST" && path === "/api/admission-periods",
    );

    expect(createCommands).toHaveLength(1);
    const [createCommand] = createCommands;

    if (createCommand === undefined) throw new Error("browser create request was not observed");
    expect(createCommand.status).toBe(201);
    expect(createCommand.idempotencyKey).toBe(rejectedCreateKey);
    expect(
      Schema.decodeUnknownSync(CreateAdmissionPeriodRequest, exact)(createCommand.body),
    ).toStrictEqual({ semesterId, startAt: OPEN_START, endAt: OPEN_END });

    const createIdempotencyKey = createCommand.idempotencyKey;

    if (createIdempotencyKey === null) throw new Error("browser create carried no Idempotency-Key");

    const sessions = {
      leader: await api.signIn(personas.leader),
      foreignLeader: await api.signIn(personas.foreignLeader),
      globalAdministrator: await api.signIn(personas.globalAdministrator),
      inactiveLeader: await api.signIn(personas.inactiveLeader),
      member: await api.signIn(personas.member),
    };

    const leaderPage = await api.readManagementPage(sessions.leader);
    expect(leaderPage.items).toHaveLength(1);
    expect(leaderPage.items[0]).toMatchObject({
      id: admissionPeriodId,
      departmentId: reference.departmentId,
      semesterId,
      startAt: OPEN_START,
      endAt: OPEN_END,
      revision: 0,
    });
    const foreignPage = await api.readManagementPage(sessions.foreignLeader);
    expect(foreignPage.items).toEqual([]);
    const globalPage = await api.readManagementPage(sessions.globalAdministrator);
    expect(globalPage.items.map((period) => period.id)).toEqual([admissionPeriodId]);
    const openBeforeClose = await api.readOpenPage();
    expect(openBeforeClose.items.map((period) => period.id)).toContain(admissionPeriodId);

    const unauthenticatedError = await expectProblem(
      await api.request("GET", "/api/admission-periods"),
      SessionUnauthorizedProblem,
      "credential.missing",
    );

    const inactiveError = await expectProblem(
      await api.request("GET", "/api/admission-periods", { session: sessions.inactiveLeader }),
      AdmissionsListAdmissionPeriodsProblem,
      "authority.denied",
    );

    const roleDeniedError = await expectProblem(
      await api.request("GET", "/api/admission-periods", { session: sessions.member }),
      AdmissionsListAdmissionPeriodsProblem,
      "authority.denied",
    );

    const originalCreate = createCommand.body;

    const replayResponse = await api.request("POST", "/api/admission-periods", {
      session: sessions.leader,
      idempotencyKey: createIdempotencyKey,
      body: originalCreate,
    });

    expect(replayResponse.status).toBe(201);

    const replay = Schema.decodeUnknownSync(AdmissionPeriodManagementItem, exact)(
      await replayResponse.json(),
    );

    expect(replay.id).toBe(admissionPeriodId);

    const replayConflict = await expectProblem(
      await api.request("POST", "/api/admission-periods", {
        session: sessions.leader,
        idempotencyKey: createIdempotencyKey,
        body: { semesterId, startAt: OPEN_START, endAt: CONFLICTING_END },
      }),
      AdmissionsCreateAdmissionPeriodProblem,
      "idempotency.digest-conflict",
    );

    const duplicate = await expectProblem(
      await api.request("POST", "/api/admission-periods", {
        session: sessions.leader,
        idempotencyKey: "admission-e2e-duplicate",
        body: originalCreate,
      }),
      AdmissionsCreateAdmissionPeriodProblem,
      "admission-period.already-exists",
    );

    const invalidWindow = await expectProblem(
      await api.request("POST", "/api/admission-periods", {
        session: sessions.leader,
        idempotencyKey: "admission-e2e-invalid-window",
        body: { semesterId, startAt: OPEN_END, endAt: OPEN_START },
      }),
      AdmissionsCreateAdmissionPeriodProblem,
      "admission-period.invalid-window",
    );

    const crossScope = await expectProblem(
      await api.request("POST", "/api/admission-periods", {
        session: sessions.leader,
        idempotencyKey: "admission-e2e-cross-scope",
        body: {
          semesterId,
          startAt: OPEN_START,
          endAt: OPEN_END,
          departmentId: reference.foreignDepartmentId,
        },
      }),
      AdmissionsCreateAdmissionPeriodProblem,
      "authority.denied",
    );

    const malformed = await expectProblem(
      await api.request("POST", "/api/admission-periods", {
        session: sessions.leader,
        idempotencyKey: "admission-e2e-malformed",
        body: { semesterId, startAt: OPEN_START, endAt: OPEN_END, browserAuthority: true },
      }),
      AdmissionsCreateAdmissionPeriodProblem,
      "validation.failed",
    );

    const applicationIdempotencyKey = "admission-e2e-application-before-close";

    const applicationResponse = await api.request("POST", "/api/applications", {
      idempotencyKey: applicationIdempotencyKey,
      body: {
        departmentId: reference.departmentId,
        firstName: "Admission Proof",
        lastName: "Applicant",
        phone: "+47 900 00 038",
        email: "admission-proof-before-close@example.invalid",
        gender: 0,
        fieldOfStudyId: reference.fieldOfStudyId,
        yearOfStudy: 3,
      },
    });

    expect(applicationResponse.status).toBe(201);

    const applicationSubmission = Schema.decodeUnknownSync(
      PublicApplicationConfirmationSchema,
      exact,
    )(await applicationResponse.json());

    const initialEtag = leaderPage.items[0]?.etag;

    if (initialEtag === undefined) throw new Error("the leader's period carried no entity tag");

    const concurrentRequests = CONCURRENT_ENDS.map((endAt, index) => ({
      idempotencyKey: `admission-e2e-concurrent-${index === 0 ? "a" : "b"}`,
      payload: { startAt: OPEN_START, endAt },
    }));

    const concurrentResponses = await Promise.all(
      concurrentRequests.map(({ idempotencyKey, payload }) =>
        api.request("PATCH", periodPath, {
          session: sessions.leader,
          idempotencyKey,
          ifMatch: initialEtag,
          contentType: "application/merge-patch+json",
          body: payload,
        }),
      ),
    );

    const winnerIndexes = concurrentResponses
      .map((response, index) => (response.ok ? index : -1))
      .filter((index) => index >= 0);

    expect(winnerIndexes).toHaveLength(1);
    const winnerIndex = winnerIndexes[0] ?? 0;
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerResponse = concurrentResponses[winnerIndex];
    const loserResponse = concurrentResponses[loserIndex];
    const winnerRequest = concurrentRequests[winnerIndex];

    if (winnerResponse === undefined || loserResponse === undefined || winnerRequest === undefined) {
      throw new Error("concurrent revisions did not both complete");
    }

    const winner = Schema.decodeUnknownSync(AdmissionPeriodManagementItem, exact)(
      await winnerResponse.json(),
    );

    expect(winner.revision).toBe(1);

    const concurrentLoser = await expectProblem(
      loserResponse,
      AdmissionsReviseAdmissionPeriodProblem,
      "precondition.failed",
    );

    await page.reload();

    const revisedRow = page.locator(
      `tr[data-admission-period-id=${JSON.stringify(admissionPeriodId)}]`,
    );

    await expect(revisedRow).toHaveAttribute("data-revision", "1");
    await openRevisionPanel(revisedRow);
    const revisionPanel = page.locator("tr[data-admission-period-revision-panel]");
    const revisionEnd = revisionPanel.getByLabel("Slutter (UTC)", { exact: false });
    await revisionEnd.fill(OUTSIDE_SEMESTER_END_INPUT);
    await revisionPanel.getByRole("button", { name: "Lagre ny versjon" }).click();
    const outsideSemesterError = page.locator('[data-error-tag="InvalidAdmissionPeriodWindow"]');
    await expect(outsideSemesterError).toBeVisible();
    await expect(outsideSemesterError).toHaveAttribute("data-error-field", "endAt");
    await expect(revisionEnd).toHaveValue(OUTSIDE_SEMESTER_END_INPUT);
    await expect(revisionPanel.locator('input[name="expectedRevision"]')).toHaveCount(0);

    await revisionEnd.fill(CLOSED_END_INPUT);
    await revisionPanel.getByRole("button", { name: "Lagre ny versjon" }).click();

    const closedRow = page.locator(
      `tr[data-admission-period-id=${JSON.stringify(admissionPeriodId)}]`,
    );

    await expect(closedRow).toHaveAttribute("data-revision", "2");
    await expect(closedRow.locator(`time[datetime="${CLOSED_END}"]`)).toBeVisible();

    // The backend, not the form, rejected the window outside the semester; the corrected
    // revision reuses that command's key and revises the version that the browser displayed.
    const revisionCommands = (await readLedger(ledgerPath)).filter(
      ({ method, path }) => method === "PATCH" && path === periodPath,
    );

    const outsideSemesterProblem = "admission-period.invalid-window";

    expect(revisionCommands.map(({ status, problemCode }) => [status, problemCode])).toEqual([
      [NativeProblemRegistry[outsideSemesterProblem].status, outsideSemesterProblem],
      [200, null],
    ]);
    const [outsideSemesterCommand, closeCommand] = revisionCommands;

    if (outsideSemesterCommand === undefined || closeCommand === undefined) {
      throw new Error("browser revisions were not observed");
    }

    expect(
      Schema.decodeUnknownSync(AdmissionPeriodMergePatch, exact)(outsideSemesterCommand.body),
    ).toStrictEqual({ startAt: OPEN_START, endAt: OUTSIDE_SEMESTER_END });
    expect(
      Schema.decodeUnknownSync(AdmissionPeriodMergePatch, exact)(closeCommand.body),
    ).toStrictEqual({ startAt: OPEN_START, endAt: CLOSED_END });
    expect(outsideSemesterCommand.ifMatch).toBe(winner.etag);
    expect(closeCommand.ifMatch).toBe(winner.etag);
    expect(closeCommand.idempotencyKey).toBe(outsideSemesterCommand.idempotencyKey);

    const closeIdempotencyKey = closeCommand.idempotencyKey;

    if (closeIdempotencyKey === null) throw new Error("browser close carried no Idempotency-Key");

    const stale = await expectProblem(
      await api.request("PATCH", periodPath, {
        session: sessions.leader,
        idempotencyKey: "admission-e2e-stale-after-close",
        ifMatch: initialEtag,
        contentType: "application/merge-patch+json",
        body: { startAt: OPEN_START, endAt: CLOSED_END },
      }),
      AdmissionsReviseAdmissionPeriodProblem,
      "precondition.failed",
    );

    const openAfterClose = await api.readOpenPage();
    expect(openAfterClose.items).toEqual([]);

    const rejectedApplication = await expectProblem(
      await api.request("POST", "/api/applications", {
        idempotencyKey: "admission-e2e-application-after-close",
        body: {
          departmentId: reference.departmentId,
          firstName: "Closed Period",
          lastName: "Applicant",
          phone: "+47 900 00 138",
          email: "admission-proof-after-close@example.invalid",
          gender: 1,
          fieldOfStudyId: reference.fieldOfStudyId,
          yearOfStudy: 2,
        },
      }),
      AdmissionsSubmitApplicationProblem,
      "application.no-eligible-period",
    );

    const invalidBrowserContext = await browser.newContext({ baseURL: dashboardOrigin });

    try {
      await invalidBrowserContext.addCookies([
        {
          name: "better-auth.session_token",
          value: "invalid-admission-session",
          url: dashboardOrigin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const invalidPage = await invalidBrowserContext.newPage();
      await invalidPage.goto(pagePath);
      await expect(invalidPage).toHaveURL(`${dashboardOrigin}${mount}login?expired=true`);
      await expect(
        invalidPage.getByText("Økten din har utløpt. Vennligst logg inn på nytt."),
      ).toBeVisible();
      expect((await invalidBrowserContext.cookies()).map(({ name }) => name)).not.toContain(
        "better-auth.session_token",
      );
    } finally {
      await invalidBrowserContext.close();
    }

    await writeFile(
      evidencePath,
      `${JSON.stringify({
        fixedClock: DateTime.formatIso(reference.fixedNow),
        departmentScope: {
          leaderItems: leaderPage.items.length,
          foreignLeaderItems: foreignPage.items.length,
          globalItems: globalPage.items.length,
        },
        period: {
          id: admissionPeriodId,
          createIdempotencyKey,
          concurrentWinnerIdempotencyKey: winnerRequest.idempotencyKey,
          closeIdempotencyKey,
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
          winnerIdempotencyKey: winnerRequest.idempotencyKey,
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
