import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";
import {
  AdmissionPeriodId,
  AdmissionPeriodMergePatch,
  CreateAdmissionPeriodRequest,
  SubmitApplicationRequest,
} from "@vektorprogrammet/rpc";
import {
  IdempotencyKey,
  type NativeProblemCode,
  NativeProblemRegistry,
  type StrongETag,
} from "@vektorprogrammet/rpc/problem";
import { makeScriptClient, type ScriptCallResult } from "@vektorprogrammet/rpc/script";
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

/** Tuesday does not suit; four weeks in either block, at a Norwegian school. */
const APPLICANT_AVAILABILITY: SubmitApplicationRequest["availability"] = {
  mondayUnavailable: false,
  tuesdayUnavailable: true,
  wednesdayUnavailable: false,
  thursdayUnavailable: false,
  fridayUnavailable: false,
  positionWeeks: 4,
  preferredGroup: "all",
  language: "Norsk",
};

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
    .map((line) => Schema.decodeSync(LedgerRecord)(line));

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

/** A declared problem: the registry owns each code's status. */
function expectProblem<A>(answer: ScriptCallResult<A>, expectedCode: NativeProblemCode) {
  const status = NativeProblemRegistry[expectedCode].status;

  expect(answer).toMatchObject({ ok: false, status, code: expectedCode });

  return { status, code: expectedCode };
}

/** The value of a successful call. */
function expectValue<A>(answer: ScriptCallResult<A>): A {
  if (!answer.ok) throw new Error(`The call failed with ${answer.code}`);

  return answer.value;
}

