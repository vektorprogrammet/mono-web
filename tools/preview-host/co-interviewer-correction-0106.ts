import { decodePostgresObservations, type PostgresObservation } from "./postgres-observation.js";
import { RecruitmentInterviewConductObservationSchema } from "../../packages/domain/src/recruitment/schema.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import type { Pool } from "pg";
import {
  assertInterviewCorrectionBoundaries,
  type InterviewCorrectionReplayRequest,
} from "./interview-correction-boundaries.ts";
import { assertInterviewCorrectionIntegrity } from "./interview-correction-integrity.ts";
import type { CoInterviewerCorrection0106Fixture } from "./recommendation-preupgrade-fixture.ts";
import { Predicate, Schema } from "effect";

type CorrectionRequestHeaders = {
  origin: string;
  cookie?: string;
  "if-match"?: string;
  "idempotency-key"?: string;
};

type Score = Readonly<{
  explanatoryPower: number;
  roleModel: number;
  suitability: number;
}>;

type Detail = typeof RecruitmentInterviewConductObservationSchema.Type;

type DetailResponse = Readonly<{ body: Detail; etag: string }>;

type BoardItem = Readonly<{
  interviewId: string;
  etag: string;
  coInterviewer: Readonly<{ personId: string; displayName: string }> | null;
}>;

type Board = Readonly<{ interviews: ReadonlyArray<BoardItem> }>;

type PersistedSnapshot = Readonly<Record<string, ReadonlyArray<PostgresObservation>>>;

const DetailSchema = RecruitmentInterviewConductObservationSchema;

const BoardItemSchema = Schema.Struct({
  interviewId: Schema.String,
  etag: Schema.String,
  coInterviewer: Schema.NullOr(
    Schema.Struct({
      personId: Schema.String,
      displayName: Schema.String,
    }),
  ),
});

const BoardSchema = Schema.Struct({ interviews: Schema.Array(BoardItemSchema) });

type NativeLogin = Readonly<{ email: string; password: string }>;

export type CoInterviewerCorrectionJourneyContext = Readonly<{
  pool: Pool;
  browser: Browser;
  primaryCookie: string;
  api: string;
  ui: string;
  artifacts: string;
  revision: string;
  fixture: CoInterviewerCorrection0106Fixture;
  errors: string[];
  secrets: string[];
  effectsBefore: ReadonlyArray<{
    readonly table: string;
    readonly rows: ReadonlyArray<{ readonly value: Schema.Json }>;
  }>;
  effectSnapshot: () => Promise<
    ReadonlyArray<{
      readonly table: string;
      readonly rows: ReadonlyArray<{ readonly value: Schema.Json }>;
    }>
  >;
  auditPage: (page: Page, state: string) => Promise<ReadonlyArray<unknown>>;
  recordGate: (...observations: string[]) => void;
}>;

export type CoInterviewerCorrectionJourneyResult = Readonly<{
  stages: ReadonlyArray<string>;
  statuses: Readonly<Record<string, number>>;
  boundaryStatuses: Readonly<Record<string, number>>;
  correctionRevision: number;
  coInterviewerPersonId: string;
}>;

const freshId = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;

const sharedAssessment = (detail: Detail) => ({
  answers: detail.answers,
  score: detail.score,
  recommendation: detail.recommendation,
  revision: detail.revision,
  effectiveRevision: detail.effectiveRevision,
  history: detail.history,
  finalizedByPersonId: detail.finalizedByPersonId,
  finalizedAt: detail.finalizedAt,
});

