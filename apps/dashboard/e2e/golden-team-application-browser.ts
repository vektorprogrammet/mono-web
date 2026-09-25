/**
 * Golden team-application browser journey.
 *
 * One continuous Chromium session drives the public team page, the anonymous
 * form, the confirmation, the staff list and detail, intake settings, and
 * deletion. HTTP probes cover exact replay, denial, and stale preconditions.
 * The runner owns processes, PostgreSQL observations, and the loopback
 * notification provider; this module reaches them only through `hooks`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect as baseExpect, type BrowserContext, type Page } from "@playwright/test";
import { OrganizationLifecycleCommand } from "@vektorprogrammet/http-api";
import { Schema } from "effect";

// Production bundles load their workflow before rendering server facts; five seconds is too tight.
const expect = baseExpect.configure({ timeout: 15_000 });

/** Ordered checkpoints and the frozen journey items each binds. */
export const teamApplicationCheckpoints = [
  { step: "initial", items: [2] },
  { step: "intake-opened", items: [1, 2, 18, 19, 20] },
  { step: "submitted", items: [3, 6, 9, 10, 11, 13] },
  { step: "submission-replay", items: [7] },
  { step: "second-submission", items: [8, 12] },
  { step: "rejected-submissions", items: [4, 5] },
  { step: "staff-reads", items: [14] },
  { step: "staff-denials", items: [15] },
  { step: "session-revocation", items: [15, 21] },
  { step: "delete-denied", items: [17] },
  { step: "intake-revised", items: [18, 20] },
  { step: "intake-stale", items: [19] },
  { step: "intake-closed", items: [1, 2, 5, 18] },
  { step: "deleted", items: [16, 20] },
  { step: "fallback-failed-delivery", items: [9, 10, 11, 12] },
  { step: "unattended-recovery", items: [11, 12] },
] as const;

export type TeamApplicationStep = (typeof teamApplicationCheckpoints)[number]["step"];

export type StaffRole =
  | "leaderAlfa"
  | "memberAlfa"
  | "sessionAlfa"
  | "suspendedAlfa"
  | "formerAlfa"
  | "leaderBeta"
  | "memberBeta";

export interface FixturePerson {
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly password: string;
  readonly membershipId: string;
}

export interface FixtureTeam {
  readonly teamId: string;
  readonly name: string;
  readonly email: string | null;
}

export interface ApplicantInput {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly yearOfStudy: string;
  readonly fieldOfStudy: string;
  readonly biography: string;
  readonly motivation: string;
}

export interface TeamApplicationFixture {
  readonly departmentSlug: string;
  readonly departmentEmail: string;
  readonly alfa: FixtureTeam;
  readonly beta: FixtureTeam;
  readonly gamma: FixtureTeam;
  readonly inactive: FixtureTeam;
  readonly unknownTeamId: string;
  readonly persons: Readonly<Record<StaffRole, FixturePerson>>;
  readonly first: ApplicantInput;
  readonly second: ApplicantInput;
  readonly fallback: ApplicantInput;
}

export type SubmissionLabel = "first" | "second" | "fallback";

export interface Submission {
  readonly label: SubmissionLabel;
  readonly teamId: string;
  readonly applicationId: string;
  /** Idempotency key rendered into the form and sent verbatim to the backend. */
  readonly key: string;
  readonly input: ApplicantInput;
}

/** What the browser did so far; the runner binds each checkpoint to it. */
export interface JourneyRecord {
  readonly submissions: ReadonlyArray<Submission>;
  readonly deletions: ReadonlyArray<{ readonly applicationId: string; readonly key: string }>;
  /** Backend-normalized UTC deadlines set through the dashboard and the concurrent client. */
  readonly deadlines: { readonly first: string | null; readonly second: string | null };
  readonly suspendedMembershipId: string | null;
}

export interface TeamApplicationBrowserHooks {
  readonly checkpoint: (step: TeamApplicationStep, record: JourneyRecord) => Promise<void>;
  /** Resolves when every notification of the application has this delivery status. */
  readonly awaitNotifications: (applicationId: string, status: "Delivered" | "Failed") => Promise<void>;
  readonly setProviderMode: (mode: "accept" | "fail") => Promise<void>;
  /** Replaces the backend process and waits until its worker retries retained work. */
  readonly restartBackend: () => Promise<void>;
  readonly faultPoint: (point: "after-submitted") => Promise<void>;
}

