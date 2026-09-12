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
  assert.equal(identityRows.rows.length, 2, "correction fixtures must expose both interviews");
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
      `SELECT id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"
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
  const initialSnapshot = await snapshot();
  await denied("missing-credential", 401, null, initial.body, initial.etag);
  record("anonymous detail, correction, and replay deny with no native receipt or domain writes");

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
  record("wrong interviewer assignment denies detail, correction, and replay");

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
  record("ended membership denies detail, correction, and replay");

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
  record("suspended membership denies detail, correction, and replay");

  const cookieValue = cookie.match(
    /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/u,
  )?.[1];
  assert.ok(cookieValue, "authenticated cookie must include the Better Auth session token");
  const session = (await readRows(
    `SELECT id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"
       FROM auth."session"
      WHERE token = split_part($1, '.', 1)
        AND "userId"=$2`,
    [cookieValue, actorPersonId],
  ))[0];
  assert.ok(session, "authenticated cookie must map to an owned Better Auth session");
  await withMutation(
    (client) =>
      client
        .query(`DELETE FROM auth."session" WHERE id=$1 AND "userId"=$2`, [session.id, actorPersonId])
        .then(() => undefined),
    (client) =>
      client
        .query(
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
        )
        .then(() => undefined),
    () => denied("revoked-credential", 401, cookie, initial.body, initial.etag),
  );
  record("revoked credential denies detail, correction, and fresh-auth replay");

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
  record("inactive department denies detail, correction, and replay");

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
  record("wrong department denies detail, correction, and replay");

  const primaryLink = (await readRows(
    `SELECT applicant_id, person_id, linked_at, invitation_id
       FROM public.applicant_account_links WHERE applicant_id=$1`,
    [identity.applicantId],
  ))[0];
  assert.equal(primaryLink, undefined, "known-self test needs an unlinked target applicant");
  const knownSelfInvitation = freshId("correction-boundary-known-self");
  await withMutation(
    (client) =>
      client
        .query(
          `INSERT INTO public.applicant_account_invitations
             (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at)
           VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP+interval '1 day','Claimed',$5,CURRENT_TIMESTAMP)`,
          [
            knownSelfInvitation,
            identity.applicationId,
            identity.applicantId,
            createHash("sha256").update(knownSelfInvitation).digest("hex"),
            actorPersonId,
          ],
        )
        .then(() =>
          client.query(
            `INSERT INTO public.applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
             VALUES ($1,$2,CURRENT_TIMESTAMP,$3)`,
            [identity.applicantId, actorPersonId, knownSelfInvitation],
          ),
        )
        .then(() => undefined),
    async (client) => {
      await client.query(`DELETE FROM public.applicant_account_links WHERE applicant_id=$1`, [identity.applicantId]);
      await client.query(`DELETE FROM public.applicant_account_invitations WHERE invitation_id=$1`, [knownSelfInvitation]);
    },
    () => denied("known-self", 403, cookie, initial.body, initial.etag),
  );
  record("known self-link denies detail, correction, and replay");

  const differentLinkInvitation = freshId("correction-boundary-different-link");
  await withMutation(
    (client) =>
      client
        .query(
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
        )
        .then(() =>
          client.query(
            `INSERT INTO public.applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
             VALUES ($1,$2,CURRENT_TIMESTAMP,$3)`,
            [identity.applicantId, otherPersonId, differentLinkInvitation],
          ),
        )
        .then(() => undefined),
    async (client) => {
      await client.query(`DELETE FROM public.applicant_account_links WHERE applicant_id=$1`, [identity.applicantId]);
      await client.query(`DELETE FROM public.applicant_account_invitations WHERE invitation_id=$1`, [differentLinkInvitation]);
    },
    async () => {
      const before = await snapshot();
      const read = await get(interviewId);
      status("different-linked-person:read", read.status);
      assert.equal(read.status, 200, await read.text());
      await assertSnapshot(before, "different linked person read");
    },
  );
  record("different linked person remains authorized and does not disclose or mutate extra state");

  const raceBefore = await snapshot();
  const raceDetail = await get(selfLinkRaceInterviewId);
  assert.equal(raceDetail.status, 200, await raceDetail.clone().text());
  const raceEtag = raceDetail.headers.get("etag");
  if (raceEtag === null) throw new Error("self-link race detail response did not include an ETag");
  const raceBody = (await raceDetail.json()) as Detail;
  const racePayload = validPayload(raceBody);
  const locker = await pool.connect();
  let waiting: Promise<Response> | undefined;
  let raceCommitted = false;
  let raceSetupSnapshot: OwnedSnapshot | undefined;
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
      raceEtag,
      freshId("correction-boundary-self-link-race-request"),
    );
    const lockerPid = Number((await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const blockingRows = await pool.query(
        `SELECT pid
           FROM pg_stat_activity
          WHERE pid <> $1
            AND $1 = ANY(pg_blocking_pids(pid))`,
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
    raceCommitted = true;
    raceSetupSnapshot = await snapshot();
    const raceResponse = await waiting;
    status("self-link-race:write", raceResponse.status);
    assert.equal(raceResponse.status, 403, await raceResponse.text());
    const raceAfterResponse = await snapshot();
    assert.ok(raceSetupSnapshot);
    assertCorrectionRowsUnchanged(raceSetupSnapshot, raceAfterResponse, "self-link race response");
  } finally {
    await locker.query("ROLLBACK").catch(() => undefined);
    locker.release();
    await waiting?.catch(() => undefined);
    if (raceCommitted) {
      const cleanup = await pool.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query(`DELETE FROM public.applicant_account_links WHERE applicant_id=$1`, [raceIdentity.applicantId]);
        await cleanup.query(`DELETE FROM public.applicant_account_invitations WHERE invitation_id=$1`, [raceInvitation]);
        await cleanup.query("COMMIT");
      } finally {
        await cleanup.query("ROLLBACK").catch(() => undefined);
        cleanup.release();
      }
    }
  }

  const current = await detail();
  const currentPayload = validPayload(current.body);
  const invalidCases: ReadonlyArray<readonly [string, unknown]> = [
    ["malformed-json", "{"],
    ["unknown-property", { ...currentPayload, unexpected: true }],
    ["revision-string", { ...currentPayload, expectedRevision: String(current.body.revision) }],
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

  await assertSnapshot(initialSnapshot, "complete boundary journey");
  return { gates, statuses };
}
