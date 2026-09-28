import { decodePostgresObservations, type PostgresObservation } from "./postgres-observation.js";
import { NativeProblem } from "../../packages/rpc/src/problem.js";
import { replacedFetch, replacedHttpResponse } from "../../apps/dashboard/e2e/native-rpc-ledger.js";
import { RecruitmentInterviewConductObservationSchema } from "../../packages/domain/src/recruitment/schema.js";
import { Effect, Fiber, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { jsonText, type JourneyStepFailed, step } from "./journey-step.ts";

type CorrectionRequestHeaders = {
  origin: string;
  cookie?: string;
  "if-match"?: string;
  "idempotency-key"?: string;
};

export type InterviewCorrectionReplayRequest = Readonly<{
  key: string;
  etag: string;
  payload: {
    expectedRevision: number;
    answers: Detail["answers"];
    score: { explanatoryPower: number; roleModel: number; suitability: number };
    recommendation: "Ja" | "Kanskje" | "Nei";
  };
}>;

export type InterviewCorrectionParticipantRole = "primary" | "co";

export type InterviewCorrectionBoundaryContext = Readonly<{
  pool: Pool;
  api: string;
  origin: string;
  cookie: string;
  interviewId: string;
  actorPersonId: string;
  otherPersonId: string;
  membershipId: string;
  selfLinkRaceInterviewId: string;
  acceptedReplay: InterviewCorrectionReplayRequest;
  participantRole?: InterviewCorrectionParticipantRole;
  recordGate?: (...observations: string[]) => void;
}>;

export type InterviewCorrectionBoundaryResult = Readonly<{
  gates: ReadonlyArray<string>;
  statuses: Readonly<Record<string, number>>;
}>;

type Detail = typeof RecruitmentInterviewConductObservationSchema.Type;

type OwnedSnapshot = Readonly<Record<string, ReadonlyArray<PostgresObservation>>>;

type Mutation = (client: PoolClient) => Effect.Effect<void, JourneyStepFailed>;

/** Runs one statement of a setup or restore mutation on the connection. */
const execute = (
  client: PoolClient,
  text: string,
  values?: ReadonlyArray<unknown>,
): Effect.Effect<void, JourneyStepFailed> =>
  step(() => client.query(text, values === undefined ? undefined : [...values])).pipe(
    Effect.asVoid,
  );

/**
 * Runs the cleanup after the body however the body ends. A failed cleanup fails the whole, as a
 * `finally` block that throws does; otherwise the outcome of the body stands.
 */
const withCleanup = <A, E, R, E2, R2>(
  body: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<void, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.gen(function* () {
    const outcome = yield* Effect.exit(body);

    yield* cleanup;

    return yield* outcome;
  });

const freshId = (prefix: string) => `${prefix}-${randomBytes(8).toString("hex")}`;

export const assertInterviewCorrectionBoundaries = Effect.fnUntraced(function* (
  context: InterviewCorrectionBoundaryContext,
) {
  const {
    pool,
    api,
    origin,
    cookie,
    interviewId,
    actorPersonId,
    otherPersonId,
    membershipId,
    selfLinkRaceInterviewId,
    acceptedReplay,
    participantRole = "primary",
  } = context;

  const gates: string[] = [];
  const statuses: Record<string, number> = {};

  const record = (...observations: string[]) => {
    gates.push(...observations);
    context.recordGate?.(...observations);
  };

  const status = (name: string, value: number) => {
    statuses[name] = value;

    return value;
  };

  assert.notEqual(actorPersonId, otherPersonId, "authority fixture needs two distinct persons");

  const identityRows = yield* step(() =>
    pool.query(
      `SELECT i.interview_id AS "interviewId", i.interviewer_person_id AS "interviewerPersonId",
            i.co_interviewer_person_id AS "coInterviewerPersonId",
            a.applicant_id AS "applicantId", a.application_id AS "applicationId",
            i.department_id AS "departmentId",
            l.person_id AS "linkedPersonId"
       FROM public.recruitment_interviews i
       JOIN public.admission_applications a USING(application_id)
       LEFT JOIN public.applicant_account_links l USING(applicant_id)
      WHERE i.interview_id = ANY($1::text[])
      ORDER BY i.interview_id`,
      [[interviewId, selfLinkRaceInterviewId]],
    ),
  );

  assert.equal(
    identityRows.rows.length,
    2,
    "correction fixtures must expose primary and race interviews",
  );

  const identities = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        interviewId: Schema.String,
        interviewerPersonId: Schema.String,
        coInterviewerPersonId: Schema.NullOr(Schema.String),
        applicantId: Schema.String,
        applicationId: Schema.String,
        departmentId: Schema.String,
        linkedPersonId: Schema.NullOr(Schema.String),
      }),
    ),
  )(identityRows.rows);

  const identityById = new Map(identities.map((row) => [row.interviewId, row]));

  const identity = identityById.get(interviewId);
  const raceIdentity = identityById.get(selfLinkRaceInterviewId);
  assert.ok(identity && raceIdentity);
  assert.equal(identity.linkedPersonId, null, "target correction fixture must start unlinked");
  assert.equal(raceIdentity.linkedPersonId, null, "self-link race fixture must start unlinked");

  const participantColumn =
    participantRole === "primary" ? "interviewer_person_id" : "co_interviewer_person_id";

  const participantField =
    participantRole === "primary" ? "interviewerPersonId" : "coInterviewerPersonId";

  assert.equal(
    identity[participantField],
    actorPersonId,
    `target correction fixture must designate the ${participantRole} actor`,
  );
  assert.equal(
    raceIdentity[participantField],
    actorPersonId,
    `self-link race fixture must designate the ${participantRole} actor`,
  );

  const departments = yield* step(() =>
    pool.query(
      `SELECT department_id AS "departmentId"
       FROM public.admission_period_departments
      WHERE department_id <> $1
      ORDER BY department_id
      LIMIT 1`,
      [identity.departmentId],
    ),
  );

  const differentDepartment = yield* Schema.decodeUnknownEffect(Schema.String)(
    departments.rows[0]?.departmentId,
  );

  assert.ok(differentDepartment, "authority matrix needs a second admission department");

  const headers = (requestCookie: string | null | undefined, etag?: string, key?: string) => {
    const result: CorrectionRequestHeaders = { origin: origin };

    if (requestCookie !== null && requestCookie !== undefined) result.cookie = requestCookie;

    if (etag !== undefined) result["if-match"] = etag;

    if (key !== undefined) result["idempotency-key"] = key;

    return result;
  };

  // Each call is the RPC that replaced the route, answered as that route's HTTP response.
  const get = (id: string, requestCookie: string | null = cookie) =>
    replacedFetch({
      origin: api,
      tag: "recruitment.readInterviewConduct",
      payload: { interviewId: id },
      headers: headers(requestCookie),
    });

  const post = (
    id: string,
    body: Schema.Json,
    etag: string,
    key: string,
    requestCookie: string | null = cookie,
  ) =>
    replacedFetch({
      origin: api,
      tag: "recruitment.correctInterviewAssessment",
      payload: { interviewId: id, idempotencyKey: key, ifMatch: etag, request: body },
      headers: headers(requestCookie),
    });

  /** A body that is no RPC request message at all, posted to the RPC endpoint. */
  const postRaw = (
    _id: string,
    body: string,
    _etag: string,
    _key: string,
    requestCookie: string | null = cookie,
  ) =>
    Effect.gen(function* () {
      const answer = yield* HttpClient.execute(
        HttpClientRequest.post(`${api}/api/rpc`).pipe(
          HttpClientRequest.setHeaders(headers(requestCookie)),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      );

      const text = yield* answer.text;

      return yield* step(() => replacedHttpResponse(new Response(text, { status: answer.status })));
    });

  const interviewIds = [interviewId, selfLinkRaceInterviewId];
  const applicantIds = [identity.applicantId, raceIdentity.applicantId];
  const departmentIds = [identity.departmentId, differentDepartment];

  const readRows = Effect.fnUntraced(function* (query: string, values: readonly unknown[] = []) {
    return decodePostgresObservations((yield* step(() => pool.query(query, [...values]))).rows);
  });

  /**
   * Borrows a pool connection for the use, rolls back whatever transaction the use left open,
   * and returns the connection however the use ends.
   */
  const withConnection = <A, E, R>(use: (client: PoolClient) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      step(() => pool.connect()),
      (client) =>
        use(client).pipe(Effect.ensuring(step(() => client.query("ROLLBACK")).pipe(Effect.ignore))),
      (client) => Effect.sync(() => client.release()),
    );

  /** Exact rows, not counts: failed requests must not create a receipt or alter any owned state. */
  const snapshot = Effect.fnUntraced(function* () {
    return {
      interviews: yield* readRows(
        `SELECT interview_id, application_id, department_id, interviewer_person_id,
              co_interviewer_person_id, interview_schema_id, assigned_by_person_id, assigned_at, revision
         FROM public.recruitment_interviews
        WHERE interview_id = ANY($1::text[])
        ORDER BY interview_id`,
        [interviewIds],
      ),
      corrections: yield* readRows(
        `SELECT interview_id, predecessor_revision, resulting_revision, answers,
              explanatory_power, role_model, suitability, recommendation,
              corrected_by_person_id, corrected_at, command_id
         FROM public.recruitment_interview_correction_assessments
        WHERE interview_id = ANY($1::text[])
        ORDER BY interview_id, resulting_revision`,
        [interviewIds],
      ),
      correctionReceipts: yield* readRows(
        `SELECT command_id, command_sha256, command_json, observation_json, interview_id,
              predecessor_revision, resulting_revision, committed_at
         FROM public.recruitment_interview_correction_command_receipts
        WHERE interview_id = ANY($1::text[])
        ORDER BY interview_id, resulting_revision, command_id`,
        [interviewIds],
      ),
      correctionAudit: yield* readRows(
        `SELECT command_id, interview_id, actor_person_id, predecessor_revision,
              resulting_revision, occurred_at
         FROM public.recruitment_interview_correction_audit
        WHERE interview_id = ANY($1::text[])
        ORDER BY interview_id, resulting_revision, command_id`,
        [interviewIds],
      ),
      nativeHttpReceipts: yield* readRows(
        `SELECT identity_sha256, request_sha256, operation_id, state, status, media_type,
              encode(body_bytes, 'hex') AS body_hex, headers_json, committed_at,
              full_expires_at, tombstoned_at
         FROM public.native_http_idempotency_receipts
        WHERE operation_id = 'recruitment.correctInterviewAssessment'
        ORDER BY identity_sha256`,
      ),
      applicantLinks: yield* readRows(
        `SELECT applicant_id, person_id, linked_at, invitation_id
         FROM public.applicant_account_links
        WHERE applicant_id = ANY($1::text[])
        ORDER BY applicant_id`,
        [applicantIds],
      ),
      applicantInvitations: yield* readRows(
        `SELECT invitation_id, application_id, applicant_id, token_digest, expires_at,
              state, issued_by, issued_at
         FROM public.applicant_account_invitations
        WHERE applicant_id = ANY($1::text[])
        ORDER BY applicant_id, invitation_id`,
        [applicantIds],
      ),
      memberships: yield* readRows(
        `SELECT membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
              position_id, is_team_leader, is_suspended, revision
         FROM public.organization_memberships
        WHERE membership_id = $1`,
        [membershipId],
      ),
      departments: yield* readRows(
        `SELECT department_id, name, short_name, email, address, city, latitude,
              longitude, slack_channel, logo_path, active, revision
         FROM public.organization_departments
        WHERE department_id = ANY($1::text[])
        ORDER BY department_id`,
        [departmentIds],
      ),
      sessions: yield* readRows(
        `SELECT id, "expiresAt", md5(token) AS token_digest, "createdAt", "updatedAt",
              "ipAddress", "userAgent", "userId"
         FROM auth."session"
        WHERE "userId" = $1
        ORDER BY id`,
        [actorPersonId],
      ),
    };
  });

  const assertSnapshot = Effect.fnUntraced(function* (before: OwnedSnapshot, label: string) {
    const after = yield* snapshot();
    assert.deepEqual(after, before, `${label} changed owned state`);
  });

  const assertCorrectionRowsUnchanged = (
    before: OwnedSnapshot,
    after: OwnedSnapshot,
    label: string,
  ) => {
    for (const key of [
      "interviews",
      "corrections",
      "correctionReceipts",
      "correctionAudit",
      "nativeHttpReceipts",
    ] as const)
      assert.deepEqual(after[key], before[key], `${label} changed ${key}`);
  };

  /**
   * A setup mutation must be visible to the API's separate connection. It is
   * restored before this function returns, and every connection is rolled
   * back in finally even after an assertion or restoration error.
   */
  const withMutation = <A, E, R>(
    mutate: Mutation,
    restore: Mutation,
    action: () => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const before = yield* snapshot();

      return yield* withConnection((client) =>
        Effect.gen(function* () {
          yield* step(() => client.query("BEGIN"));
          yield* mutate(client);
          yield* step(() => client.query("COMMIT"));

          const outcome = yield* Effect.exit(action());

          yield* step(() => client.query("BEGIN"));
          yield* restore(client);
          yield* step(() => client.query("COMMIT"));
          yield* assertSnapshot(before, "mutation restoration");

          return yield* outcome;
        }),
      );
    });

  const detail = Effect.fnUntraced(function* () {
    const response = yield* step(() => get(interviewId));
    status("detail", response.status);
    assert.equal(response.status, 200, yield* step(() => response.clone().text()));
    const etag = response.headers.get("etag");

    if (etag === null) throw new Error("detail response did not include an ETag");

    return {
      body: yield* Schema.decodeUnknownEffect(RecruitmentInterviewConductObservationSchema)(
        yield* step(() => response.json()),
      ),
      etag,
    };
  });

  const validPayload = (body: Detail) => ({
    expectedRevision: body.revision,
    answers: body.answers,
    score: body.score ?? { explanatoryPower: 0, roleModel: 0, suitability: 0 },
    recommendation: body.recommendation ?? "Ja",
  });

  const denied = Effect.fnUntraced(function* (
    name: string,
    expected: 401 | 403,
    requestCookie: string | null,
    body: Detail,
    etag: string,
  ) {
    const before = yield* snapshot();
    const read = yield* step(() => get(interviewId, requestCookie));
    status(`${name}:read`, read.status);
    assert.equal(read.status, expected, `${name} read: ${yield* step(() => read.text())}`);

    const write = yield* step(() =>
      post(
        interviewId,
        validPayload(body),
        etag,
        freshId(`correction-boundary-${name}`),
        requestCookie,
      ),
    );

    status(`${name}:write`, write.status);
    assert.equal(write.status, expected, `${name} write: ${yield* step(() => write.text())}`);

    const replay = yield* step(() =>
      post(
        interviewId,
        acceptedReplay.payload,
        acceptedReplay.etag,
        acceptedReplay.key,
        requestCookie,
      ),
    );

    status(`${name}:replay`, replay.status);
    assert.equal(replay.status, expected, `${name} replay: ${yield* step(() => replay.text())}`);
    yield* assertSnapshot(before, name);
  });

  const initial = yield* detail();
  yield* denied("missing-credential", 401, null, initial.body, initial.etag);
  record("anonymous detail and correction deny with no native receipt or domain writes");
  const originalInterview = identity;
  assert.equal(originalInterview.interviewId, interviewId);
  yield* withMutation(
    (client) =>
      execute(
        client,
        `UPDATE public.recruitment_interviews
              SET ${participantColumn}=$1
            WHERE interview_id=$2`,
        [otherPersonId, interviewId],
      ),
    (client) =>
      execute(
        client,
        `UPDATE public.recruitment_interviews
              SET ${participantColumn}=$1
            WHERE interview_id=$2`,
        [originalInterview[participantField], interviewId],
      ),
    () => denied(`wrong-${participantRole}-participant`, 403, cookie, initial.body, initial.etag),
  );
  record(`removed ${participantRole} participant designation denies detail and correction`);

  const originalMembership = (yield* readRows(
    `SELECT membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
            position_id, is_team_leader, is_suspended, revision
       FROM public.organization_memberships
      WHERE membership_id=$1`,
    [membershipId],
  ))[0];

  assert.ok(originalMembership);
  yield* withMutation(
    (client) =>
      execute(
        client,
        `UPDATE public.organization_memberships
              SET end_at = start_at + interval '1 second'
            WHERE membership_id=$1`,
        [membershipId],
      ),
    (client) =>
      execute(
        client,
        `UPDATE public.organization_memberships
              SET end_at=$1
            WHERE membership_id=$2`,
        [originalMembership.end_at, membershipId],
      ),
    () => denied("ended-membership", 403, cookie, initial.body, initial.etag),
  );
  record("ended membership denies detail and correction");

  yield* withMutation(
    (client) =>
      execute(
        client,
        `UPDATE public.organization_memberships
              SET is_suspended=true
            WHERE membership_id=$1`,
        [membershipId],
      ),
    (client) =>
      execute(
        client,
        `UPDATE public.organization_memberships
              SET is_suspended=$1
            WHERE membership_id=$2`,
        [originalMembership.is_suspended, membershipId],
      ),
    () => denied("suspended-membership", 403, cookie, initial.body, initial.etag),
  );
  record("suspended membership denies detail and correction");

  const actorSessions = yield* readRows(
    `SELECT id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"
       FROM auth."session"
      WHERE "userId" = $1
      ORDER BY id`,
    [actorPersonId],
  );

  assert.ok(actorSessions.length > 0, "authority fixture must provide an actor session");
  yield* withMutation(
    (client) => execute(client, `DELETE FROM auth."session" WHERE "userId"=$1`, [actorPersonId]),
    (client) =>
      Effect.forEach(
        actorSessions,
        (session) =>
          execute(
            client,
            `INSERT INTO auth."session"
             (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              session.id,
              session["expiresAt"],
              session.token,
              session["createdAt"],
              session["updatedAt"],
              session["ipAddress"],
              session["userAgent"],
              session["userId"],
            ],
          ),
        { discard: true },
      ),
    () => denied("revoked-credential", 401, cookie, initial.body, initial.etag),
  );
  record(
    "actual actor-session deletion denies detail and correction, then restores exact session rows",
  );

  const originalDepartment = (yield* readRows(
    `SELECT department_id, name, short_name, email, address, city, latitude,
            longitude, slack_channel, logo_path, active, revision
       FROM public.organization_departments
      WHERE department_id=$1`,
    [identity.departmentId],
  ))[0];

  assert.ok(originalDepartment);
  yield* withMutation(
    (client) =>
      execute(
        client,
        `UPDATE public.organization_departments SET active=false WHERE department_id=$1`,
        [identity.departmentId],
      ),
    (client) =>
      execute(
        client,
        `UPDATE public.organization_departments SET active=$1 WHERE department_id=$2`,
        [originalDepartment.active, identity.departmentId],
      ),
    () => denied("inactive-department", 403, cookie, initial.body, initial.etag),
  );
  record("inactive department denies detail and correction");

  yield* withMutation(
    (client) =>
      execute(
        client,
        `UPDATE public.recruitment_interviews SET department_id=$1 WHERE interview_id=$2`,
        [differentDepartment, interviewId],
      ),
    (client) =>
      execute(
        client,
        `UPDATE public.recruitment_interviews SET department_id=$1 WHERE interview_id=$2`,
        [originalInterview.departmentId, interviewId],
      ),
    () => denied("wrong-department", 403, cookie, initial.body, initial.etag),
  );
  record("wrong department denies detail and correction");

  const detailFor = Effect.fnUntraced(function* (id: string) {
    const response = yield* step(() => get(id));

    if (response.status !== 200) {
      const diagnostic = yield* step(() =>
        pool.query(
          `SELECT i.interview_id, i.department_id, i.interviewer_person_id,
                i.co_interviewer_person_id, link.person_id AS linked_applicant_person_id,
                EXISTS (
                  SELECT 1 FROM public.recruitment_interview_conducts AS conduct
                  WHERE conduct.interview_id=i.interview_id
                ) AS has_conduct,
                EXISTS (
                  SELECT 1
                    FROM public.organization_memberships AS membership
                    JOIN public.organization_teams AS team USING(team_id)
                    JOIN public.organization_departments AS department USING(department_id)
                   WHERE membership.person_id=$2
                     AND team.department_id=i.department_id
                     AND membership.end_at IS NULL
                     AND NOT membership.is_suspended
                     AND team.active
                     AND department.active
                ) AS active_member
           FROM public.recruitment_interviews AS i
           JOIN public.admission_applications AS application USING(application_id)
           LEFT JOIN public.applicant_account_links AS link USING(applicant_id)
          WHERE i.interview_id=$1`,
          [id, actorPersonId],
        ),
      );

      const refusal = yield* step(() => response.text());
      const source = yield* jsonText(diagnostic.rows);

      assert.fail(`detail ${id} returned ${response.status}: ${refusal}; source=${source}`);
    }

    const etag = response.headers.get("etag");

    if (etag === null) throw new Error("detail response did not include an ETag");

    return {
      body: yield* Schema.decodeUnknownEffect(RecruitmentInterviewConductObservationSchema)(
        yield* step(() => response.json()),
      ),
      etag,
    };
  });

  const raceSeed = yield* detailFor(selfLinkRaceInterviewId);

  const raceSeedPayload = {
    ...acceptedReplay.payload,
    expectedRevision: raceSeed.body.revision,
  };

  const raceSeedKey = freshId("correction-boundary-self-link-seed");

  const raceSeedResponse = yield* step(() =>
    post(selfLinkRaceInterviewId, raceSeedPayload, raceSeed.etag, raceSeedKey),
  );

  status("self-link-seed:write", raceSeedResponse.status);
  assert.equal(raceSeedResponse.status, 200, yield* step(() => raceSeedResponse.text()));
  const acceptedRaceReplay = { key: raceSeedKey, etag: raceSeed.etag, payload: raceSeedPayload };
  const raceFresh = yield* detailFor(selfLinkRaceInterviewId);
  const racePayload = validPayload(raceFresh.body);
  const raceBefore = yield* snapshot();
  const raceInvitation = freshId("correction-boundary-self-link-race");

  yield* withConnection((locker) =>
    Effect.gen(function* () {
      yield* step(() => locker.query("BEGIN"));
      yield* step(() =>
        locker.query(
          `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id=$1 FOR UPDATE`,
          [raceIdentity.applicantId],
        ),
      );

      const exactReplayWaiting = yield* Effect.forkChild(
        step(() =>
          post(
            selfLinkRaceInterviewId,
            acceptedRaceReplay.payload,
            acceptedRaceReplay.etag,
            acceptedRaceReplay.key,
          ),
        ),
      );

      const lockerPid = Number(
        (yield* step(() => locker.query("SELECT pg_backend_pid() AS pid"))).rows[0].pid,
      );

      let exactReplayBlocked = false;

      for (let attempt = 0; attempt < 100; attempt++) {
        const blockingRows = yield* step(() =>
          pool.query(
            `SELECT pid FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
            [lockerPid],
          ),
        );

        if (blockingRows.rows.length > 0) {
          exactReplayBlocked = true;
          break;
        }

        yield* Effect.sleep("10 millis");
      }

      assert.ok(
        exactReplayBlocked,
        `exact replay was not blocked by canonical applicant lock lockerPid=${lockerPid}`,
      );

      const waiting = yield* Effect.forkChild(
        step(() =>
          post(
            selfLinkRaceInterviewId,
            racePayload,
            raceFresh.etag,
            freshId("correction-boundary-self-link-race-request"),
          ),
        ),
      );

      yield* step(() =>
        locker.query(
          `INSERT INTO public.applicant_account_invitations
         (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at)
       VALUES ($1,$2,$3,$4,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+interval '24 hours','Claimed',$5,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
          [
            raceInvitation,
            raceIdentity.applicationId,
            raceIdentity.applicantId,
            createHash("sha256").update(raceInvitation).digest("hex"),
            actorPersonId,
          ],
        ),
      );
      yield* step(() =>
        locker.query(
          `INSERT INTO public.applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
       VALUES ($1,$2,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),$3)`,
          [raceIdentity.applicantId, actorPersonId, raceInvitation],
        ),
      );
      yield* step(() => locker.query("COMMIT"));
      const exactReplayResponse = yield* Fiber.join(exactReplayWaiting);
      status("self-link-race:exact-replay-while-committing", exactReplayResponse.status);

      const exactReplayBody = yield* Schema.decodeUnknownEffect(NativeProblem)(
        yield* step(() => exactReplayResponse.json()),
      );

      assert.ok([403, 409].includes(exactReplayResponse.status), yield* jsonText(exactReplayBody));

      if (exactReplayResponse.status === 409) {
        assert.equal(exactReplayBody.code, "transaction.conflict");
      }

      const raceResponse = yield* Fiber.join(waiting);
      status("self-link-race:write", raceResponse.status);

      const raceBody = yield* Schema.decodeUnknownEffect(NativeProblem)(
        yield* step(() => raceResponse.json()),
      );

      assert.ok([403, 409].includes(raceResponse.status), yield* jsonText(raceBody));

      if (raceResponse.status === 409) assert.equal(raceBody.code, "transaction.conflict");
      const deniedRead = yield* step(() => get(selfLinkRaceInterviewId));
      status("self-link-race:read-after-commit", deniedRead.status);
      assert.equal(deniedRead.status, 403, yield* step(() => deniedRead.text()));

      const replay = yield* step(() =>
        post(
          selfLinkRaceInterviewId,
          acceptedRaceReplay.payload,
          acceptedRaceReplay.etag,
          acceptedRaceReplay.key,
        ),
      );

      status("self-link-race:replay", replay.status);
      assert.equal(replay.status, 403, yield* step(() => replay.text()));
      const raceAfterResponse = yield* snapshot();
      assertCorrectionRowsUnchanged(raceBefore, raceAfterResponse, "self-link race response");
    }),
  );

  record(
    "genuine accepted self-link fixture correction is denied or transaction-conflicted after committed self-link; fresh read and exact replay deny",
  );

  const current = yield* detail();
  const currentPayload = validPayload(current.body);
  const currentAnswers = currentPayload.answers;
  assert.ok(
    Array.isArray(currentAnswers) && currentAnswers.length >= 2,
    "invalid answer probes need two answers",
  );
  const answerRows = currentAnswers;

  const invalidCases: ReadonlyArray<readonly [string, Schema.Json]> = [
    ["malformed-json", "{"],
    [
      "unknown-question-same-cardinality",
      {
        ...currentPayload,
        answers: answerRows.map((answer, index) =>
          index === 0 ? { ...answer, questionId: freshId("unknown-question") } : answer,
        ),
      },
    ],
    [
      "duplicate-question-same-cardinality",
      {
        ...currentPayload,
        answers: answerRows.map((answer, index) =>
          index === 1 ? { ...answer, questionId: answerRows[0]!.questionId } : answer,
        ),
      },
    ],
    [
      "missing-answer",
      {
        ...currentPayload,
        answers: answerRows.map((answer, index) =>
          index === 0
            ? Object.fromEntries(Object.entries(answer).filter(([key]) => key !== "answer"))
            : answer,
        ),
      },
    ],
    ["missing-question-entry", { ...currentPayload, answers: answerRows.slice(1) }],
    ["invalid-recommendation", { ...currentPayload, recommendation: "Maybe" }],
    ["fractional-score", { ...currentPayload, score: { ...currentPayload.score, roleModel: 1.5 } }],
    [
      "score-out-of-range",
      { ...currentPayload, score: { ...currentPayload.score, explanatoryPower: 11 } },
    ],
    ["null-recommendation", { ...currentPayload, recommendation: null }],
  ];

  const semanticInvalidCases = new Set([
    "unknown-question-same-cardinality",
    "duplicate-question-same-cardinality",
    "missing-question-entry",
  ]);

  const decodeMalformed = Schema.decodeOption(
    Schema.fromJsonString(Schema.Struct({ code: Schema.Literal("request.malformed") })),
  );

  for (const [name, invalid] of invalidCases) {
    const before = yield* snapshot();

    const response =
      name === "malformed-json"
        ? yield* postRaw(
            interviewId,
            yield* Schema.decodeUnknownEffect(Schema.String)(invalid),
            current.etag,
            freshId(`correction-boundary-invalid-${name}`),
          )
        : yield* step(() =>
            post(
              interviewId,
              invalid,
              current.etag,
              freshId(`correction-boundary-invalid-${name}`),
            ),
          );

    status(`invalid:${name}`, response.status);

    // Domain validation of the answers still answers recruitment.conduct-invalid (422). A payload
    // outside its schema fails in the RPC server before the handler, as a defect (500). A body that
    // is not JSON is refused by the ingress before any RPC runs, as request.malformed (400).
    if (name === "malformed-json") {
      const refusal = yield* step(() => response.text());

      assert.equal(response.status, 400, refusal);

      assert.ok(Option.isSome(decodeMalformed(refusal)), refusal);
    } else {
      assert.equal(
        response.status,
        semanticInvalidCases.has(name) ? 422 : 500,
        yield* step(() => response.text()),
      );
    }

    yield* assertSnapshot(before, `invalid ${name}`);
  }

  record(
    "malformed RPC bodies and schema failures are refused before the handler, and answer mismatches map to 422; each leaves exact state unchanged",
  );
  const sameKeyBefore = yield* snapshot();

  const conflictingPayload = {
    ...currentPayload,
    recommendation: currentPayload.recommendation === "Nei" ? "Ja" : "Nei",
  };

  const sameKeyResponse = yield* step(() =>
    post(interviewId, conflictingPayload, current.etag, acceptedReplay.key),
  );

  status("same-key-different-payload", sameKeyResponse.status);
  assert.equal(sameKeyResponse.status, 409, yield* step(() => sameKeyResponse.text()));
  yield* assertSnapshot(sameKeyBefore, "same-key different payload");
  record(
    "same idempotency key with a different payload returns digest conflict without any owned write",
  );
  const rollbackSuffix = randomBytes(8).toString("hex");
  const rollbackSequence = `test_correction_failure_${rollbackSuffix}_seq`;
  const rollbackControl = `test_correction_failure_${rollbackSuffix}_control`;
  const rollbackFunction = `test_correction_failure_${rollbackSuffix}_fn`;

  const rollbackTriggers = [
    ["aggregate-revision", "recruitment_interviews", "1", "UPDATE OF revision"],
    ["assessment", "recruitment_interview_correction_assessments", "2", "INSERT"],
    ["domain-receipt", "recruitment_interview_correction_command_receipts", "3", "INSERT"],
    ["audit", "recruitment_interview_correction_audit", "4", "INSERT"],
  ] as const;

  const quote = (identifier: string) => `"${identifier}"`;
  yield* withConnection((rollbackClient) =>
    Effect.gen(function* () {
      yield* step(() => rollbackClient.query("BEGIN"));
      yield* step(() => rollbackClient.query(`CREATE SEQUENCE public.${quote(rollbackSequence)}`));
      yield* step(() =>
        rollbackClient.query(
          `CREATE TABLE public.${quote(rollbackControl)} (stage integer NOT NULL CHECK (stage BETWEEN 1 AND 4))`,
        ),
      );
      yield* step(() =>
        rollbackClient.query(`INSERT INTO public.${quote(rollbackControl)} (stage) VALUES (1)`),
      );
      yield* step(() =>
        rollbackClient.query(`
      CREATE FUNCTION public.${quote(rollbackFunction)}() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE configured integer;
      BEGIN
        PERFORM nextval('public.${rollbackSequence}');
        SELECT stage INTO configured FROM public.${rollbackControl} LIMIT 1;
        IF configured = TG_ARGV[0]::integer THEN
          RAISE EXCEPTION 'interview correction rollback probe stage %', configured;
        END IF;
        RETURN NEW;
      END $$;
    `),
      );

      for (const [, table, stage, event] of rollbackTriggers) {
        yield* step(() =>
          rollbackClient.query(
            `CREATE TRIGGER ${quote(`${rollbackFunction}_${stage}`)} AFTER ${event} ON public.${table}
         FOR EACH ROW EXECUTE FUNCTION public.${quote(rollbackFunction)}('${stage}')`,
          ),
        );
      }

      yield* step(() => rollbackClient.query("COMMIT"));
    }),
  );

  yield* withCleanup(
    Effect.gen(function* () {
      for (const [name, , stage] of rollbackTriggers) {
        yield* withConnection((setup) =>
          Effect.gen(function* () {
            yield* step(() => setup.query("BEGIN"));
            yield* step(() =>
              setup.query(`UPDATE public.${quote(rollbackControl)} SET stage=$1`, [Number(stage)]),
            );
            yield* step(() =>
              setup.query(`ALTER SEQUENCE public.${quote(rollbackSequence)} RESTART WITH 1`),
            );
            yield* step(() => setup.query("COMMIT"));
          }),
        );

        const before = yield* snapshot();

        const response = yield* step(() =>
          post(
            interviewId,
            currentPayload,
            current.etag,
            freshId(`correction-boundary-rollback-${name}`),
          ),
        );

        status(`rollback:${name}`, response.status);

        const failureBody = yield* Schema.decodeUnknownEffect(NativeProblem)(
          yield* step(() => response.json()),
        );

        assert.equal(response.status, 503, yield* jsonText(failureBody));
        assert.equal(failureBody.code, "dependency.unavailable", yield* jsonText(failureBody));

        const marker = yield* step(() =>
          pool.query(`SELECT last_value, is_called FROM public.${quote(rollbackSequence)}`),
        );

        assert.equal(marker.rows[0]?.is_called, true, `${name} rollback marker did not fire`);
        assert.equal(
          Number(marker.rows[0]?.last_value),
          Number(stage),
          `${name} rollback probe stopped before injected stage`,
        );
        yield* assertSnapshot(before, `rollback after ${name}`);
      }

      record(
        "each aggregate, assessment, domain-receipt, and audit failure trigger fired and rolled back all domain and native HTTP receipt rows",
      );
    }),
    withConnection((cleanup) =>
      Effect.gen(function* () {
        yield* step(() => cleanup.query("BEGIN"));

        for (const [, table, stage] of rollbackTriggers) {
          yield* step(() =>
            cleanup.query(
              `DROP TRIGGER IF EXISTS ${quote(`${rollbackFunction}_${stage}`)} ON public.${table}`,
            ),
          );
        }

        yield* step(() =>
          cleanup.query(`DROP FUNCTION IF EXISTS public.${quote(rollbackFunction)}()`),
        );
        yield* step(() => cleanup.query(`DROP TABLE IF EXISTS public.${quote(rollbackControl)}`));
        yield* step(() =>
          cleanup.query(`DROP SEQUENCE IF EXISTS public.${quote(rollbackSequence)}`),
        );
        yield* step(() => cleanup.query("COMMIT"));
      }),
    ),
  );

  const differentLinkInvitation = freshId("correction-boundary-different-link");
  yield* withConnection((differentLinkClient) =>
    Effect.gen(function* () {
      yield* step(() => differentLinkClient.query("BEGIN"));
      yield* step(() =>
        differentLinkClient.query(
          `INSERT INTO public.applicant_account_invitations
         (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at)
       VALUES ($1,$2,$3,$4,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+interval '24 hours','Claimed',$5,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
          [
            differentLinkInvitation,
            identity.applicationId,
            identity.applicantId,
            createHash("sha256").update(differentLinkInvitation).digest("hex"),
            actorPersonId,
          ],
        ),
      );
      yield* step(() =>
        differentLinkClient.query(
          `INSERT INTO public.applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
       VALUES ($1,$2,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),$3)`,
          [identity.applicantId, otherPersonId, differentLinkInvitation],
        ),
      );
      yield* step(() => differentLinkClient.query("COMMIT"));
    }),
  );

  const differentRead = yield* step(() => get(interviewId));
  status("different-linked-person:read", differentRead.status);
  assert.equal(differentRead.status, 200, yield* step(() => differentRead.text()));
  record(
    "different-person applicant link is a committed teardown-owned fixture and remains readable without correction writes",
  );

  return { gates, statuses };
});