export interface TeamApplicationBrowserInput {
  readonly origins: {
    readonly backend: string;
    readonly dashboard: string;
    /** Browser-facing homepage origin on the mapped local host name. */
    readonly homepage: string;
  };
  readonly homepageHost: string;
  readonly chromiumExecutable: string;
  readonly artifacts: string;
  readonly signal: AbortSignal;
  readonly fixture: TeamApplicationFixture;
  readonly hooks: TeamApplicationBrowserHooks;
}

export type BrowserCheck = {
  readonly kind: string;
  readonly detail: string;
};

/** Merge-patch body of one intake revision; an absent key keeps the stored value. */
type IntakePatch = {
  readonly acceptApplication?: boolean;
  readonly deadline?: string | null;
};

const Problem = Schema.Struct({ code: Schema.String });

const Session = Schema.Struct({ personId: Schema.String });

const Confirmation = Schema.Struct({
  applicationId: Schema.String,
  teamId: Schema.String,
  submittedAt: Schema.String,
});

const Intake = Schema.Struct({
  acceptApplication: Schema.Boolean,
  deadline: Schema.NullOr(Schema.String),
  revision: Schema.Int,
  open: Schema.Boolean,
  etag: Schema.String,
});

const ApplicationList = Schema.Struct({
  teamId: Schema.String,
  items: Schema.Array(
    Schema.Struct({ applicationId: Schema.String, name: Schema.String, submittedAt: Schema.String }),
  ),
  intake: Intake,
  canManage: Schema.Boolean,
});

const ApplicationDetail = Schema.Struct({
  applicationId: Schema.String,
  teamId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  yearOfStudy: Schema.String,
  fieldOfStudy: Schema.String,
  biography: Schema.String,
  motivation: Schema.String,
  canManage: Schema.Boolean,
});

const LifecycleResult = Schema.Struct({ subjectId: Schema.String, revision: Schema.Int });

const Replays = Schema.Array(Schema.Struct({ status: Schema.Int, text: Schema.String }));

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// A confirmation may say the application was received; it must not claim that mail left.
const deliveryClaim = /sendt|levert|bekreftelse på e-post|e-post er på vei/iu;

const osloMinute = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `datetime-local` value of one instant on the Oslo wall clock. */
const osloInputValue = (instant: string) => osloMinute.format(new Date(instant)).replace(" ", "T");

interface Actor {
  readonly role: StaffRole;
  readonly person: FixturePerson;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cookie: string;
}