const nativeApi = (backendOrigin: string, dashboardOrigin: string) => {
  const native = makeScriptClient(backendOrigin);

  /** The headers of one call: the person's session, sent from the dashboard origin. */
  const as = (session?: string): Readonly<Record<string, string>> =>
    session === undefined ? {} : { cookie: session, origin: dashboardOrigin };

  const key = (value: string) => IdempotencyKey.make(value);

  return {
    dispose: () => native.dispose(),
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
    listManagementPage: (session?: string) =>
      native.call(as(session), (client) => client["admissions.listAdmissionPeriods"]()),
    readManagementPage: async (session: string) =>
      expectValue(
        await native.call(as(session), (client) => client["admissions.listAdmissionPeriods"]()),
      ),
    readOpenPage: async () =>
      expectValue(
        await native.call({}, (client) => client["admissions.listOpenAdmissionPeriods"]()),
      ),
    create: (session: string, idempotencyKey: string, request: CreateAdmissionPeriodRequest) =>
      native.call(as(session), (client) =>
        client["admissions.createAdmissionPeriod"]({ idempotencyKey: key(idempotencyKey), request }),
      ),
    revise: (
      session: string,
      admissionPeriodId: string,
      idempotencyKey: string,
      ifMatch: StrongETag,
      request: AdmissionPeriodMergePatch,
    ) =>
      native.call(as(session), (client) =>
        client["admissions.reviseAdmissionPeriod"]({
          admissionPeriodId: AdmissionPeriodId.make(admissionPeriodId),
          idempotencyKey: key(idempotencyKey),
          ifMatch,
          request,
        }),
      ),
    submit: (idempotencyKey: string, request: SubmitApplicationRequest) =>
      native.call({}, (client) =>
        client["admissions.submitApplication"]({ idempotencyKey: key(idempotencyKey), request }),
      ),
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

    const reference = Schema.decodeSync(JourneyReference)(
      requiredEnvironment("ADMISSION_E2E_REFERENCE"),
    );

    const personas = Schema.decodeSync(JourneyPersonas)(
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

    const accessibility = await new AxeBuilder({ page })
      .include('section[aria-labelledby="admission-period-page-title"]')
      .analyze();

    expect(accessibility.violations).toEqual([]);

    // The form's own window check rejected the first attempt before any command left the
    // dashboard; the corrected attempt reuses that attempt's key and sends it only as a header.
    const createCommands = (await readLedger(ledgerPath)).filter(
      ({ method, path }) => method === "RPC" && path === "admissions.createAdmissionPeriod",
    );

    expect(createCommands).toHaveLength(1);
    const [createCommand] = createCommands;

    if (createCommand === undefined) throw new Error("browser create request was not observed");
    expect(createCommand.status).toBe(200);
    expect(createCommand.idempotencyKey).toBe(rejectedCreateKey);
    expect(
      Schema.decodeUnknownSync(CreateAdmissionPeriodRequest, exact)(createCommand.body),
    ).toStrictEqual({ semesterId, startAt: OPEN_START, endAt: OPEN_END });

    const createIdempotencyKey = createCommand.idempotencyKey;

    if (createIdempotencyKey === null) throw new Error("browser create carried no idempotency key");

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

    const unauthenticatedError = expectProblem(
      await api.listManagementPage(),
      "credential.missing",
    );

    const inactiveError = expectProblem(
      await api.listManagementPage(sessions.inactiveLeader),
      "authority.denied",
    );

    const roleDeniedError = expectProblem(
      await api.listManagementPage(sessions.member),
      "authority.denied",
    );

    const originalCreate = Schema.decodeUnknownSync(CreateAdmissionPeriodRequest, exact)(
      createCommand.body,
    );

    const replay = expectValue(
      await api.create(sessions.leader, createIdempotencyKey, originalCreate),
    );

    expect(replay.id).toBe(admissionPeriodId);

    const replayConflict = expectProblem(
      await api.create(sessions.leader, createIdempotencyKey, {
        ...originalCreate,
        endAt: CONFLICTING_END,
      }),
      "idempotency.digest-conflict",
    );

    const duplicate = expectProblem(
      await api.create(sessions.leader, "admission-e2e-duplicate", originalCreate),
      "admission-period.already-exists",
    );

    const invalidWindow = expectProblem(
      await api.create(sessions.leader, "admission-e2e-invalid-window", {
        ...originalCreate,
        startAt: OPEN_END,
        endAt: OPEN_START,
      }),
      "admission-period.invalid-window",
    );

    const crossScope = expectProblem(
      await api.create(
        sessions.leader,
        "admission-e2e-cross-scope",
        Schema.decodeSync(CreateAdmissionPeriodRequest, exact)({
          semesterId,
          startAt: OPEN_START,
          endAt: OPEN_END,
          departmentId: reference.foreignDepartmentId,
        }),
      ),
      "authority.denied",
    );

    // The payload schema drops a member that it does not declare, so a browser-supplied authority
    // grants nothing: the create is the leader's own, of a period that already exists.
    const withBrowserAuthority = { ...originalCreate, browserAuthority: true };

    const excessMember = expectProblem(
      await api.create(sessions.leader, "admission-e2e-excess-member", withBrowserAuthority),
      "admission-period.already-exists",
    );

    const applicationIdempotencyKey = "admission-e2e-application-before-close";

    const applicationSubmission = expectValue(
      await api.submit(
        applicationIdempotencyKey,
        Schema.decodeSync(SubmitApplicationRequest, exact)({
          departmentId: reference.departmentId,
          firstName: "Admission Proof",
          lastName: "Applicant",
          phone: "+47 900 00 038",
          email: "admission-proof-before-close@example.invalid",
          gender: 0,
          fieldOfStudyId: reference.fieldOfStudyId,
          yearOfStudy: 3,
          availability: APPLICANT_AVAILABILITY,
        }),
      ),
    );

    const initialEtag = leaderPage.items[0]?.etag;

    if (initialEtag === undefined) throw new Error("the leader's period carried no entity tag");

    const concurrentRequests = CONCURRENT_ENDS.map((endAt, index) => ({
      idempotencyKey: `admission-e2e-concurrent-${index === 0 ? "a" : "b"}`,
      payload: { startAt: OPEN_START, endAt },
    }));

    const concurrentAnswers = await Promise.all(
      concurrentRequests.map(({ idempotencyKey, payload }) =>
        api.revise(sessions.leader, admissionPeriodId, idempotencyKey, initialEtag, payload),
      ),
    );

    const winnerIndexes = concurrentAnswers
      .map((answer, index) => (answer.ok ? index : -1))
      .filter((index) => index >= 0);

    expect(winnerIndexes).toHaveLength(1);
    const winnerIndex = winnerIndexes[0] ?? 0;
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerAnswer = concurrentAnswers[winnerIndex];
    const loserAnswer = concurrentAnswers[loserIndex];
    const winnerRequest = concurrentRequests[winnerIndex];

    if (winnerAnswer === undefined || loserAnswer === undefined || winnerRequest === undefined) {
      throw new Error("concurrent revisions did not both complete");
    }

    const winner = expectValue(winnerAnswer);

    expect(winner.revision).toBe(1);

    const concurrentLoser = expectProblem(loserAnswer, "precondition.failed");

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
      ({ method, path }) => method === "RPC" && path === "admissions.reviseAdmissionPeriod",
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

    if (closeIdempotencyKey === null) throw new Error("browser close carried no idempotency key");

    const stale = expectProblem(
      await api.revise(
        sessions.leader,
        admissionPeriodId,
        "admission-e2e-stale-after-close",
        initialEtag,
        { startAt: OPEN_START, endAt: CLOSED_END },
      ),
      "precondition.failed",
    );

    const openAfterClose = await api.readOpenPage();
    expect(openAfterClose.items).toEqual([]);

    const rejectedApplication = expectProblem(
      await api.submit(
        "admission-e2e-application-after-close",
        Schema.decodeSync(SubmitApplicationRequest, exact)({
          departmentId: reference.departmentId,
          firstName: "Closed Period",
          lastName: "Applicant",
          phone: "+47 900 00 138",
          email: "admission-proof-after-close@example.invalid",
          gender: 1,
          fieldOfStudyId: reference.fieldOfStudyId,
          yearOfStudy: 2,
          availability: APPLICANT_AVAILABILITY,
        }),
      ),
      "application.no-eligible-period",
    );

    await api.dispose();

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
          excessMember,
          stale,
          rejectedApplication,
        },
      })}\n`,
      "utf8",
    );
  });
});
