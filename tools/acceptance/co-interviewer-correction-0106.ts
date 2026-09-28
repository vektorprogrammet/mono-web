import { decodePostgresObservations, type PostgresObservation } from "./postgres-observation.js";
import { RecruitmentInterviewConductObservationSchema } from "../../packages/domain/src/recruitment/schema.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import type { Pool } from "pg";
import {
  assertInterviewCorrectionBoundaries,
  type InterviewCorrectionReplayRequest,
} from "./interview-correction-boundaries.ts";
import { assertInterviewCorrectionIntegrity } from "./interview-correction-integrity.ts";
import type { CoInterviewerCorrection0106Fixture } from "./recommendation-preupgrade-fixture.ts";
import { Effect, Exit, FileSystem, Path, type PlatformError, Predicate, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import { firstSetCookie, jsonText, type JourneyStepFailed, step } from "./journey-step.ts";
import { indentedJsonText, ProbeFailure } from "./acceptance-process.ts";
import { replacedFetch } from "../../apps/dashboard/e2e/native-rpc-ledger.ts";
import { admissionJourneyClock } from "../e2e/journey-clock.ts";

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
  effectSnapshot: () => Effect.Effect<
    ReadonlyArray<{
      readonly table: string;
      readonly rows: ReadonlyArray<{ readonly value: Schema.Json }>;
    }>,
    JourneyStepFailed
  >;
  auditPage: (
    page: Page,
    state: string,
  ) => Effect.Effect<
    ReadonlyArray<unknown>,
    JourneyStepFailed | PlatformError.PlatformError | Schema.SchemaError
  >;
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

export const runCoInterviewerCorrectionJourney = Effect.fnUntraced(function* (
  context: CoInterviewerCorrectionJourneyContext,
) {
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

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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

  /** One RPC as the route it replaced answered, with the person's cookie and the dashboard origin. */
  const recruitment = (tag: string, payload: Schema.Json, cookie: string) =>
    replacedFetch({ origin: api, tag, payload, headers: headers(cookie) });

  const readConduct = (cookie: string) =>
    recruitment(
      "recruitment.readInterviewConduct",
      { interviewId: fixture.targetInterviewId },
      cookie,
    );

  const getDetail = Effect.fnUntraced(function* (cookie: string) {
    const response = yield* step(() => readConduct(cookie));

    const responseEtag = response.headers.get("etag");
    assert.equal(response.status, 200, yield* step(() => response.clone().text()));
    assert.ok(responseEtag, "detail response must carry a strong ETag");
    const body: unknown = yield* step(() => response.json());

    const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(DetailSchema)(body));

    if (Exit.isFailure(decoded))
      return yield* new ProbeFailure({
        message: `invalid interview detail response: ${yield* jsonText(body)}`,
      });

    return { body: decoded.value, etag: responseEtag };
  });

  const getBoard = Effect.fnUntraced(function* (cookie: string) {
    const response = yield* step(() =>
      recruitment("recruitment.readSchedulingBoard", null, cookie),
    );

    assert.equal(response.status, 200, yield* step(() => response.clone().text()));
    const body: unknown = yield* step(() => response.json());

    return yield* Schema.decodeUnknownEffect(BoardSchema)(body);
  });

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
    recruitment(
      "recruitment.correctInterviewAssessment",
      { interviewId, idempotencyKey: key, ifMatch: etag, request: body },
      cookie,
    );

  const snapshot = Effect.fnUntraced(function* () {
    return {
      interview: decodePostgresObservations(
        (yield* step(() =>
          pool.query(
            `SELECT interview_id, interviewer_person_id, co_interviewer_person_id, revision
           FROM public.recruitment_interviews
          WHERE interview_id=$1`,
            [fixture.targetInterviewId],
          ),
        )).rows,
      ),
      conduct: decodePostgresObservations(
        (yield* step(() =>
          pool.query(
            `SELECT to_jsonb(conduct) AS value
           FROM public.recruitment_interview_conducts AS conduct
          WHERE interview_id=$1`,
            [fixture.targetInterviewId],
          ),
        )).rows,
      ),
      corrections: decodePostgresObservations(
        (yield* step(() =>
          pool.query(
            `SELECT interview_id, predecessor_revision, resulting_revision, answers,
                explanatory_power, role_model, suitability, recommendation,
                corrected_by_person_id, corrected_at, command_id
           FROM public.recruitment_interview_correction_assessments
          WHERE interview_id=$1
          ORDER BY resulting_revision`,
            [fixture.targetInterviewId],
          ),
        )).rows,
      ),
      receipts: decodePostgresObservations(
        (yield* step(() =>
          pool.query(
            `SELECT command_id, command_sha256, command_json, observation_json,
                interview_id, predecessor_revision, resulting_revision, committed_at
           FROM public.recruitment_interview_correction_command_receipts
          WHERE interview_id=$1
          ORDER BY resulting_revision, command_id`,
            [fixture.targetInterviewId],
          ),
        )).rows,
      ),
      audit: decodePostgresObservations(
        (yield* step(() =>
          pool.query(
            `SELECT command_id, interview_id, actor_person_id, predecessor_revision,
                resulting_revision, occurred_at
           FROM public.recruitment_interview_correction_audit
          WHERE interview_id=$1
          ORDER BY resulting_revision, command_id`,
            [fixture.targetInterviewId],
          ),
        )).rows,
      ),
      nativeHttpReceipts: decodePostgresObservations(
        (yield* step(() =>
          pool.query(
            `SELECT identity_sha256, request_sha256, operation_id, state, status, media_type,
                encode(body_bytes, 'hex') AS body_hex, headers_json, committed_at,
                full_expires_at, tombstoned_at
           FROM public.native_http_idempotency_receipts
          ORDER BY identity_sha256, request_sha256`,
          ),
        )).rows,
      ),
    };
  });

  const assertUnchanged = Effect.fnUntraced(function* (before: PersistedSnapshot, label: string) {
    return assert.deepEqual(yield* snapshot(), before, `${label} changed correction state`);
  });

  const countWrites = Effect.fnUntraced(function* () {
    const result = yield* step(() =>
      pool.query<{
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
      ),
    );

    assert.equal(result.rows.length, 1, "correction aggregate count must be present");

    return result.rows[0]!;
  });

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

  const openInterview = Effect.fnUntraced(function* (page: Page) {
    yield* step(() =>
      page
        .getByRole("article")
        .filter({ hasText: "history Recommendation" })
        .getByRole("button", { name: "Åpne intervju", exact: true })
        .click(),
    );
    yield* step(() =>
      page.getByRole("heading", { name: "Intervju med history Recommendation" }).waitFor(),
    );
  });

  const fillCorrection = Effect.fnUntraced(function* (
    page: Page,
    answer: string,
    recommendation: "Ja" | "Kanskje" | "Nei",
    score: Score,
  ) {
    yield* step(() =>
      page.locator("#question-interview-schema-native-conduct-0063-q0").fill(answer),
    );
    yield* step(() => page.locator("#question-interview-schema-native-conduct-0063-q1-1").check());
    yield* step(() => page.locator("#question-interview-schema-native-conduct-0063-q2-0").check());
    yield* step(() => page.locator("#question-interview-schema-native-conduct-0063-q3-0").check());
    yield* step(() => page.locator("#interviewer-recommendation").selectOption(recommendation));
    yield* step(() =>
      page.locator("#score-explanatoryPower").selectOption(String(score.explanatoryPower)),
    );
    yield* step(() => page.locator("#score-roleModel").selectOption(String(score.roleModel)));
    yield* step(() => page.locator("#score-suitability").selectOption(String(score.suitability)));
  });

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

  const submitBrowserCorrection = Effect.fnUntraced(function* (page: Page) {
    yield* step(() => page.getByRole("button", { name: "Rett intervju", exact: true }).click());
    yield* step(() => page.getByRole("dialog").waitFor({ state: "visible" }));
    const responsePromise = waitForCorrection(page);
    yield* step(() =>
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Rett intervju", exact: true })
        .press("Enter"),
    );
    const response = yield* step(() => responsePromise);
    assert.equal(response.status(), 200, yield* step(() => response.text()));
  });

  const login = Effect.fnUntraced(function* (identity: NativeLogin, label: string) {
    const browserContext = yield* step(() => browser.newContext());
    const page = yield* step(() => browserContext.newPage());
    page.on("pageerror", () => errors.push(`${label}-pageerror`));
    secrets.push(identity.email, identity.password);
    yield* step(() => page.goto(`${ui}/login`));
    yield* step(() => page.getByLabel("E-post", { exact: true }).fill(identity.email));
    yield* step(() => page.getByLabel("Passord", { exact: true }).fill(identity.password));
    yield* step(() => page.getByRole("button", { name: "Logg inn", exact: true }).click());
    yield* step(() => page.waitForURL(/\/dashboard\/?$/));
    yield* step(() => page.goto(`${ui}/dashboard/intervjuer`));
    const cookies = yield* step(() => browserContext.cookies());
    assert.ok(cookies.length > 0, "native login did not establish a browser session");
    secrets.push(...cookies.map((cookie) => cookie.value));

    return {
      browserContext,
      page,
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    };
  });

  const signInCookie = Effect.fnUntraced(function* (identity: NativeLogin, label: string) {
    secrets.push(identity.email, identity.password);
    const body = yield* jsonText(identity);
    let response: HttpClientResponse.HttpClientResponse | undefined;

    for (let retry = 0; retry <= 30; retry += 1) {
      response = yield* HttpClient.execute(
        HttpClientRequest.post(`${api}/api/auth/sign-in/email`).pipe(
          HttpClientRequest.setHeaders({ origin: ui }),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      );

      if (response.status !== 429) break;
      yield* Effect.sleep("1 second");
    }

    assert.ok(response, `${label} native login did not return a response`);
    assert.equal(response.status, 200, `${label} native login failed: ${yield* response.text}`);
    const cookie = firstSetCookie(response);
    assert.ok(cookie, `${label} native login did not return a session cookie`);
    secrets.push(cookie);

    return cookie;
  });

  const primaryInitial = yield* getDetail(primaryCookie);
  const primaryBoardInitial = yield* getBoard(primaryCookie);
  const primaryBoardItemInitial = boardItem(primaryBoardInitial);
  const co = yield* login(fixture.coInterviewer, "co-interviewer");

  return yield* Effect.gen(function* () {
    const coInitial = yield* getDetail(co.cookie);
    const coBoardInitial = yield* getBoard(co.cookie);
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

    const unassignedCookie = yield* signInCookie(fixture.unassignedMember, "unassigned-member");
    const unassignedBoard = yield* getBoard(unassignedCookie);
    assert.equal(
      unassignedBoard.interviews.some(
        (candidate) => candidate.interviewId === fixture.targetInterviewId,
      ),
      false,
    );
    const deniedBefore = yield* snapshot();

    const unassignedRead = yield* step(() => readConduct(unassignedCookie));

    status("unassigned:read", unassignedRead.status);
    assert.equal(unassignedRead.status, 403, yield* step(() => unassignedRead.text()));

    const unassignedCorrect = yield* step(() =>
      postCorrection(
        unassignedCookie,
        correctionPayload(coInitial.body, "Unassigned correction.", "Nei", {
          explanatoryPower: 1,
          roleModel: 1,
          suitability: 1,
        }),
        coInitial.etag,
        freshId("co-interviewer-unassigned"),
      ),
    );

    status("unassigned:correct", unassignedCorrect.status);
    assert.equal(unassignedCorrect.status, 403, yield* step(() => unassignedCorrect.text()));
    yield* assertUnchanged(deniedBefore, "unassigned member denial");
    stage(
      "same-department ordinary unassigned member has neither board, detail, nor correction access",
    );

    yield* step(() => co.page.goto(`${ui}/dashboard/intervjuer`));
    const coCard = co.page.getByRole("article").filter({ hasText: "history Recommendation" });
    yield* step(() => coCard.waitFor());
    const cardText = yield* step(() => coCard.innerText());
    assert.match(cardText, /Medintervjuer/u);
    assert.match(cardText, new RegExp(fixture.coInterviewer.displayName, "u"));
    yield* openInterview(co.page);
    stage(
      "real active co-interviewer signs in and opens the designated completed interview from the board",
    );

    const sourceChangedTo = fixture.unassignedMember.personId;
    yield* step(() =>
      pool.query(
        `UPDATE public.recruitment_interviews
          SET co_interviewer_person_id=$1
        WHERE interview_id=$2`,
        [sourceChangedTo, fixture.targetInterviewId],
      ),
    );

    yield* Effect.gen(function* () {
      const changedPrimary = yield* getDetail(primaryCookie);
      const changedBoardItem = boardItem(yield* getBoard(primaryCookie));
      assert.notEqual(changedPrimary.etag, primaryInitial.etag);
      assert.notEqual(changedBoardItem.etag, primaryBoardItemInitial.etag);

      const changedCo = yield* step(() => readConduct(co.cookie));

      status("designation-changed:co-read", changedCo.status);
      assert.equal(changedCo.status, 403, yield* step(() => changedCo.text()));
      const staleAuthorityBefore = yield* snapshot();

      const oldAuthorityWrite = yield* step(() =>
        postCorrection(
          primaryCookie,
          correctionPayload(primaryInitial.body, "Stale authority ETag.", "Nei", {
            explanatoryPower: 2,
            roleModel: 2,
            suitability: 2,
          }),
          primaryInitial.etag,
          freshId("co-interviewer-source-etag"),
        ),
      );

      status("designation-changed:old-etag", oldAuthorityWrite.status);
      assert.equal(oldAuthorityWrite.status, 412, yield* step(() => oldAuthorityWrite.text()));
      yield* assertUnchanged(staleAuthorityBefore, "old authority ETag");
    }).pipe(
      Effect.ensuring(
        step(() =>
          pool.query(
            `UPDATE public.recruitment_interviews
            SET co_interviewer_person_id=$1
          WHERE interview_id=$2`,
            [fixture.coInterviewer.personId, fixture.targetInterviewId],
          ),
        ).pipe(Effect.orDie),
      ),
    );

    assert.equal((yield* getDetail(co.cookie)).body.revision, coInitial.body.revision);
    stage(
      "controlled nullable co-interviewer source change invalidates primary representation ETags and co authority",
    );

    const firstBrowserDetail = yield* getDetail(co.cookie);

    const originalConduct = (yield* step(() =>
      pool.query(
        `SELECT to_jsonb(conduct) AS value
           FROM public.recruitment_interview_conducts AS conduct
          WHERE interview_id=$1`,
        [fixture.targetInterviewId],
      ),
    )).rows[0]?.value;

    assert.ok(
      originalConduct,
      "completed co-interviewer fixture requires immutable original conduct",
    );
    yield* fillCorrection(co.page, "Co-interviewer browser correction.", "Ja", {
      explanatoryPower: 4,
      roleModel: 5,
      suitability: 6,
    });
    yield* submitBrowserCorrection(co.page);
    const afterBrowserCorrection = yield* getDetail(co.cookie);
    assert.equal(afterBrowserCorrection.body.revision, firstBrowserDetail.body.revision + 1);
    assert.equal(afterBrowserCorrection.body.recommendation, "Ja");
    assert.equal(
      afterBrowserCorrection.body.history.length,
      firstBrowserDetail.body.history.length + 1,
    );

    const correctionActor = yield* step(() =>
      pool.query(
        `SELECT corrected_by_person_id AS "correctedByPersonId"
         FROM public.recruitment_interview_correction_assessments
        WHERE interview_id=$1
        ORDER BY resulting_revision DESC
        LIMIT 1`,
        [fixture.targetInterviewId],
      ),
    );

    assert.deepEqual(correctionActor.rows, [
      { correctedByPersonId: fixture.coInterviewer.personId },
    ]);
    assert.deepEqual(
      (yield* step(() =>
        pool.query(
          `SELECT to_jsonb(conduct) AS value
             FROM public.recruitment_interview_conducts AS conduct
            WHERE interview_id=$1`,
          [fixture.targetInterviewId],
        ),
      )).rows[0]?.value,
      originalConduct,
    );
    const primaryAfterBrowserCorrection = yield* getDetail(primaryCookie);
    assert.deepEqual(
      sharedAssessment(primaryAfterBrowserCorrection.body),
      sharedAssessment(afterBrowserCorrection.body),
    );
    stage(
      "keyboard browser correction appends one co-attributed assessment while primary fresh-read sees the identical shared history",
    );

    const authorityBefore = yield* snapshot();

    const finalization = yield* step(() =>
      recruitment(
        "recruitment.finalizeInterview",
        {
          interviewId: fixture.targetInterviewId,
          idempotencyKey: freshId("co-interviewer-finalize"),
          ifMatch: afterBrowserCorrection.etag,
          request: Schema.encodeSync(Schema.Json)({
            answers: afterBrowserCorrection.body.answers,
            score: afterBrowserCorrection.body.score,
            recommendation: afterBrowserCorrection.body.recommendation,
          }),
        },
        co.cookie,
      ),
    );

    status("co-interviewer:finalize", finalization.status);
    assert.equal(finalization.status, 403, yield* step(() => finalization.text()));

    const cancellation = yield* step(() =>
      recruitment(
        "recruitment.cancelInterview",
        {
          interviewId: fixture.targetInterviewId,
          idempotencyKey: freshId("co-interviewer-cancel"),
          ifMatch: afterBrowserCorrection.etag,
        },
        co.cookie,
      ),
    );

    status("co-interviewer:cancel", cancellation.status);
    assert.equal(cancellation.status, 403, yield* step(() => cancellation.text()));

    const scheduleBoardItem = boardItem(yield* getBoard(co.cookie));

    const schedule = yield* step(() =>
      recruitment(
        "recruitment.scheduleInterview",
        {
          interviewId: fixture.targetInterviewId,
          idempotencyKey: freshId("co-interviewer-schedule"),
          ifMatch: scheduleBoardItem.etag,
          request: {
            // A schedule ahead of the backend's clock, so that only authority denies the command.
            scheduledAt: admissionJourneyClock().fromNow(7),
            room: "Denied co-interviewer room",
            campus: "Gløshaugen",
            mapLink: "https://maps.example.invalid/co-interviewer-denied-0106",
            message: "This command must remain denied.",
          },
        },
        co.cookie,
      ),
    );

    status("co-interviewer:schedule", schedule.status);
    assert.equal(schedule.status, 403, yield* step(() => schedule.text()));
    yield* assertUnchanged(authorityBefore, "co-interviewer lifecycle and schedule denial");
    stage(
      "co-interviewer designation alone grants neither finalization, cancellation, nor scheduling authority",
    );

    const staleStorageState = yield* step(() => co.browserContext.storageState());

    const staleContext = yield* step(() =>
      browser.newContext({
        storageState: staleStorageState,
      }),
    );

    const stalePage = yield* step(() => staleContext.newPage());
    stalePage.on("pageerror", () => errors.push("co-interviewer-stale-pageerror"));

    yield* Effect.gen(function* () {
      yield* step(() => stalePage.goto(`${ui}/dashboard/intervjuer`));
      yield* openInterview(stalePage);
      yield* fillCorrection(stalePage, "Co-interviewer stale draft.", "Kanskje", {
        explanatoryPower: 7,
        roleModel: 7,
        suitability: 7,
      });
      yield* fillCorrection(co.page, "Co-interviewer newer correction.", "Nei", {
        explanatoryPower: 8,
        roleModel: 8,
        suitability: 8,
      });
      yield* submitBrowserCorrection(co.page);
      const staleBefore = yield* snapshot();
      const staleResponsePromise = waitForCorrection(stalePage);
      yield* step(() =>
        stalePage.getByRole("button", { name: "Rett intervju", exact: true }).click(),
      );
      yield* step(() => stalePage.getByRole("dialog").waitFor({ state: "visible" }));
      yield* step(() =>
        stalePage
          .getByRole("dialog")
          .getByRole("button", { name: "Rett intervju", exact: true })
          .press("Enter"),
      );
      const staleResponse = yield* step(() => staleResponsePromise);
      status("co-interviewer:stale", staleResponse.status());
      assert.equal(staleResponse.status(), 409, yield* step(() => staleResponse.text()));
      yield* step(() =>
        stalePage
          .getByText(
            "Intervjuet er endret. Utkastet er beholdt; åpne intervjuet på nytt for å hente gjeldende versjon.",
            { exact: true },
          )
          .waitFor(),
      );
      assert.equal(
        yield* step(() =>
          stalePage.locator("#question-interview-schema-native-conduct-0063-q0").inputValue(),
        ),
        "Co-interviewer stale draft.",
      );
      assert.equal(
        yield* step(() => stalePage.locator("#interviewer-recommendation").inputValue()),
        "Kanskje",
      );
      yield* assertUnchanged(staleBefore, "co-interviewer stale correction");
    }).pipe(Effect.ensuring(step(() => staleContext.close()).pipe(Effect.orDie)));

    stage("co-interviewer stale browser command retains the visible draft and writes nothing");

    const replayBase = yield* getDetail(co.cookie);

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

    const firstReplay = yield* step(() =>
      postCorrection(co.cookie, acceptedReplay.payload, acceptedReplay.etag, acceptedReplay.key),
    );

    status("co-interviewer:replay-first", firstReplay.status);
    assert.equal(firstReplay.status, 200);
    const firstReplayBytes = yield* step(() => firstReplay.text());

    const exactReplay = yield* step(() =>
      postCorrection(co.cookie, acceptedReplay.payload, acceptedReplay.etag, acceptedReplay.key),
    );

    status("co-interviewer:replay-exact", exactReplay.status);
    assert.equal(exactReplay.status, 200);
    assert.equal(yield* step(() => exactReplay.text()), firstReplayBytes);
    stage("co-interviewer exact correction replay remains byte-stable");

    const concurrentBase = yield* getDetail(co.cookie);
    const writesBeforeConcurrent = yield* countWrites();
    const concurrentRecommendations: ReadonlyArray<"Ja" | "Nei"> = ["Ja", "Nei"];

    const concurrent = yield* Effect.all(
      concurrentRecommendations.map((recommendation, index) =>
        step(() =>
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
      ),
      { concurrency: "unbounded" },
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
    const writesAfterConcurrent = yield* countWrites();
    assert.deepEqual(writesAfterConcurrent, {
      assessments: writesBeforeConcurrent.assessments + 1,
      receipts: writesBeforeConcurrent.receipts + 1,
      audit: writesBeforeConcurrent.audit + 1,
      revision: writesBeforeConcurrent.revision + 1,
    });
    stage(
      "same-revision co-interviewer corrections produce one winner and one no-write stale loser",
    );

    const boundaryResult = yield* assertInterviewCorrectionBoundaries({
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

    yield* assertInterviewCorrectionIntegrity({
      pool,
      interviewId: fixture.targetInterviewId,
      expectedCorrectedByPersonId: fixture.coInterviewer.personId,
      expectedCoInterviewerPersonId: fixture.coInterviewer.personId,
    });
    assert.deepEqual(yield* effectSnapshot(), effectsBefore);
    const primaryFinal = yield* getDetail(primaryCookie);
    const coFinal = yield* getDetail(co.cookie);
    assert.deepEqual(sharedAssessment(primaryFinal.body), sharedAssessment(coFinal.body));
    stage(
      "denial, revocation, exact replay, rollback, native receipt, and SQL correction integrity gates preserve one shared aggregate with no effects",
    );

    yield* step(() => co.page.setViewportSize({ width: 1280, height: 900 }));
    yield* step(() =>
      co.page
        .locator(".fs-conduct")
        .screenshot({ path: path.join(artifacts, "co-interviewer-correction-desktop.png") }),
    );
    assert.deepEqual(yield* auditPage(co.page, "co-interviewer-correction-desktop"), []);
    yield* step(() => co.page.setViewportSize({ width: 390, height: 844 }));
    assert.ok(
      (yield* step(() =>
        co.page.locator("html").evaluate((element: HTMLElement) => element.scrollWidth),
      )) <= 390,
      "co-interviewer correction must fit the mobile viewport",
    );
    yield* step(() =>
      co.page
        .locator(".fs-conduct")
        .screenshot({ path: path.join(artifacts, "co-interviewer-correction-mobile.png") }),
    );
    assert.deepEqual(yield* auditPage(co.page, "co-interviewer-correction-mobile"), []);
    yield* step(() => co.page.setViewportSize({ width: 1280, height: 900 }));
    assert.deepEqual(errors, []);
    stage("co-interviewer desktop and mobile correction surfaces pass Axe without page errors");

    const result: CoInterviewerCorrectionJourneyResult = {
      stages,
      statuses,
      boundaryStatuses: boundaryResult.statuses,
      correctionRevision: coFinal.body.revision,
      coInterviewerPersonId: fixture.coInterviewer.personId,
    };

    yield* fs.writeFileString(
      path.join(artifacts, "co-interviewer-targeted-evidence.json"),
      yield* indentedJsonText({
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
      }),
    );

    return result;
  }).pipe(Effect.ensuring(step(() => co.browserContext.close()).pipe(Effect.orDie)));
});