export async function runCoInterviewerCorrectionJourney(
  context: CoInterviewerCorrectionJourneyContext,
): Promise<CoInterviewerCorrectionJourneyResult> {
  const {
    pool,
    browser,
    primaryCookie,
    api,
    ui,
    artifacts,
    revision,
    fixture,
    errors,
    secrets,
    effectsBefore,
    effectSnapshot,
    auditPage,
    recordGate,
  } = context;

  const stages: string[] = [];
  const statuses: Record<string, number> = {};

  const stage = (value: string) => {
    stages.push(value);
    recordGate(value);
  };

  const status = (name: string, value: number) => {
    statuses[name] = value;

    return value;
  };

  const headers = (cookie: string, etag?: string, key?: string) => {
    const result: CorrectionRequestHeaders = { origin: ui };

    if (cookie !== null && cookie !== undefined) result.cookie = cookie;

    if (etag !== undefined) result["if-match"] = etag;

    if (key !== undefined) result["idempotency-key"] = key;

    return result;
  };

  const getDetail = async (cookie: string): Promise<DetailResponse> => {
    const response = await fetch(
      `${api}/api/recruitment/interviews/${encodeURIComponent(fixture.targetInterviewId)}`,
      { headers: headers(cookie) },
    );

    const responseEtag = response.headers.get("etag");
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok(responseEtag, "detail response must carry a strong ETag");
    const body: unknown = await response.json();

    try {
      return { body: Schema.decodeUnknownSync(DetailSchema)(body), etag: responseEtag };
    } catch (cause) {
      throw new Error(`invalid interview detail response: ${JSON.stringify(body)}`, { cause });
    }
  };

  const getBoard = async (cookie: string): Promise<Board> => {
    const response = await fetch(`${api}/api/recruitment/interviews`, { headers: headers(cookie) });
    assert.equal(response.status, 200, await response.clone().text());
    const body: unknown = await response.json();

    return Schema.decodeUnknownSync(BoardSchema)(body);
  };

  const boardItem = (board: Board): BoardItem => {
    const item = board.interviews.find(
      (candidate) => candidate.interviewId === fixture.targetInterviewId,
    );

    assert.ok(item, "participant board must contain the designated completed interview");

    return item;
  };

  const postCorrection = (
    cookie: string,
    body: Schema.Json,
    etag: string,
    key: string,
    interviewId = fixture.targetInterviewId,
  ) =>
    fetch(`${api}/api/recruitment/interviews/${encodeURIComponent(interviewId)}:correct`, {
      method: "POST",
      headers: { ...headers(cookie, etag, key), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const snapshot = async (): Promise<PersistedSnapshot> => ({
    interview: decodePostgresObservations(
      (
        await pool.query(
          `SELECT interview_id, interviewer_person_id, co_interviewer_person_id, revision
           FROM public.recruitment_interviews
          WHERE interview_id=$1`,
          [fixture.targetInterviewId],
        )
      ).rows,
    ),
    conduct: decodePostgresObservations(
      (
        await pool.query(
          `SELECT to_jsonb(conduct) AS value
           FROM public.recruitment_interview_conducts AS conduct
          WHERE interview_id=$1`,
          [fixture.targetInterviewId],
        )
      ).rows,
    ),
    corrections: decodePostgresObservations(
      (
        await pool.query(
          `SELECT interview_id, predecessor_revision, resulting_revision, answers,
                explanatory_power, role_model, suitability, recommendation,
                corrected_by_person_id, corrected_at, command_id
           FROM public.recruitment_interview_correction_assessments
          WHERE interview_id=$1
          ORDER BY resulting_revision`,
          [fixture.targetInterviewId],
        )
      ).rows,
    ),
    receipts: decodePostgresObservations(
      (
        await pool.query(
          `SELECT command_id, command_sha256, command_json, observation_json,
                interview_id, predecessor_revision, resulting_revision, committed_at
           FROM public.recruitment_interview_correction_command_receipts
          WHERE interview_id=$1
          ORDER BY resulting_revision, command_id`,
          [fixture.targetInterviewId],
        )
      ).rows,
    ),
    audit: decodePostgresObservations(
      (
        await pool.query(
          `SELECT command_id, interview_id, actor_person_id, predecessor_revision,
                resulting_revision, occurred_at
           FROM public.recruitment_interview_correction_audit
          WHERE interview_id=$1
          ORDER BY resulting_revision, command_id`,
          [fixture.targetInterviewId],
        )
      ).rows,
    ),
    nativeHttpReceipts: decodePostgresObservations(
      (
        await pool.query(
          `SELECT identity_sha256, request_sha256, operation_id, state, status, media_type,
                encode(body_bytes, 'hex') AS body_hex, headers_json, committed_at,
                full_expires_at, tombstoned_at
           FROM public.native_http_idempotency_receipts
          ORDER BY identity_sha256, request_sha256`,
        )
      ).rows,
    ),
  });

  const assertUnchanged = async (before: PersistedSnapshot, label: string) =>
    assert.deepEqual(await snapshot(), before, `${label} changed correction state`);

  const countWrites = async (): Promise<
    Readonly<{ assessments: number; receipts: number; audit: number; revision: number }>
  > => {
    const result = await pool.query<{
      assessments: number;
      receipts: number;
      audit: number;
      revision: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM public.recruitment_interview_correction_assessments WHERE interview_id=$1) AS assessments,
         (SELECT count(*)::int FROM public.recruitment_interview_correction_command_receipts WHERE interview_id=$1) AS receipts,
         (SELECT count(*)::int FROM public.recruitment_interview_correction_audit WHERE interview_id=$1) AS audit,
         (SELECT revision FROM public.recruitment_interviews WHERE interview_id=$1) AS revision`,
      [fixture.targetInterviewId],
    );

    assert.equal(result.rows.length, 1, "correction aggregate count must be present");

    return result.rows[0]!;
  };

  const correctionPayload = (
    detail: Detail,
    answer: string,
    recommendation: "Ja" | "Kanskje" | "Nei",
    score: Score,
  ) => ({
    expectedRevision: detail.revision,
    answers: [
      { questionId: "interview-schema-native-conduct-0063-q0", answer },
      { questionId: "interview-schema-native-conduct-0063-q1", answer: "Teknologi" },
      { questionId: "interview-schema-native-conduct-0063-q2", answer: "Praksis" },
      { questionId: "interview-schema-native-conduct-0063-q3", answer: ["Samarbeid"] },
    ],
    score,
    recommendation,
  });

  const openInterview = async (page: Page) => {
    await page
      .getByRole("article")
      .filter({ hasText: "history Recommendation" })
      .getByRole("button", { name: "Åpne intervju", exact: true })
      .click();
    await page.getByRole("heading", { name: "Intervju med history Recommendation" }).waitFor();
  };

  const fillCorrection = async (
    page: Page,
    answer: string,
    recommendation: "Ja" | "Kanskje" | "Nei",
    score: Score,
  ) => {
    await page.locator("#question-interview-schema-native-conduct-0063-q0").fill(answer);
    await page.locator("#question-interview-schema-native-conduct-0063-q1-1").check();
    await page.locator("#question-interview-schema-native-conduct-0063-q2-0").check();
    await page.locator("#question-interview-schema-native-conduct-0063-q3-0").check();
    await page.locator("#interviewer-recommendation").selectOption(recommendation);
    await page.locator("#score-explanatoryPower").selectOption(String(score.explanatoryPower));
    await page.locator("#score-roleModel").selectOption(String(score.roleModel));
    await page.locator("#score-suitability").selectOption(String(score.suitability));
  };

  const waitForCorrection = (page: Page) =>
    page.waitForResponse((response) => {
      if (
        response.request().method() !== "POST" ||
        new URL(response.url()).pathname !== "/recruitment"
      )
        return false;

      try {
        const payload: unknown = response.request().postDataJSON();

        return (
          (payload === null || Predicate.isObjectOrArray(payload)) &&
          payload !== null &&
          "operation" in payload &&
          payload.operation === "correctInterviewAssessment"
        );
      } catch {
        return false;
      }
    });

  const submitBrowserCorrection = async (page: Page) => {
    await page.getByRole("button", { name: "Rett intervju", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    const responsePromise = waitForCorrection(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Rett intervju", exact: true })
      .press("Enter");
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
  };

  const login = async (identity: NativeLogin, label: string) => {
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    page.on("pageerror", () => errors.push(`${label}-pageerror`));
    secrets.push(identity.email, identity.password);
    await page.goto(`${ui}/login`);
    await page.getByLabel("E-post", { exact: true }).fill(identity.email);
    await page.getByLabel("Passord", { exact: true }).fill(identity.password);
    await page.getByRole("button", { name: "Logg inn", exact: true }).click();
    await page.waitForURL(/\/dashboard\/?$/);
    await page.goto(`${ui}/dashboard/intervjuer`);
    const cookies = await browserContext.cookies();
    assert.ok(cookies.length > 0, "native login did not establish a browser session");
    secrets.push(...cookies.map((cookie) => cookie.value));

    return {
      browserContext,
      page,
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    };
  };

  const signInCookie = async (identity: NativeLogin, label: string): Promise<string> => {
    secrets.push(identity.email, identity.password);
    let response: Response | undefined;

    for (let retry = 0; retry <= 30; retry += 1) {
      response = await fetch(`${api}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: ui, "content-type": "application/json" },
        body: JSON.stringify(identity),
      });

      if (response.status !== 429) break;
      const cooldown = Promise.withResolvers<void>();
      setTimeout(cooldown.resolve, 1_000);
      await cooldown.promise;
    }

    assert.ok(response, `${label} native login did not return a response`);
    assert.equal(response.status, 200, `${label} native login failed: ${await response.text()}`);
    const cookie = response.headers.get("set-cookie")?.match(/^([^=;]+=[^;]+)/u)?.[1];
    assert.ok(cookie, `${label} native login did not return a session cookie`);
    secrets.push(cookie);

    return cookie;
  };

  const primaryInitial = await getDetail(primaryCookie);
  const primaryBoardInitial = await getBoard(primaryCookie);
  const primaryBoardItemInitial = boardItem(primaryBoardInitial);
  const co = await login(fixture.coInterviewer, "co-interviewer");

  try {
    const coInitial = await getDetail(co.cookie);
    const coBoardInitial = await getBoard(co.cookie);
    const coBoardItemInitial = boardItem(coBoardInitial);
    assert.deepEqual(sharedAssessment(coInitial.body), sharedAssessment(primaryInitial.body));
    assert.deepEqual(coBoardItemInitial.coInterviewer, {
      personId: fixture.coInterviewer.personId,
      displayName: fixture.coInterviewer.displayName,
    });
    assert.deepEqual(primaryBoardItemInitial.coInterviewer, coBoardItemInitial.coInterviewer);
    assert.deepEqual(Object.keys(coBoardItemInitial.coInterviewer ?? {}).sort(), [
      "displayName",
      "personId",
    ]);
    assert.equal(coInitial.body.canFinalize, false);
    assert.equal(coInitial.body.canCancel, false);
    stage(
      "ordinary primary and co-interviewer receive one shared completed assessment without co contact data",
    );

    const unassignedCookie = await signInCookie(fixture.unassignedMember, "unassigned-member");
    const unassignedBoard = await getBoard(unassignedCookie);
    assert.equal(
      unassignedBoard.interviews.some(
        (candidate) => candidate.interviewId === fixture.targetInterviewId,
      ),
      false,
    );
    const deniedBefore = await snapshot();

    const unassignedRead = await fetch(
      `${api}/api/recruitment/interviews/${encodeURIComponent(fixture.targetInterviewId)}`,
      { headers: headers(unassignedCookie) },
    );

    status("unassigned:read", unassignedRead.status);
    assert.equal(unassignedRead.status, 403, await unassignedRead.text());

    const unassignedCorrect = await postCorrection(
      unassignedCookie,
      correctionPayload(coInitial.body, "Unassigned correction.", "Nei", {
        explanatoryPower: 1,
        roleModel: 1,
        suitability: 1,
      }),
      coInitial.etag,
      freshId("co-interviewer-unassigned"),
    );

    status("unassigned:correct", unassignedCorrect.status);
    assert.equal(unassignedCorrect.status, 403, await unassignedCorrect.text());
    await assertUnchanged(deniedBefore, "unassigned member denial");
    stage(
      "same-department ordinary unassigned member has neither board, detail, nor correction access",
    );

    await co.page.goto(`${ui}/dashboard/intervjuer`);
    const coCard = co.page.getByRole("article").filter({ hasText: "history Recommendation" });
    await coCard.waitFor();
    const cardText = await coCard.innerText();
    assert.match(cardText, /Medintervjuer/u);
    assert.match(cardText, new RegExp(fixture.coInterviewer.displayName, "u"));
    await openInterview(co.page);
    stage(
      "real active co-interviewer signs in and opens the designated completed interview from the board",
    );

    const sourceChangedTo = fixture.unassignedMember.personId;
    await pool.query(
      `UPDATE public.recruitment_interviews
          SET co_interviewer_person_id=$1
        WHERE interview_id=$2`,
      [sourceChangedTo, fixture.targetInterviewId],
    );

    try {
      const changedPrimary = await getDetail(primaryCookie);
      const changedBoardItem = boardItem(await getBoard(primaryCookie));
      assert.notEqual(changedPrimary.etag, primaryInitial.etag);
      assert.notEqual(changedBoardItem.etag, primaryBoardItemInitial.etag);

      const changedCo = await fetch(
        `${api}/api/recruitment/interviews/${encodeURIComponent(fixture.targetInterviewId)}`,
        { headers: headers(co.cookie) },
      );

      status("designation-changed:co-read", changedCo.status);
      assert.equal(changedCo.status, 403, await changedCo.text());
      const staleAuthorityBefore = await snapshot();

      const oldAuthorityWrite = await postCorrection(
        primaryCookie,
        correctionPayload(primaryInitial.body, "Stale authority ETag.", "Nei", {
          explanatoryPower: 2,
          roleModel: 2,
          suitability: 2,
        }),
        primaryInitial.etag,
        freshId("co-interviewer-source-etag"),
      );

      status("designation-changed:old-etag", oldAuthorityWrite.status);
      assert.equal(oldAuthorityWrite.status, 412, await oldAuthorityWrite.text());
      await assertUnchanged(staleAuthorityBefore, "old authority ETag");
    } finally {
      await pool.query(
        `UPDATE public.recruitment_interviews
            SET co_interviewer_person_id=$1
          WHERE interview_id=$2`,
        [fixture.coInterviewer.personId, fixture.targetInterviewId],
      );
    }

    assert.equal((await getDetail(co.cookie)).body.revision, coInitial.body.revision);
    stage(
      "controlled nullable co-interviewer source change invalidates primary representation ETags and co authority",
    );

    const firstBrowserDetail = await getDetail(co.cookie);

    const originalConduct = (
      await pool.query(
        `SELECT to_jsonb(conduct) AS value
           FROM public.recruitment_interview_conducts AS conduct
          WHERE interview_id=$1`,
        [fixture.targetInterviewId],
      )
    ).rows[0]?.value;

    assert.ok(
      originalConduct,
      "completed co-interviewer fixture requires immutable original conduct",
    );
    await fillCorrection(co.page, "Co-interviewer browser correction.", "Ja", {
      explanatoryPower: 4,
      roleModel: 5,
      suitability: 6,
    });
    await submitBrowserCorrection(co.page);
    const afterBrowserCorrection = await getDetail(co.cookie);
    assert.equal(afterBrowserCorrection.body.revision, firstBrowserDetail.body.revision + 1);
    assert.equal(afterBrowserCorrection.body.recommendation, "Ja");
    assert.equal(
      afterBrowserCorrection.body.history.length,
      firstBrowserDetail.body.history.length + 1,
    );

    const correctionActor = await pool.query(
      `SELECT corrected_by_person_id AS "correctedByPersonId"
         FROM public.recruitment_interview_correction_assessments
        WHERE interview_id=$1
        ORDER BY resulting_revision DESC
        LIMIT 1`,
      [fixture.targetInterviewId],
    );

    assert.deepEqual(correctionActor.rows, [
      { correctedByPersonId: fixture.coInterviewer.personId },
    ]);
    assert.deepEqual(
      (
        await pool.query(
          `SELECT to_jsonb(conduct) AS value
             FROM public.recruitment_interview_conducts AS conduct
            WHERE interview_id=$1`,
          [fixture.targetInterviewId],
        )
      ).rows[0]?.value,
      originalConduct,
    );
    const primaryAfterBrowserCorrection = await getDetail(primaryCookie);
    assert.deepEqual(
      sharedAssessment(primaryAfterBrowserCorrection.body),
      sharedAssessment(afterBrowserCorrection.body),
    );
    stage(
      "keyboard browser correction appends one co-attributed assessment while primary fresh-read sees the identical shared history",
    );

    const authorityBefore = await snapshot();

    const finalization = await fetch(
      `${api}/api/recruitment/interviews/${encodeURIComponent(fixture.targetInterviewId)}:finalize`,
      {
        method: "POST",
        headers: {
          ...headers(co.cookie, afterBrowserCorrection.etag, freshId("co-interviewer-finalize")),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          answers: afterBrowserCorrection.body.answers,
          score: afterBrowserCorrection.body.score,
          recommendation: afterBrowserCorrection.body.recommendation,
        }),
      },
    );

    status("co-interviewer:finalize", finalization.status);
    assert.equal(finalization.status, 403, await finalization.text());

    const cancellation = await fetch(
      `${api}/api/recruitment/interviews/${encodeURIComponent(fixture.targetInterviewId)}:cancel`,
      {
        method: "POST",
        headers: {
          ...headers(co.cookie, afterBrowserCorrection.etag, freshId("co-interviewer-cancel")),
          "content-type": "application/json",
        },
        body: "{}",
      },
    );

    status("co-interviewer:cancel", cancellation.status);
    assert.equal(cancellation.status, 403, await cancellation.text());

    const schedule = await fetch(
      `${api}/api/recruitment/interviews/${encodeURIComponent(fixture.targetInterviewId)}:schedule`,
      {
        method: "POST",
        headers: {
          ...headers(
            co.cookie,
            boardItem(await getBoard(co.cookie)).etag,
            freshId("co-interviewer-schedule"),
          ),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scheduledAt: "2031-09-23T10:00:00.000Z",
          room: "Denied co-interviewer room",
          campus: "Gløshaugen",
          mapLink: "https://maps.example.invalid/co-interviewer-denied-0106",
          message: "This command must remain denied.",
        }),
      },
    );

    status("co-interviewer:schedule", schedule.status);
    assert.equal(schedule.status, 403, await schedule.text());
    await assertUnchanged(authorityBefore, "co-interviewer lifecycle and schedule denial");
    stage(
      "co-interviewer designation alone grants neither finalization, cancellation, nor scheduling authority",
    );

    const staleContext = await browser.newContext({
      storageState: await co.browserContext.storageState(),
    });

    const stalePage = await staleContext.newPage();
    stalePage.on("pageerror", () => errors.push("co-interviewer-stale-pageerror"));

    try {
      await stalePage.goto(`${ui}/dashboard/intervjuer`);
      await openInterview(stalePage);
      await fillCorrection(stalePage, "Co-interviewer stale draft.", "Kanskje", {
        explanatoryPower: 7,
        roleModel: 7,
        suitability: 7,
      });
      await fillCorrection(co.page, "Co-interviewer newer correction.", "Nei", {
        explanatoryPower: 8,
        roleModel: 8,
        suitability: 8,
      });
      await submitBrowserCorrection(co.page);
      const staleBefore = await snapshot();
      const staleResponsePromise = waitForCorrection(stalePage);
      await stalePage.getByRole("button", { name: "Rett intervju", exact: true }).click();
      await stalePage.getByRole("dialog").waitFor({ state: "visible" });
      await stalePage
        .getByRole("dialog")
        .getByRole("button", { name: "Rett intervju", exact: true })
        .press("Enter");
      const staleResponse = await staleResponsePromise;
      status("co-interviewer:stale", staleResponse.status());
      assert.equal(staleResponse.status(), 409, await staleResponse.text());
      await stalePage
        .getByText(
          "Intervjuet er endret. Utkastet er beholdt; åpne intervjuet på nytt for å hente gjeldende versjon.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await stalePage.locator("#question-interview-schema-native-conduct-0063-q0").inputValue(),
        "Co-interviewer stale draft.",
      );
      assert.equal(await stalePage.locator("#interviewer-recommendation").inputValue(), "Kanskje");
      await assertUnchanged(staleBefore, "co-interviewer stale correction");
    } finally {
      await staleContext.close();
    }

    stage("co-interviewer stale browser command retains the visible draft and writes nothing");

    const replayBase = await getDetail(co.cookie);

    const replayPayload = correctionPayload(
      replayBase.body,
      "Co-interviewer exact replay.",
      "Kanskje",
      {
        explanatoryPower: 7,
        roleModel: 8,
        suitability: 9,
      },
    );

    const acceptedReplay: InterviewCorrectionReplayRequest = {
      key: freshId("co-interviewer-replay"),
      etag: replayBase.etag,
      payload: replayPayload,
    };

    const firstReplay = await postCorrection(
      co.cookie,
      acceptedReplay.payload,
      acceptedReplay.etag,
      acceptedReplay.key,
    );

    status("co-interviewer:replay-first", firstReplay.status);
    assert.equal(firstReplay.status, 200);
    const firstReplayBytes = await firstReplay.text();

    const exactReplay = await postCorrection(
      co.cookie,
      acceptedReplay.payload,
      acceptedReplay.etag,
      acceptedReplay.key,
    );

    status("co-interviewer:replay-exact", exactReplay.status);
    assert.equal(exactReplay.status, 200);
    assert.equal(await exactReplay.text(), firstReplayBytes);
    stage("co-interviewer exact correction replay remains byte-stable");

    const concurrentBase = await getDetail(co.cookie);
    const writesBeforeConcurrent = await countWrites();
    const concurrentRecommendations: ReadonlyArray<"Ja" | "Nei"> = ["Ja", "Nei"];

    const concurrent = await Promise.all(
      concurrentRecommendations.map((recommendation, index) =>
        postCorrection(
          co.cookie,
          correctionPayload(
            concurrentBase.body,
            `Co-interviewer concurrent ${index}.`,
            recommendation,
            { explanatoryPower: 3 + index, roleModel: 4 + index, suitability: 5 + index },
          ),
          concurrentBase.etag,
          freshId(`co-interviewer-concurrent-${index}`),
        ),
      ),
    );

    for (const [index, response] of concurrent.entries()) {
      status(`co-interviewer:concurrent-${index}`, response.status);
    }

    assert.equal(concurrent.filter((response) => response.status === 200).length, 1);
    assert.equal(concurrent.filter((response) => response.status !== 200).length, 1);
    assert.ok(
      concurrent.every(
        (response) => response.status === 200 || [409, 412].includes(response.status),
      ),
    );
    const writesAfterConcurrent = await countWrites();
    assert.deepEqual(writesAfterConcurrent, {
      assessments: writesBeforeConcurrent.assessments + 1,
      receipts: writesBeforeConcurrent.receipts + 1,
      audit: writesBeforeConcurrent.audit + 1,
      revision: writesBeforeConcurrent.revision + 1,
    });
    stage(
      "same-revision co-interviewer corrections produce one winner and one no-write stale loser",
    );

    const boundaryResult = await assertInterviewCorrectionBoundaries({
      pool,
      api,
      origin: ui,
      cookie: co.cookie,
      interviewId: fixture.targetInterviewId,
      actorPersonId: fixture.coInterviewer.personId,
      otherPersonId: fixture.unassignedMember.personId,
      membershipId: fixture.coInterviewer.membershipId,
      selfLinkRaceInterviewId: fixture.selfLinkRaceInterviewId,
      acceptedReplay,
      participantRole: "co",
      recordGate,
    });

    await assertInterviewCorrectionIntegrity(pool, fixture.targetInterviewId, {
      expectedCorrectedByPersonId: fixture.coInterviewer.personId,
      expectedCoInterviewerPersonId: fixture.coInterviewer.personId,
    });
    assert.deepEqual(await effectSnapshot(), effectsBefore);
    const primaryFinal = await getDetail(primaryCookie);
    const coFinal = await getDetail(co.cookie);
    assert.deepEqual(sharedAssessment(primaryFinal.body), sharedAssessment(coFinal.body));
    stage(
      "denial, revocation, exact replay, rollback, native receipt, and SQL correction integrity gates preserve one shared aggregate with no effects",
    );

    await co.page.setViewportSize({ width: 1280, height: 900 });
    await co.page
      .locator(".fs-conduct")
      .screenshot({ path: join(artifacts, "co-interviewer-correction-desktop.png") });
    assert.deepEqual(await auditPage(co.page, "co-interviewer-correction-desktop"), []);
    await co.page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      (await co.page.locator("html").evaluate((element: HTMLElement) => element.scrollWidth)) <=
        390,
      "co-interviewer correction must fit the mobile viewport",
    );
    await co.page
      .locator(".fs-conduct")
      .screenshot({ path: join(artifacts, "co-interviewer-correction-mobile.png") });
    assert.deepEqual(await auditPage(co.page, "co-interviewer-correction-mobile"), []);
    await co.page.setViewportSize({ width: 1280, height: 900 });
    assert.deepEqual(errors, []);
    stage("co-interviewer desktop and mobile correction surfaces pass Axe without page errors");

    const result: CoInterviewerCorrectionJourneyResult = {
      stages,
      statuses,
      boundaryStatuses: boundaryResult.statuses,
      correctionRevision: coFinal.body.revision,
      coInterviewerPersonId: fixture.coInterviewer.personId,
    };

    await writeFile(
      join(artifacts, "co-interviewer-targeted-evidence.json"),
      JSON.stringify(
        {
          revision,
          fixture: {
            interviewId: fixture.targetInterviewId,
            primaryPersonId: fixture.primaryPersonId,
            coInterviewer: {
              personId: fixture.coInterviewer.personId,
              displayName: fixture.coInterviewer.displayName,
            },
          },
          result,
        },
        null,
        2,
      ),
    );

    return result;
  } finally {
    await co.browserContext.close();
  }
}