export const runTeamApplicationBrowser = async (
  input: TeamApplicationBrowserInput,
): Promise<ReadonlyArray<BrowserCheck>> => {
  const { origins, fixture, hooks, signal } = input;
  const checks: Array<BrowserCheck> = [];
  const submissions: Array<Submission> = [];
  const deletions: Array<{ readonly applicationId: string; readonly key: string }> = [];
  let firstDeadline: string | null = null;
  let secondDeadline: string | null = null;
  let suspendedMembershipId: string | null = null;

  const browser = await chromium.launch({
    headless: true,
    executablePath: input.chromiumExecutable,
    args: [`--host-resolver-rules=MAP ${input.homepageHost} 127.0.0.1`],
    // The runner owns signals; it aborts `signal`, which closes this browser.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  const abort = () => void browser.close().catch(() => undefined);

  signal.addEventListener("abort", abort, { once: true });

  const checkpoint = (step: TeamApplicationStep) =>
    hooks.checkpoint(step, {
      submissions: [...submissions],
      deletions: [...deletions],
      deadlines: { first: firstDeadline, second: secondDeadline },
      suspendedMembershipId,
    });

  const poll = async (label: string, ready: () => Promise<boolean>) => {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      if (await ready()) return;
      await sleep(100, undefined, { signal });
    }

    throw new Error(`Timed out: ${label}`);
  };

  const pageErrors: Array<string> = [];

  const newContext = async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "nb-NO",
      timezoneId: "Europe/Oslo",
    });

    context.on("weberror", (error) => void pageErrors.push(`pageerror: ${error.error().message}`));
    context.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(`console: ${message.text()}`.slice(0, 600));
    });

    return context;
  };

  const api = (cookie: string | null, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);

    // Person requests carry the trusted dashboard origin; anonymous ones carry neither.
    if (cookie !== null) {
      headers.set("cookie", cookie);
      headers.set("origin", origins.dashboard);
    }

    return fetch(origins.backend + path, {
      ...init,
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
  };

  const body = async <A>(response: Response, status: number, decoder: Schema.Decoder<A>) => {
    const text = await response.text();

    assert.equal(response.status, status, `${response.url} returned ${response.status}: ${text}`);

    return Schema.decodeSync(Schema.fromJsonString(decoder))(text);
  };

  const problem = async (response: Response, status: number, codes: ReadonlyArray<string>) => {
    const { code } = await body(response, status, Problem);

    assert.ok(codes.includes(code), `${response.url} problem ${code}, expected ${codes.join(" or ")}`);
    checks.push({ kind: "problem", detail: `${status} ${code}` });
  };

  const inspect = async (page: Page, surface: string) => {
    for (const [layout, width] of [
      ["desktop", 1280],
      ["narrow", 390],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: join(input.artifacts, `${surface}-${layout}.png`), fullPage: true });

      const overflowing = String(
        await page.evaluate(
          "(() => document.documentElement.scrollWidth <= innerWidth + 1 ? '' : [...document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map((element) => element.tagName.toLowerCase() + ' ' + String(element.className).slice(0, 80)).join(' | '))()",
        ),
      );

      assert.equal(overflowing, "", `${surface} overflows at ${width}px`);

      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

      const serious = audit.violations.flatMap(({ id, impact, nodes }) =>
        impact === "serious" || impact === "critical"
          ? [`${id}: ${nodes.map(({ target, html }) => `${target.join(" ")} ${html.slice(0, 160)}`).join(" | ")}`]
          : [],
      );

      assert.deepEqual(serious, [], `${surface} accessibility at ${width}px`);
      checks.push({ kind: "surface", detail: `${surface} ${layout} axe-clean` });
    }

    await page.setViewportSize({ width: 1280, height: 900 });
  };

  const login = async (role: StaffRole): Promise<Actor> => {
    const person = fixture.persons[role];
    const context = await newContext();
    const page = await context.newPage();

    page.setDefaultTimeout(15_000);
    await page.goto(`${origins.dashboard}/dashboard/login`);
    await page.getByLabel("E-post").fill(person.email);
    await page.getByLabel("Passord", { exact: true }).fill(person.password);
    await page.getByRole("button", { name: "Logg inn", exact: true }).press("Enter");
    await page.waitForURL((url) => /^\/dashboard\/?$/u.test(url.pathname));

    const cookies = (await context.cookies()).filter(({ name }) =>
      name.endsWith("better-auth.session_token"),
    );

    assert.equal(cookies.length, 1, `${role} session cookie`);

    const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const session = await body(await api(cookie, "/api/session"), 200, Session);

    assert.equal(session.personId, person.personId);
    checks.push({ kind: "session", detail: role });

    return { role, person, context, page, cookie };
  };

  const listApplications = async (actor: Actor, team: FixtureTeam) =>
    body(
      await api(actor.cookie, `/api/teams/${encodeURIComponent(team.teamId)}/applications`),
      200,
      ApplicationList,
    );

  const awaitRevision = (actor: Actor, team: FixtureTeam, revision: number) =>
    poll(`${team.name} intake revision ${revision}`, async () => {
      const list = await listApplications(actor, team);

      return list.intake.revision === revision;
    });

  const openTeamPage = async (actor: Actor, team: FixtureTeam) => {
    await actor.page.goto(`${origins.dashboard}/dashboard/teamsoknader`);
    await expect(actor.page.getByRole("heading", { level: 1, name: "Team-søknader" })).toBeVisible();
    await actor.page.getByRole("link", { name: `Søknader til ${team.name}`, exact: true }).click();
    await actor.page.waitForURL(
      (url) => url.pathname === `/dashboard/teamsoknader/${encodeURIComponent(team.teamId)}`,
    );
    await expect(
      actor.page.getByRole("heading", { level: 1, name: `Søknader til ${team.name}` }),
    ).toBeVisible();
  };

  const intakeControls = (actor: Actor) =>
    actor.page.getByRole("group", { name: "Endre søknadsinntak", exact: true });

  const saveIntake = async (actor: Actor, team: FixtureTeam, revision: number) => {
    await intakeControls(actor).getByRole("button", { name: "Lagre inntak", exact: true }).click();
    await awaitRevision(actor, team, revision);
    await expect(actor.page.locator('[data-team-application-notice="intake-saved"]')).toBeVisible();
  };

  const reviseIntake = (actor: Actor, team: FixtureTeam, etag: string | null, patch: IntakePatch) => {
    const headers = new Headers({
      "content-type": "application/merge-patch+json",
      "idempotency-key": randomUUID(),
    });

    if (etag !== null) headers.set("if-match", etag);

    return api(actor.cookie, `/api/teams/${encodeURIComponent(team.teamId)}/application-intake`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    });
  };

  const expectApplyLinks = async (
    page: Page,
    open: ReadonlyArray<FixtureTeam>,
    closed: ReadonlyArray<FixtureTeam>,
  ) => {
    await page.goto(`${origins.homepage}/team/${fixture.departmentSlug}`);

    for (const team of [...open, ...closed])
      await expect(page.getByText(team.name, { exact: true }).first()).toBeVisible();

    for (const team of open) {
      const link = page.getByRole("link", { name: `Søk på ${team.name}`, exact: true });

      await expect(link).toHaveCount(1);
      assert.equal(await link.getAttribute("href"), `/team/${encodeURIComponent(team.teamId)}/soknad`);
    }

    for (const team of closed)
      await expect(page.getByRole("link", { name: `Søk på ${team.name}`, exact: true })).toHaveCount(0);
    checks.push({
      kind: "public-links",
      detail: `open ${open.map(({ name }) => name).join(",")}; closed ${closed.map(({ name }) => name).join(",")}`,
    });
  };

  const fillApplication = async (page: Page, applicant: ApplicantInput) => {
    await page.getByLabel("Navn", { exact: true }).fill(applicant.name);
    await page.getByLabel("E-post", { exact: true }).fill(applicant.email);
    await page.getByLabel("Telefon", { exact: true }).fill(applicant.phone);
    await page.getByLabel("Årstrinn", { exact: true }).selectOption(applicant.yearOfStudy);
    await page.getByLabel("Linje", { exact: true }).fill(applicant.fieldOfStudy);
    await page.getByLabel("Skriv litt om deg selv", { exact: true }).fill(applicant.biography);
    await page
      .getByLabel("Skriv kort om din motivasjon for vervet", { exact: true })
      .fill(applicant.motivation);
  };

  /** Submits through the public form; returns the recorded submission and the exact request. */
  const submit = async (
    page: Page,
    team: FixtureTeam,
    applicant: ApplicantInput,
    label: SubmissionLabel,
    inspectSurfaces: boolean,
  ) => {
    await expect(page.getByRole("heading", { level: 1, name: `Søk på ${team.name}` })).toBeVisible();

    const key = await page.locator('input[name="commandId"]').inputValue();

    assert.ok(key.length > 0, "form renders an idempotency key");

    if (inspectSurfaces) await inspect(page, "application-form");

    await fillApplication(page, applicant);

    const posted = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.startsWith(`/team/${encodeURIComponent(team.teamId)}/soknad`),
    );

    await page.getByRole("button", { name: "Send søknad", exact: true }).click();

    const request = await posted;

    await expect(page.getByRole("heading", { name: "Søknaden er mottatt" })).toBeVisible();

    const confirmation = page.locator("[data-team-application-confirmation]");
    const applicationId = (await confirmation.getAttribute("data-team-application-confirmation")) ?? "";

    assert.match(applicationId, uuidV4);
    assert.ok(!deliveryClaim.test(await confirmation.innerText()), "confirmation claims delivery");

    if (inspectSurfaces) await inspect(page, "application-confirmation");

    const submission: Submission = { label, teamId: team.teamId, applicationId, key, input: applicant };

    submissions.push(submission);
    checks.push({ kind: "submitted", detail: `${label} ${applicationId}` });

    return {
      submission,
      request: {
        url: request.url(),
        contentType: request.headers()["content-type"] ?? "",
        body: request.postData() ?? "",
      },
    };
  };

  const submitThroughApi = (team: string, key: string, payload: Partial<ApplicantInput>) =>
    api(null, `/api/teams/${encodeURIComponent(team)}/applications`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(payload),
    });

  try {
    const visitor = await (await newContext()).newPage();

    visitor.setDefaultTimeout(15_000);

    // Fixtures create no intake settings, so every team starts closed.
    await expectApplyLinks(visitor, [], [fixture.alfa, fixture.beta, fixture.gamma]);
    await checkpoint("initial");

    const leaderAlfa = await login("leaderAlfa");

    await openTeamPage(leaderAlfa, fixture.alfa);
    await expect(leaderAlfa.page.locator('[data-intake-open="false"]')).toBeVisible();
    await intakeControls(leaderAlfa).getByRole("checkbox", { name: "Ta imot søknader" }).click();
    await saveIntake(leaderAlfa, fixture.alfa, 1);
    await expect(leaderAlfa.page.locator('[data-intake-open="true"]')).toBeVisible();
    await inspect(leaderAlfa.page, "leader-intake");

    const leaderBeta = await login("leaderBeta");

    await openTeamPage(leaderBeta, fixture.beta);
    await intakeControls(leaderBeta).getByRole("checkbox", { name: "Ta imot søknader" }).click();
    await saveIntake(leaderBeta, fixture.beta, 1);
    await expectApplyLinks(visitor, [fixture.alfa, fixture.beta], [fixture.gamma]);
    await inspect(visitor, "public-team-page");
    await checkpoint("intake-opened");

    await visitor.getByRole("link", { name: `Søk på ${fixture.alfa.name}`, exact: true }).click();

    const first = await submit(visitor, fixture.alfa, fixture.first, "first", true);

    await hooks.awaitNotifications(first.submission.applicationId, "Delivered");
    await checkpoint("submitted");
    await hooks.faultPoint("after-submitted");

    // Exact replay: the captured form request, twice concurrently, from the same browser.
    const replays = Schema.decodeSync(Replays)(
      await visitor.evaluate(
        async ({ url, contentType, payload }) => {
          const once = async () => {
            const response = await fetch(url, {
              method: "POST",
              headers: { "content-type": contentType },
              body: payload,
              credentials: "same-origin",
            });

            return { status: response.status, text: await response.text() };
          };

          return Promise.all([once(), once()]);
        },
        { url: first.request.url, contentType: first.request.contentType, payload: first.request.body },
      ),
    );

    for (const replay of replays) {
      assert.ok(replay.status < 400, `form replay returned ${replay.status}`);
      assert.ok(replay.text.includes(first.submission.applicationId), "form replay returns the original result");
    }

    const direct = await body(
      await submitThroughApi(fixture.alfa.teamId, first.submission.key, fixture.first),
      201,
      Confirmation,
    );

    assert.equal(direct.applicationId, first.submission.applicationId);
    checks.push({ kind: "replay", detail: "two form replays and one API replay returned the original result" });
    await checkpoint("submission-replay");

    await hooks.setProviderMode("fail");
    await visitor.goto(`${origins.homepage}/team/${encodeURIComponent(fixture.alfa.teamId)}/soknad`);

    const second = await submit(visitor, fixture.alfa, fixture.second, "second", false);

    assert.notEqual(second.submission.key, first.submission.key, "a new form renders a new key");
    assert.notEqual(second.submission.applicationId, first.submission.applicationId);
    await hooks.awaitNotifications(second.submission.applicationId, "Failed");
    await checkpoint("second-submission");

    await problem(await submitThroughApi(fixture.gamma.teamId, randomUUID(), fixture.first), 409, [
      "team-application.intake-closed",
    ]);
    await problem(await submitThroughApi(fixture.inactive.teamId, randomUUID(), fixture.first), 404, [
      "resource.not-found",
    ]);
    await problem(await submitThroughApi(fixture.unknownTeamId, randomUUID(), fixture.first), 404, [
      "resource.not-found",
    ]);

    for (const invalid of [
      { ...fixture.first, email: "not-an-email" },
      { ...fixture.first, fieldOfStudy: "x".repeat(46) },
      { ...fixture.first, name: "" },
      { ...fixture.first, motivation: " padded" },
    ])
      await problem(await submitThroughApi(fixture.alfa.teamId, randomUUID(), invalid), 422, [
        "validation.failed",
      ]);

    const { motivation: _omitted, ...missing } = fixture.first;

    await problem(await submitThroughApi(fixture.alfa.teamId, randomUUID(), missing), 422, [
      "validation.failed",
    ]);
    await visitor.goto(`${origins.homepage}/team/${encodeURIComponent(fixture.gamma.teamId)}/soknad`);
    await expect(visitor.getByRole("heading", { name: "Teamet tar ikke imot søknader nå" })).toBeVisible();
    await expect(visitor.locator('[data-team-application-intake="closed"]')).toBeVisible();
    await expect(visitor.getByRole("button", { name: "Send søknad" })).toHaveCount(0);

    for (const teamId of [fixture.inactive.teamId, fixture.unknownTeamId]) {
      const response = await visitor.goto(`${origins.homepage}/team/${encodeURIComponent(teamId)}/soknad`);

      assert.equal(response?.status(), 404, `${teamId} form page status`);
      await expect(visitor.getByRole("heading", { name: "Fant ikke teamet" })).toBeVisible();
    }

    checks.push({ kind: "rejections", detail: "closed, inactive, unknown, and invalid submissions rejected" });
    await checkpoint("rejected-submissions");

    const memberAlfa = await login("memberAlfa");

    await openTeamPage(memberAlfa, fixture.alfa);

    const rows = memberAlfa.page.locator("[data-application-id]");

    await expect(rows).toHaveCount(2);
    assert.deepEqual(
      await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-application-id"))),
      [second.submission.applicationId, first.submission.applicationId],
    );
    await expect(memberAlfa.page.getByRole("heading", { name: "Søknadsinntak" })).toBeVisible();
    await expect(intakeControls(memberAlfa)).toHaveCount(0);
    await inspect(memberAlfa.page, "staff-list");
    await memberAlfa.page
      .locator(`[data-application-id="${first.submission.applicationId}"]`)
      .getByRole("button", { name: `Vis søknad fra ${fixture.first.name}`, exact: true })
      .click();

    const detail = memberAlfa.page.locator(`[data-application-detail="${first.submission.applicationId}"]`);

    await expect(detail.getByRole("heading", { level: 2, name: fixture.first.name })).toBeVisible();

    for (const value of [
      fixture.first.email,
      fixture.first.phone,
      fixture.first.yearOfStudy,
      fixture.first.fieldOfStudy,
      fixture.first.biography,
      fixture.first.motivation,
    ])
      await expect(detail).toContainText(value);
    await expect(memberAlfa.page.getByRole("button", { name: "Slett søknad" })).toHaveCount(0);
    await inspect(memberAlfa.page, "staff-detail");
    await memberAlfa.page.getByRole("button", { name: "Tilbake til søknadene", exact: true }).click();
    await expect(rows).toHaveCount(2);

    const memberList = await listApplications(memberAlfa, fixture.alfa);

    assert.equal(memberList.canManage, false);
    assert.deepEqual(
      memberList.items.map(({ applicationId }) => applicationId),
      [second.submission.applicationId, first.submission.applicationId],
    );

    const memberDetail = await body(
      await api(memberAlfa.cookie, `/api/team-applications/${first.submission.applicationId}`),
      200,
      ApplicationDetail,
    );

    assert.deepEqual(
      {
        name: memberDetail.name,
        email: memberDetail.email,
        phone: memberDetail.phone,
        yearOfStudy: memberDetail.yearOfStudy,
        fieldOfStudy: memberDetail.fieldOfStudy,
        biography: memberDetail.biography,
        motivation: memberDetail.motivation,
      },
      fixture.first,
    );
    assert.equal(memberDetail.teamId, fixture.alfa.teamId);
    assert.equal(memberDetail.canManage, false);

    const sessionAlfa = await login("sessionAlfa");

    await openTeamPage(sessionAlfa, fixture.alfa);
    await expect(sessionAlfa.page.locator("[data-application-id]")).toHaveCount(2);
    checks.push({ kind: "staff-read", detail: "current members list and read the team's applications" });
    await checkpoint("staff-reads");

    for (const role of ["memberBeta", "leaderBeta", "formerAlfa", "suspendedAlfa"] as const) {
      const actor = role === "leaderBeta" ? leaderBeta : await login(role);

      await problem(
        await api(actor.cookie, `/api/teams/${fixture.alfa.teamId}/applications`),
        403,
        ["authority.denied"],
      );
      await problem(
        await api(actor.cookie, `/api/team-applications/${first.submission.applicationId}`),
        403,
        ["authority.denied"],
      );
      await actor.page.goto(`${origins.dashboard}/dashboard/teamsoknader/${fixture.alfa.teamId}`);
      await expect(actor.page.locator('[data-team-application-state="denied"]')).toBeVisible();
      await expect(actor.page.locator("[data-application-id]")).toHaveCount(0);
    }

    for (const path of [
      `/api/teams/${fixture.alfa.teamId}/applications`,
      `/api/team-applications/${first.submission.applicationId}`,
    ]) {
      const anonymous = await api(null, path);

      assert.ok(anonymous.headers.has("www-authenticate"), "anonymous denial challenges");
      await problem(anonymous, 401, ["credential.missing", "credential.invalid"]);
    }

    const anonymousPage = await (await newContext()).newPage();

    await anonymousPage.goto(`${origins.dashboard}/dashboard/teamsoknader/${fixture.alfa.teamId}`);
    await expect(
      anonymousPage
        .getByRole("button", { name: "Logg inn", exact: true })
        .or(anonymousPage.locator('[data-team-application-state="session-expired"]')),
    ).toBeVisible();
    await expect(anonymousPage.locator("[data-application-id]")).toHaveCount(0);
    await problem(await api(memberAlfa.cookie, `/api/team-applications/${randomUUID()}`), 404, [
      "resource.not-found",
    ]);
    checks.push({ kind: "staff-denial", detail: "other team, other leader, former, suspended, anonymous" });
    await checkpoint("staff-denials");

    const suspensionKey = randomUUID();

    const suspension = await body(
      await api(leaderAlfa.cookie, "/api/organization/appointments/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": suspensionKey },
        body: JSON.stringify(
          Schema.encodeSync(OrganizationLifecycleCommand)(
            OrganizationLifecycleCommand.cases.SuspendAppointment.make({
              commandId: suspensionKey,
              reason: "Golden journey: membership suspended during an open session",
              appointmentId: fixture.persons.sessionAlfa.membershipId,
              expectedRevision: 0,
            }),
          ),
        ),
      }),
      200,
      LifecycleResult,
    );

    assert.equal(suspension.subjectId, fixture.persons.sessionAlfa.membershipId);
    assert.equal(suspension.revision, 1);
    suspendedMembershipId = suspension.subjectId;

    // The same session cookie that read the list a moment ago is now refused.
    await problem(
      await api(sessionAlfa.cookie, `/api/teams/${fixture.alfa.teamId}/applications`),
      403,
      ["authority.denied"],
    );
    await problem(
      await api(sessionAlfa.cookie, `/api/team-applications/${first.submission.applicationId}`),
      403,
      ["authority.denied"],
    );
    await sessionAlfa.page.reload();
    await expect(sessionAlfa.page.locator('[data-team-application-state="denied"]')).toBeVisible();
    checks.push({ kind: "session-revocation", detail: "existing session lost access after suspension" });
    await checkpoint("session-revocation");

    for (const actor of [memberAlfa, leaderBeta])
      await problem(
        await api(actor.cookie, `/api/team-applications/${first.submission.applicationId}`, {
          method: "DELETE",
          headers: { "idempotency-key": randomUUID() },
        }),
        403,
        ["authority.denied"],
      );
    checks.push({ kind: "delete-denial", detail: "non-leader member and other-team leader refused" });
    await checkpoint("delete-denied");

    const deadlineInput = `${osloMinute.format(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10)}T12:00`;

    await openTeamPage(leaderAlfa, fixture.alfa);
    await intakeControls(leaderAlfa).getByLabel("Søknadsfrist (norsk tid)").fill(deadlineInput);
    await saveIntake(leaderAlfa, fixture.alfa, 2);

    const withDeadline = await listApplications(leaderAlfa, fixture.alfa);

    assert.ok(withDeadline.intake.deadline !== null && withDeadline.intake.open);
    assert.equal(osloInputValue(withDeadline.intake.deadline), deadlineInput, "deadline read as Oslo time");
    firstDeadline = withDeadline.intake.deadline;
    await intakeControls(leaderAlfa).getByRole("button", { name: "Fjern frist", exact: true }).click();
    await saveIntake(leaderAlfa, fixture.alfa, 3);
    assert.equal((await listApplications(leaderAlfa, fixture.alfa)).intake.deadline, null);
    await checkpoint("intake-revised");

    const observed = await listApplications(leaderAlfa, fixture.alfa);
    const secondDeadlineAt = new Date(Date.now() + 45 * 86_400_000);

    secondDeadlineAt.setUTCHours(16, 30, 0, 0);

    const concurrent = await reviseIntake(leaderAlfa, fixture.alfa, observed.intake.etag, {
      deadline: secondDeadlineAt.toISOString(),
    });

    const concurrentEtag = concurrent.headers.get("etag");
    const revised = await body(concurrent, 200, Intake);

    assert.equal(revised.revision, 4);
    assert.equal(concurrentEtag, revised.etag);
    secondDeadline = revised.deadline;

    // The page still holds revision 3; its save must fail as stale and reload.
    await intakeControls(leaderAlfa).getByRole("checkbox", { name: "Ta imot søknader" }).click();
    await intakeControls(leaderAlfa).getByRole("button", { name: "Lagre inntak", exact: true }).click();
    await expect(leaderAlfa.page.locator('[data-team-application-notice="stale"]')).toBeVisible();
    await expect(
      intakeControls(leaderAlfa).getByRole("checkbox", { name: "Ta imot søknader" }),
    ).toBeChecked();
    await expect(intakeControls(leaderAlfa).getByLabel("Søknadsfrist (norsk tid)")).toHaveValue(
      osloInputValue(revised.deadline ?? ""),
    );
    await problem(
      await reviseIntake(leaderAlfa, fixture.alfa, observed.intake.etag, { acceptApplication: false }),
      412,
      ["precondition.failed"],
    );
    await problem(await reviseIntake(leaderAlfa, fixture.alfa, null, { acceptApplication: false }), 428, [
      "precondition.required",
    ]);
    assert.equal((await listApplications(leaderAlfa, fixture.alfa)).intake.revision, 4);
    checks.push({ kind: "stale-intake", detail: "stale UI save and stale If-Match refused without change" });
    await checkpoint("intake-stale");

    await intakeControls(leaderAlfa).getByRole("checkbox", { name: "Ta imot søknader" }).click();
    await saveIntake(leaderAlfa, fixture.alfa, 5);
    await expect(leaderAlfa.page.locator('[data-intake-open="false"]')).toBeVisible();
    await expectApplyLinks(visitor, [fixture.beta], [fixture.alfa, fixture.gamma]);
    await visitor.goto(`${origins.homepage}/team/${encodeURIComponent(fixture.alfa.teamId)}/soknad`);
    await expect(visitor.locator('[data-team-application-intake="closed"]')).toBeVisible();
    await problem(await submitThroughApi(fixture.alfa.teamId, randomUUID(), fixture.first), 409, [
      "team-application.intake-closed",
    ]);
    await checkpoint("intake-closed");

    await leaderAlfa.page
      .locator(`[data-application-id="${second.submission.applicationId}"]`)
      .getByRole("button", { name: `Vis søknad fra ${fixture.second.name}`, exact: true })
      .click();
    await expect(
      leaderAlfa.page.locator(`[data-application-detail="${second.submission.applicationId}"]`),
    ).toBeVisible();
    await leaderAlfa.page.getByRole("button", { name: "Slett søknad", exact: true }).click();

    const dialog = leaderAlfa.page.getByRole("dialog", { name: "Slett søknaden?" });

    await expect(dialog).toBeVisible();
    await inspect(leaderAlfa.page, "delete-dialog");

    const deleteRequest = leaderAlfa.page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname === `/api/team-applications/${second.submission.applicationId}`,
    );

    await dialog.getByRole("button", { name: "Slett søknaden", exact: true }).click();

    const deleteKey = (await (await deleteRequest).allHeaders())["idempotency-key"] ?? "";

    assert.ok(deleteKey.length > 0, "delete sends an idempotency key");
    await expect(leaderAlfa.page.locator('[data-team-application-notice="deleted"]')).toBeVisible();
    await expect(leaderAlfa.page.locator("[data-application-id]")).toHaveCount(1);
    deletions.push({ applicationId: second.submission.applicationId, key: deleteKey });

    const deletePath = `/api/team-applications/${second.submission.applicationId}`;

    const replayedDelete = await api(leaderAlfa.cookie, deletePath, {
      method: "DELETE",
      headers: { "idempotency-key": deleteKey },
    });

    assert.equal(replayedDelete.status, 204, "same-key delete replays");
    await problem(
      await api(leaderAlfa.cookie, deletePath, { method: "DELETE", headers: { "idempotency-key": randomUUID() } }),
      404,
      ["resource.not-found"],
    );
    await problem(await api(memberAlfa.cookie, deletePath), 404, ["resource.not-found"]);
    checks.push({ kind: "deleted", detail: `${second.submission.applicationId} by the current leader` });
    await checkpoint("deleted");

    await expectApplyLinks(visitor, [fixture.beta], [fixture.alfa, fixture.gamma]);
    await visitor.getByRole("link", { name: `Søk på ${fixture.beta.name}`, exact: true }).click();

    const fallback = await submit(visitor, fixture.beta, fixture.fallback, "fallback", false);

    await hooks.awaitNotifications(fallback.submission.applicationId, "Failed");
    await hooks.restartBackend();
    await checkpoint("fallback-failed-delivery");

    await hooks.setProviderMode("accept");
    await hooks.awaitNotifications(fallback.submission.applicationId, "Delivered");
    await checkpoint("unattended-recovery");

    return checks;
  } catch (error) {
    // Keep what every open page showed, so a failed run explains itself.
    const pages = browser.contexts().flatMap((context) => context.pages());

    const observed = await Promise.all(
      pages.map(async (page, index) => {
        await page.screenshot({ path: join(input.artifacts, `failure-${index}.png`), fullPage: true }).catch(() => undefined);

        return {
          url: page.url(),
          text: String(await page.evaluate("document.body.innerText").catch(() => "")).slice(0, 2_000),
          element: String(
            await page
              .evaluate(
                "(() => { const element = document.querySelector('vektor-team-applications'); return JSON.stringify({ defined: customElements.get('vektor-team-applications') !== undefined, html: element === null ? null : element.outerHTML.slice(0, 1500) }); })()",
              )
              .catch(() => ""),
          ),
        };
      }),
    );

    await writeFile(
      join(input.artifacts, "browser-failure.json"),
      JSON.stringify({ checks, pageErrors, observed }, null, 2),
      { mode: 0o600 },
    ).catch(() => undefined);

    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close();
  }
};
