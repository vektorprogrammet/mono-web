import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";


export type InterviewCorrectionReplayRequest = Readonly<{
  key: string;
  etag: string;
  payload: {
    expectedRevision: number;
    answers: unknown;
    score: { explanatoryPower: number; roleModel: number; suitability: number };
    recommendation: "Ja" | "Kanskje" | "Nei";
  };
}>;

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
  recordGate?: (...observations: string[]) => void;
}>;

export type InterviewCorrectionBoundaryResult = Readonly<{
  gates: ReadonlyArray<string>;
  statuses: Readonly<Record<string, number>>;
}>;

type Detail = {
  readonly answers: unknown;
  readonly score: { explanatoryPower: number; roleModel: number; suitability: number } | null;
  readonly recommendation: "Ja" | "Kanskje" | "Nei" | null;
  readonly revision: number;
};
type Row = Readonly<Record<string, unknown>>;
type OwnedSnapshot = Readonly<Record<string, ReadonlyArray<Row>>>;
type Mutation<T> = (client: PoolClient) => Promise<T>;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const freshId = (prefix: string) => `${prefix}-${randomBytes(8).toString("hex")}`;

export async function assertInterviewCorrectionBoundaries(
  context: InterviewCorrectionBoundaryContext,
): Promise<InterviewCorrectionBoundaryResult> {
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

  const identityRows = await pool.query(
    `SELECT i.interview_id AS "interviewId", i.interviewer_person_id AS "interviewerPersonId",
            a.applicant_id AS "applicantId", a.application_id AS "applicationId",
            i.department_id AS "departmentId",
            l.person_id AS "linkedPersonId"
       FROM public.recruitment_interviews i
       JOIN public.admission_applications a USING(application_id)
       LEFT JOIN public.applicant_account_links l USING(applicant_id)
      WHERE i.interview_id = ANY($1::text[])
      ORDER BY i.interview_id`,
    [[interviewId, selfLinkRaceInterviewId]],
  );
  assert.equal(identityRows.rows.length, 2, "correction fixtures must expose primary and race interviews");
  const identityById = new Map(
    identityRows.rows.map((row) => [row.interviewId as string, row as Row]),
  );
  const identity = identityById.get(interviewId);
  const raceIdentity = identityById.get(selfLinkRaceInterviewId);
  assert.ok(identity && raceIdentity);
  assert.equal(identity.linkedPersonId, null, "target correction fixture must start unlinked");
  assert.equal(raceIdentity.linkedPersonId, null, "self-link race fixture must start unlinked");

  const departments = await pool.query(
    `SELECT department_id AS "departmentId"
       FROM public.admission_period_departments
      WHERE department_id <> $1
      ORDER BY department_id
      LIMIT 1`,
    [identity.departmentId],
  );
  const differentDepartment = departments.rows[0]?.departmentId as string | undefined;
  assert.ok(differentDepartment, "authority matrix needs a second admission department");

  const headers = (requestCookie: string | null | undefined, etag?: string, key?: string) => ({
    origin,
    ...(requestCookie === null || requestCookie === undefined ? {} : { cookie: requestCookie }),
    ...(etag === undefined ? {} : { "if-match": etag }),
    ...(key === undefined ? {} : { "idempotency-key": key }),
  });
  const get = (id: string, requestCookie: string | null = cookie) =>
    fetch(`${api}/api/recruitment/interviews/${id}`, {
      headers: headers(requestCookie),
    });
  const post = (
    id: string,
    body: unknown,
    etag: string,
    key: string,
    requestCookie: string | null = cookie,
  ) =>
    fetch(`${api}/api/recruitment/interviews/${id}:correct`, {
      method: "POST",
      headers: {
        ...headers(requestCookie, etag, key),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const postRaw = (
    id: string,
    body: string,
    etag: string,
    key: string,
    requestCookie: string | null = cookie,
  ) =>
    fetch(`${api}/api/recruitment/interviews/${id}:correct`, {
      method: "POST",
      headers: {
        ...headers(requestCookie, etag, key),
        "content-type": "application/json",
      },
      body,
    });

  const interviewIds = [interviewId, selfLinkRaceInterviewId];
  const applicantIds = [identity.applicantId as string, raceIdentity.applicantId as string];
  const departmentIds = [identity.departmentId as string, differentDepartment];
  const readRows = async (query: string, values: readonly unknown[] = []) =>
    (await pool.query(query, [...values])).rows as unknown as Row[];

  /** Exact rows, not counts: failed requests must not create a receipt or alter any owned state. */
  const snapshot = async (): Promise<OwnedSnapshot> => ({
    interviews: await readRows(
      `SELECT interview_id, application_id, department_id, interviewer_person_id,
              interview_schema_id, assigned_by_person_id, assigned_at, revision
         FROM public.recruitment_interviews
        WHERE interview_id = ANY($1::text[])
        ORDER BY interview_id`,
      [interviewIds],
    ),
    corrections: await readRows(
      `SELECT interview_id, predecessor_revision, resulting_revision, answers,
              explanatory_power, role_model, suitability, recommendation,
              corrected_by_person_id, corrected_at, command_id
         FROM public.recruitment_interview_correction_assessments
        WHERE interview_id = ANY($1::text[])
        ORDER BY interview_id, resulting_revision`,
      [interviewIds],
    ),
    correctionReceipts: await readRows(
      `SELECT command_id, command_sha256, command_json, observation_json, interview_id,
              predecessor_revision, resulting_revision, committed_at
         FROM public.recruitment_interview_correction_command_receipts
        WHERE interview_id = ANY($1::text[])
        ORDER BY interview_id, resulting_revision, command_id`,
      [interviewIds],
    ),
    correctionAudit: await readRows(
      `SELECT command_id, interview_id, actor_person_id, predecessor_revision,
              resulting_revision, occurred_at
         FROM public.recruitment_interview_correction_audit
        WHERE interview_id = ANY($1::text[])
        ORDER BY interview_id, resulting_revision, command_id`,
      [interviewIds],
    ),
    nativeHttpReceipts: await readRows(
      `SELECT identity_sha256, request_sha256, operation_id, state, status, media_type,
              encode(body_bytes, 'hex') AS body_hex, headers_json, committed_at,
              full_expires_at, tombstoned_at
         FROM public.native_http_idempotency_receipts
        WHERE operation_id = 'recruitment.correctInterviewAssessment'
        ORDER BY identity_sha256`,
    ),
    applicantLinks: await readRows(
      `SELECT applicant_id, person_id, linked_at, invitation_id
         FROM public.applicant_account_links
        WHERE applicant_id = ANY($1::text[])
        ORDER BY applicant_id`,
      [applicantIds],
    ),
    applicantInvitations: await readRows(
      `SELECT invitation_id, application_id, applicant_id, token_digest, expires_at,
              state, issued_by, issued_at
         FROM public.applicant_account_invitations
        WHERE applicant_id = ANY($1::text[])
        ORDER BY applicant_id, invitation_id`,
      [applicantIds],
    ),
    memberships: await readRows(
      `SELECT membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
              position_id, is_team_leader, is_suspended, revision
         FROM public.organization_memberships
        WHERE membership_id = $1`,
      [membershipId],
    ),
    departments: await readRows(
      `SELECT department_id, name, short_name, email, address, city, latitude,
              longitude, slack_channel, logo_path, active, revision
         FROM public.organization_departments
        WHERE department_id = ANY($1::text[])
        ORDER BY department_id`,
      [departmentIds],
    ),
    sessions: await readRows(
      `SELECT id, "expiresAt", md5(token) AS token_digest, "createdAt", "updatedAt",
              "ipAddress", "userAgent", "userId"
         FROM auth."session"
        WHERE "userId" = $1
        ORDER BY id`,
      [actorPersonId],
    ),
  });

  const assertSnapshot = async (before: OwnedSnapshot, label: string) => {
    const after = await snapshot();
    assert.deepEqual(after, before, `${label} changed owned state`);
  };

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
  const withMutation = async <T>(
    mutate: Mutation<void>,
    restore: Mutation<void>,
    action: () => Promise<T>,
  ): Promise<T> => {
    const before = await snapshot();
    const client = await pool.connect();
    let result!: T;
    let actionError: unknown;
    try {
      await client.query("BEGIN");
      await mutate(client);
      await client.query("COMMIT");
      try {
        result = await action();
      } catch (cause) {
        actionError = cause;
      }
      await client.query("BEGIN");
      await restore(client);
      await client.query("COMMIT");
      await assertSnapshot(before, "mutation restoration");
      if (actionError !== undefined) throw actionError;
      return result;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  };

  const detail = async (): Promise<{ body: Detail; etag: string }> => {
    const response = await get(interviewId);
    status("detail", response.status);
    assert.equal(response.status, 200, await response.clone().text());
    const etag = response.headers.get("etag");
    if (etag === null) throw new Error("detail response did not include an ETag");
    return { body: (await response.json()) as Detail, etag };
  };
  const validPayload = (body: Detail) => ({
    expectedRevision: body.revision,
    answers: body.answers,
    score: body.score ?? { explanatoryPower: 0, roleModel: 0, suitability: 0 },
    recommendation: body.recommendation ?? "Ja",
  });

  const denied = async (
    name: string,
    expected: 401 | 403,
    requestCookie: string | null,
    body: Detail,
    etag: string,
  ) => {
    const before = await snapshot();
    const read = await get(interviewId, requestCookie);
    status(`${name}:read`, read.status);
    assert.equal(read.status, expected, `${name} read: ${await read.text()}`);
    const write = await post(
      interviewId,
      validPayload(body),
      etag,
      freshId(`correction-boundary-${name}`),
      requestCookie,
    );
    status(`${name}:write`, write.status);
    assert.equal(write.status, expected, `${name} write: ${await write.text()}`);
    const replay = await post(
      interviewId,
      acceptedReplay.payload,
      acceptedReplay.etag,
      acceptedReplay.key,
      requestCookie,
    );
    status(`${name}:replay`, replay.status);
    assert.equal(replay.status, expected, `${name} replay: ${await replay.text()}`);
    await assertSnapshot(before, name);
  };
  const initial = await detail();
  await denied("missing-credential", 401, null, initial.body, initial.etag);
  record("anonymous detail and correction deny with no native receipt or domain writes");
  const originalInterview = identityRows.rows.find((row) => row.interviewId === interviewId) as Row;
  assert.equal(originalInterview.interviewId, interviewId);
  await withMutation(
    (client) =>
      client
        .query(
          `UPDATE public.recruitment_interviews
              SET interviewer_person_id=$1
            WHERE interview_id=$2`,
          [otherPersonId, interviewId],
        )
        .then(() => undefined),
    (client) =>
      client
        .query(
          `UPDATE public.recruitment_interviews
              SET interviewer_person_id=$1
            WHERE interview_id=$2`,
          [originalInterview.interviewerPersonId, interviewId],
        )
        .then(() => undefined),
    () => denied("wrong-assigned-interviewer", 403, cookie, initial.body, initial.etag),
  );
  record("wrong interviewer assignment denies detail and correction");

  record("native authority models an assigned interviewer only; no synthetic unassigned or co-interviewer role is introduced");
  const originalMembership = (await readRows(
    `SELECT membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
            position_id, is_team_leader, is_suspended, revision
       FROM public.organization_memberships
      WHERE membership_id=$1`,
    [membershipId],
  ))[0];
  assert.ok(originalMembership);
  await withMutation(
    (client) =>
      client
        .query(
          `UPDATE public.organization_memberships
              SET end_at = start_at + interval '1 second'
            WHERE membership_id=$1`,
          [membershipId],
        )
        .then(() => undefined),
    (client) =>
      client
        .query(
          `UPDATE public.organization_memberships
              SET end_at=$1
            WHERE membership_id=$2`,
          [originalMembership.end_at, membershipId],
        )
        .then(() => undefined),
    () => denied("ended-membership", 403, cookie, initial.body, initial.etag),
  );
  record("ended membership denies detail and correction");

  await withMutation(
    (client) =>
      client
        .query(
          `UPDATE public.organization_memberships
              SET is_suspended=true
            WHERE membership_id=$1`,
          [membershipId],
        )
        .then(() => undefined),
    (client) =>
      client
        .query(
          `UPDATE public.organization_memberships
              SET is_suspended=$1
            WHERE membership_id=$2`,
          [originalMembership.is_suspended, membershipId],
        )
        .then(() => undefined),
    () => denied("suspended-membership", 403, cookie, initial.body, initial.etag),
  );
  record("suspended membership denies detail and correction");

  const actorSessions = await readRows(
    `SELECT id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"
       FROM auth."session"
      WHERE "userId" = $1
      ORDER BY id`,
    [actorPersonId],
  );
  assert.ok(actorSessions.length > 0, "authority fixture must provide an actor session");
  await withMutation(
    (client) =>
      client
        .query(`DELETE FROM auth."session" WHERE "userId"=$1`, [actorPersonId])
        .then(() => undefined),
    async (client) => {
      for (const session of actorSessions) {
        await client.query(
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
        );
      }
    },
    () => denied("revoked-credential", 401, cookie, initial.body, initial.etag),
  );
  record("actual actor-session deletion denies detail and correction, then restores exact session rows");

  const originalDepartment = (await readRows(
    `SELECT department_id, name, short_name, email, address, city, latitude,
            longitude, slack_channel, logo_path, active, revision
       FROM public.organization_departments
      WHERE department_id=$1`,
    [identity.departmentId],
  ))[0];
  assert.ok(originalDepartment);
  await withMutation(
    (client) =>
      client
        .query(`UPDATE public.organization_departments SET active=false WHERE department_id=$1`, [identity.departmentId])
        .then(() => undefined),
    (client) =>
      client
        .query(`UPDATE public.organization_departments SET active=$1 WHERE department_id=$2`, [originalDepartment.active, identity.departmentId])
        .then(() => undefined),
    () => denied("inactive-department", 403, cookie, initial.body, initial.etag),
  );
  record("inactive department denies detail and correction");

  await withMutation(
    (client) =>
      client
        .query(
          `UPDATE public.recruitment_interviews SET department_id=$1 WHERE interview_id=$2`,
          [differentDepartment, interviewId],
        )
        .then(() => undefined),
    (client) =>
      client
        .query(
          `UPDATE public.recruitment_interviews SET department_id=$1 WHERE interview_id=$2`,
          [originalInterview.departmentId, interviewId],
        )
        .then(() => undefined),
    () => denied("wrong-department", 403, cookie, initial.body, initial.etag),
  );
  record("wrong department denies detail and correction");


  const detailFor = async (id: string): Promise<{ body: Detail; etag: string }> => {
    const response = await get(id);
    assert.equal(response.status, 200, await response.clone().text());
    const etag = response.headers.get("etag");
    if (etag === null) throw new Error("detail response did not include an ETag");
    return { body: (await response.json()) as Detail, etag };
  };
  const raceSeed = await detailFor(selfLinkRaceInterviewId);
  const raceSeedPayload = {
    ...acceptedReplay.payload,
    expectedRevision: raceSeed.body.revision,
  };
  const raceSeedKey = freshId("correction-boundary-self-link-seed");
  const raceSeedResponse = await post(
    selfLinkRaceInterviewId,
    raceSeedPayload,
    raceSeed.etag,
    raceSeedKey,
  );
  status("self-link-seed:write", raceSeedResponse.status);
  assert.equal(raceSeedResponse.status, 200, await raceSeedResponse.text());
  const acceptedRaceReplay = { key: raceSeedKey, etag: raceSeed.etag, payload: raceSeedPayload };
  const raceFresh = await detailFor(selfLinkRaceInterviewId);
  const racePayload = validPayload(raceFresh.body);
  const raceBefore = await snapshot();
  const locker = await pool.connect();
  let waiting: Promise<Response> | undefined;
  const raceInvitation = freshId("correction-boundary-self-link-race");
  try {
    await locker.query("BEGIN");
    await locker.query(
      `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id=$1 FOR UPDATE`,
      [raceIdentity.applicantId],
    );
    waiting = post(
      selfLinkRaceInterviewId,
      racePayload,
      raceFresh.etag,
      freshId("correction-boundary-self-link-race-request"),
    );
    const lockerPid = Number((await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const blockingRows = await pool.query(
        `SELECT pid FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
        [lockerPid],
      );
      if (blockingRows.rows.length > 0) {
        blocked = true;
        break;
      }
      await sleep(10);
    }
    assert.ok(blocked, `correction request was not blocked by lockerPid=${lockerPid}`);
    await locker.query(
      `INSERT INTO public.applicant_account_invitations
         (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP+interval '1 day','Claimed',$5,CURRENT_TIMESTAMP)`,
      [
        raceInvitation,
        raceIdentity.applicationId,
        raceIdentity.applicantId,
        createHash("sha256").update(raceInvitation).digest("hex"),
        actorPersonId,
      ],
    );
    await locker.query(
      `INSERT INTO public.applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
       VALUES ($1,$2,CURRENT_TIMESTAMP,$3)`,
      [raceIdentity.applicantId, actorPersonId, raceInvitation],
    );
    await locker.query("COMMIT");
    const raceResponse = await waiting;
    status("self-link-race:write", raceResponse.status);
    assert.equal(raceResponse.status, 403, await raceResponse.text());
    const deniedRead = await get(selfLinkRaceInterviewId);
    status("self-link-race:read-after-commit", deniedRead.status);
    assert.equal(deniedRead.status, 403, await deniedRead.text());
    const replay = await post(
      selfLinkRaceInterviewId,
      acceptedRaceReplay.payload,
      acceptedRaceReplay.etag,
      acceptedRaceReplay.key,
    );
    status("self-link-race:replay", replay.status);
    assert.equal(replay.status, 403, await replay.text());
    const raceAfterResponse = await snapshot();
    assertCorrectionRowsUnchanged(raceBefore, raceAfterResponse, "self-link race response");
  } finally {
    await locker.query("ROLLBACK").catch(() => undefined);
    locker.release();
    await waiting?.catch(() => undefined);
  }
  record("genuine accepted self-link fixture correction is denied after committed self-link, including fresh read and exact replay");

  const current = await detail();
  const currentPayload = validPayload(current.body);
  const currentAnswers = currentPayload.answers;
  assert.ok(Array.isArray(currentAnswers) && currentAnswers.length >= 2, "invalid answer probes need two answers");
  const answerRows = currentAnswers as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const invalidCases: ReadonlyArray<readonly [string, unknown]> = [
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
          index === 1 ? { ...answer, questionId: answerRows[0].questionId } : answer,
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
    ["invalid-recommendation", { ...currentPayload, recommendation: "Maybe" }],
    ["fractional-score", { ...currentPayload, score: { ...currentPayload.score, roleModel: 1.5 } }],
    [
      "score-out-of-range",
      { ...currentPayload, score: { ...currentPayload.score, explanatoryPower: 11 } },
    ],
    ["null-recommendation", { ...currentPayload, recommendation: null }],
  ];
  for (const [name, invalid] of invalidCases) {
    const before = await snapshot();
    const response =
      name === "malformed-json"
        ? await postRaw(
            interviewId,
            invalid as string,
            current.etag,
            freshId(`correction-boundary-invalid-${name}`),
          )
        : await post(
            interviewId,
            invalid,
            current.etag,
            freshId(`correction-boundary-invalid-${name}`),
          );
    status(`invalid:${name}`, response.status);
    assert.equal(response.status, name === "malformed-json" ? 400 : 422, await response.text());
    await assertSnapshot(before, `invalid ${name}`);
  }
  record("malformed JSON maps to 400; strict schema failures map to 422; each leaves exact state unchanged");
  const sameKeyBefore = await snapshot();
  const conflictingPayload = {
    ...currentPayload,
    recommendation: currentPayload.recommendation === "Nei" ? "Ja" : "Nei",
  };
  const sameKeyResponse = await post(
    interviewId,
    conflictingPayload,
    current.etag,
    acceptedReplay.key,
  );
  status("same-key-different-payload", sameKeyResponse.status);
  assert.equal(sameKeyResponse.status, 409, await sameKeyResponse.text());
  await assertSnapshot(sameKeyBefore, "same-key different payload");
  record("same idempotency key with a different payload returns digest conflict without any owned write");
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
  const rollbackClient = await pool.connect();
  try {
    await rollbackClient.query("BEGIN");
    await rollbackClient.query(`CREATE SEQUENCE public.${quote(rollbackSequence)}`);
    await rollbackClient.query(
      `CREATE TABLE public.${quote(rollbackControl)} (stage integer NOT NULL CHECK (stage BETWEEN 1 AND 4))`,
    );
    await rollbackClient.query(`INSERT INTO public.${quote(rollbackControl)} (stage) VALUES (1)`);
    await rollbackClient.query(`
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
    `);
    for (const [, table, stage, event] of rollbackTriggers) {
      await rollbackClient.query(
        `CREATE TRIGGER ${quote(`${rollbackFunction}_${stage}`)} AFTER ${event} ON public.${table}
         FOR EACH ROW EXECUTE FUNCTION public.${quote(rollbackFunction)}('${stage}')`,
      );
    }
    await rollbackClient.query("COMMIT");
  } finally {
    await rollbackClient.query("ROLLBACK").catch(() => undefined);
    rollbackClient.release();
  }
  try {
    for (const [name, , stage] of rollbackTriggers) {
      const setup = await pool.connect();
      try {
        await setup.query("BEGIN");
        await setup.query(`UPDATE public.${quote(rollbackControl)} SET stage=$1`, [Number(stage)]);
        await setup.query(`ALTER SEQUENCE public.${quote(rollbackSequence)} RESTART WITH 1`);
        await setup.query("COMMIT");
      } finally {
        await setup.query("ROLLBACK").catch(() => undefined);
        setup.release();
      }
      const before = await snapshot();
      const response = await post(
        interviewId,
        currentPayload,
        current.etag,
        freshId(`correction-boundary-rollback-${name}`),
      );
      status(`rollback:${name}`, response.status);
      const failureBody = (await response.json()) as { readonly code?: unknown; readonly status?: unknown };
      assert.equal(response.status, 503, JSON.stringify(failureBody));
      assert.equal(failureBody.code, "dependency.unavailable", JSON.stringify(failureBody));
      const marker = await pool.query(
        `SELECT last_value, is_called FROM public.${quote(rollbackSequence)}`,
      );
      assert.equal(marker.rows[0]?.is_called, true, `${name} rollback marker did not fire`);
      assert.equal(
        Number(marker.rows[0]?.last_value),
        Number(stage),
        `${name} rollback probe stopped before injected stage`,
      );
      await assertSnapshot(before, `rollback after ${name}`);
    }
    record("each aggregate, assessment, domain-receipt, and audit failure trigger fired and rolled back all domain and native HTTP receipt rows");
  } finally {
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
      for (const [, table, stage] of rollbackTriggers) {
        await cleanup.query(
          `DROP TRIGGER IF EXISTS ${quote(`${rollbackFunction}_${stage}`)} ON public.${table}`,
        );
      }
      await cleanup.query(`DROP FUNCTION IF EXISTS public.${quote(rollbackFunction)}()`);
      await cleanup.query(`DROP TABLE IF EXISTS public.${quote(rollbackControl)}`);
      await cleanup.query(`DROP SEQUENCE IF EXISTS public.${quote(rollbackSequence)}`);
      await cleanup.query("COMMIT");
    } finally {
      await cleanup.query("ROLLBACK").catch(() => undefined);
      cleanup.release();
    }
  }

  const differentLinkInvitation = freshId("correction-boundary-different-link");
  const differentLinkClient = await pool.connect();
  try {
    await differentLinkClient.query("BEGIN");
    await differentLinkClient.query(
      `INSERT INTO public.applicant_account_invitations
         (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP+interval '1 day','Claimed',$5,CURRENT_TIMESTAMP)`,
      [
        differentLinkInvitation,
        identity.applicationId,
        identity.applicantId,
        createHash("sha256").update(differentLinkInvitation).digest("hex"),
        actorPersonId,
      ],
    );
    await differentLinkClient.query(
      `INSERT INTO public.applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
       VALUES ($1,$2,CURRENT_TIMESTAMP,$3)`,
      [identity.applicantId, otherPersonId, differentLinkInvitation],
    );
    await differentLinkClient.query("COMMIT");
  } finally {
    await differentLinkClient.query("ROLLBACK").catch(() => undefined);
    differentLinkClient.release();
  }
  const differentRead = await get(interviewId);
  status("different-linked-person:read", differentRead.status);
  assert.equal(differentRead.status, 200, await differentRead.text());
  record("different-person applicant link is a committed teardown-owned fixture and remains readable without correction writes");
  return { gates, statuses };
}
