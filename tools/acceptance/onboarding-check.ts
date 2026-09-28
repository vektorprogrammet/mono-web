/** 0099 real local API + browser acceptance. Reuses native identity seed and owned process lifecycle. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Cause,
  Console,
  Data,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Path,
  Predicate,
  Schedule,
  Schema,
  Struct,
} from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { SubmitApplicationRequest } from "../../packages/rpc/src/v2-schemas.js";
import { IdempotencyKey } from "../../packages/rpc/src/problem.js";
import { nativeScriptClient } from "../../packages/rpc/src/script-client.js";
import { replacedFetch } from "../../apps/dashboard/e2e/native-rpc-ledger.ts";
import { loopbackPortFree, reserveLoopbackPorts, startDisposablePostgres } from "../postgres/index.ts";
import { jsonText } from "../../apps/backend/src/rpc/problem.js";
import {
  answersOk,
  commandOutput,
  indentedJsonText,
  ProbeFailure,
  startOwnedProcess,
  withheldVariables,
} from "./acceptance-process.ts";

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);

const { Pool } = requireDatabase("pg");

/** A PostgreSQL call, or the disposable cluster, that failed. */
class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{ readonly cause: unknown }> {}

/** A request whose answer could not be read. */
class RequestFailure extends Data.TaggedError("RequestFailure")<{ readonly cause: unknown }> {}

/** The failure of the probe, with every credential redacted from its message. */
class OnboardingFailed extends Data.TaggedError("OnboardingFailed")<{ readonly message: string }> {}

/** The rows of one query; the probe reads the columns that its statement selects. */
interface QueryResult {
  readonly rows: Array<any>;
}

/** One acknowledged onboarding mail, as the backend delivers it. */
const MailMessage = Schema.Struct({ deliveryId: Schema.String, text: Schema.String, to: Schema.String });

type MailMessage = typeof MailMessage.Type;

const JsonBody = Schema.fromJsonString(Schema.Json);

/** One answer, from the identity engine over HTTP or from an RPC as its route's HTTP response. */
interface Answer {
  readonly status: number;
  readonly json: Effect.Effect<any, RequestFailure>;
  readonly cookie: string | undefined;
}

const webAnswer = (response: Response): Answer => ({
  status: response.status,
  json: Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new RequestFailure({ cause }),
  }),
  cookie: response.headers.get("set-cookie")?.split(";")[0],
});

const clientAnswer = (response: HttpClientResponse.HttpClientResponse): Answer => {
  const cookie = Object.values(response.cookies.cookies)[0];

  return {
    status: response.status,
    json: response.json.pipe(Effect.mapError((cause) => new RequestFailure({ cause }))),
    cookie: cookie === undefined ? undefined : `${cookie.name}=${cookie.valueEncoded}`,
  };
};

const mode = process.argv[2];

assert.ok(
  process.argv.length === 3 && (mode === "--browser" || mode === "--api-only"),
  "Usage: bun run tools/acceptance/onboarding-check.ts --browser | --api-only",
);

const secrets = new Set<string>();

const safe = (text: string) => {
  let value = text.replace(/onboard_[a-f0-9]{64}/g, "[REDACTED]");

  for (const secret of secrets)
    if (secret.length > 4) value = value.split(secret).join("[REDACTED]");

  return value;
};

const assertNoSecrets = (text: string) => {
  if (safe(text) !== text) throw new Error("Retained evidence contains credentials");
};

const journey = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../..");

  const run = (command: string, args: ReadonlyArray<string>, env = {}) =>
    commandOutput({ command, args, cwd: root, env, deadline: "60 seconds" });

  const revision = (yield* run("git", ["rev-parse", "HEAD"])).trim();

  assert.equal(
    (yield* run("git", ["status", "--porcelain"])).trim(),
    "",
    "requires committed clean artifact",
  );

  const artifacts = yield* fs.makeTempDirectory({ prefix: "vektor-onboarding-0099-" });
  const outputs: string[] = [];
  const mailboxToken = randomBytes(32).toString("hex");
  secrets.add(mailboxToken);
  const mail = new Map<string, { readonly message: MailMessage; readonly json: Schema.Json; readonly text: string }>();
  let attempts = 0;
  let rejectNext = false;

  const checks = Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      fs.remove(path.join(artifacts, "manifest.json"), { force: true }).pipe(Effect.ignore),
    );

    const [backendPort, mailboxPort] = yield* Effect.tryPromise({
      try: () => reserveLoopbackPorts(2),
      catch: (cause) => new DatabaseFailure({ cause }),
    });

    const dashboardPort = 5174;

    assert.ok(
      yield* Effect.promise(() => loopbackPortFree(dashboardPort)),
      `loopback port ${dashboardPort} is in use`,
    );

    const postgres = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => startDisposablePostgres(),
        catch: (cause) => new DatabaseFailure({ cause }),
      }),
      (cluster) => Effect.promise(() => cluster.stop()),
    );

    const postgresUrl = postgres.url;
    secrets.add(postgresUrl);

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: postgresUrl })),
      (owned) => Effect.promise(() => owned.end()),
    );

    const query = (text: string, values?: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: (): Promise<QueryResult> => pool.query(text, values),
        catch: (cause) => new DatabaseFailure({ cause }),
      });

    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: mailboxPort,
          fetch(request) {
            if (request.headers.get("authorization") !== `Bearer ${mailboxToken}`)
              return new Response(null, { status: 401 });

            return request.text().then((body) => {
              if (request.method !== "POST") return Response.json([...mail.values()].map((entry) => entry.json));

              attempts++;

              if (rejectNext) {
                rejectNext = false;

                return new Response(null, { status: 503 });
              }

              const json = Schema.decodeSync(JsonBody)(body);
              const text = Schema.encodeSync(JsonBody)(json);
              const message = Schema.decodeUnknownSync(MailMessage)(json);
              const old = mail.get(message.deliveryId);

              if (old !== undefined && old.text !== text) return new Response(null, { status: 409 });

              mail.set(message.deliveryId, { message, json, text });

              return new Response(null, { status: 204 });
            });
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );

    const mailboxOrigin = `http://127.0.0.1:${mailboxPort}`;

    const environment = {
      ...(yield* withheldVariables),
      ONBOARDING_DELIVERY_URL: mailboxOrigin + "/mail",
      ONBOARDING_DELIVERY_TOKEN: mailboxToken,
      ONBOARDING_DELIVERY_TIMEOUT_MS: "1000",
      ONBOARDING_DELIVERY_SENDER: "coordinator@example.invalid",
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(backendPort),
      BACKEND_PG_URL: postgresUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: yield* jsonText([dashboardOrigin]),
      OAUTH_CANONICAL_ORIGIN: backendOrigin,
      OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_MODE: "disabled",
      JOURNEY_SEED_PG_URL: postgresUrl,
    };

    secrets.add(environment.BETTER_AUTH_SECRET);
    yield* run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], environment);
    const departmentId = "department-native-journey-0049";
    const semesterId = "semester-native-journey-0049";
    const leaderId = "journey-rec-leader-0049";

    const persons = {
      leader: { email: "lina.leader@example.invalid", password: "journey-secret-0123456789abcdef" },
      existing: {
        email: "irene.intervjuer@example.invalid",
        password: "journey-secret-0123456789abcdef",
      },
      applicant: {
        email: "onboarding-browser@example.invalid",
        password: "onboarding-browser-password-0099",
      },
    };

    for (const person of Object.values(persons)) secrets.add(person.password);
    yield* query(
      `DELETE FROM organization_global_administrator_grants;INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active,revision) OVERRIDING SYSTEM VALUE VALUES(995,'Onboarding school','Contact','school@example.invalid','12345678','Norwegian',true,0);INSERT INTO schools_directory_departments VALUES(995,'${departmentId}',0);`,
    );

    const startBackend = startOwnedProcess({
      command: "bun",
      args: ["run", "--cwd", "apps/backend", "start"],
      cwd: root,
      env: environment,
      output: (text) => outputs.push(text),
    });

    let backend = yield* startBackend;

    const ready = answersOk(backendOrigin + "/health").pipe(
      Effect.filterOrFail(
        (up) => up,
        () => new ProbeFailure({ message: "backend startup failed" }),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 151 }),
    );

    yield* ready;

    const request = (
      path: string,
      cookie?: string,
      body?: Schema.Json,
      etag?: string,
      key = randomBytes(18).toString("hex"),
    ): Effect.Effect<Answer, RequestFailure, HttpClient.HttpClient> => {
      const url = new URL(path, backendOrigin);

      // The identity engine stays HTTP; every onboarding operation is the RPC that replaced its
      // route, answered as that route's HTTP response.
      if (url.pathname.startsWith("/api/auth/"))
        return Effect.gen(function* () {
          let headers = Headers.fromInput({ origin: dashboardOrigin });

          if (cookie !== undefined && cookie !== "") headers = Headers.set(headers, "cookie", cookie);

          if (body !== undefined) {
            headers = Headers.set(headers, "idempotency-key", key);

            if (etag !== undefined && etag !== "") headers = Headers.set(headers, "if-match", etag);
          }

          const base =
            body === undefined
              ? HttpClientRequest.get(backendOrigin + path, { headers })
              : HttpClientRequest.post(backendOrigin + path, { headers }).pipe(
                  HttpClientRequest.bodyText(yield* jsonText(body), "application/json"),
                );

          return clientAnswer(
            yield* HttpClient.execute(base).pipe(
              Effect.mapError((cause) => new RequestFailure({ cause })),
            ),
          );
        });

      const rpcHeaders = { origin: dashboardOrigin, cookie };

      const replaced = (tag: string, payload: Schema.Json) =>
        Effect.tryPromise({
          try: () => replacedFetch({ origin: backendOrigin, tag, payload, headers: rpcHeaders }),
          catch: (cause) => new RequestFailure({ cause }),
        }).pipe(Effect.map(webAnswer));

      if (url.pathname === "/api/onboarding/claim") return replaced("onboarding.claim", body ?? null);

      const scope = { departmentId: url.searchParams.get("departmentId") ?? "" };

      return body === undefined
        ? replaced("onboarding.readBoard", scope)
        : replaced("onboarding.command", {
            ...scope,
            idempotencyKey: key,
            ifMatch: etag ?? "",
            request: body,
          });
    };

    const expectStatus = (answer: Answer, status: number) =>
      Effect.gen(function* () {
        const body = yield* answer.json;
        assert.equal(
          answer.status,
          status,
          Predicate.isString(body.code) && /^[a-z.-]+$/.test(body.code)
            ? body.code
            : "Unexpected HTTP status",
        );

        return body;
      });

    const login = (person: { email: string; password: string }) =>
      Effect.gen(function* () {
        const response = yield* request("/api/auth/sign-in/email", undefined, person);
        assert.equal(response.status, 200);
        const cookie = response.cookie;
        assert.ok(cookie !== undefined && cookie !== "");

        return cookie;
      });

    const leader = yield* login(persons.leader);
    const existing = yield* login(persons.existing);
    const boardPath = "/api/onboarding?departmentId=" + departmentId;
    const board = Effect.flatMap(request(boardPath, leader), (answer) => expectStatus(answer, 200));

    // Public applications are served as an RPC; an applicant submits anonymously.
    const applications = yield* Effect.acquireRelease(
      Effect.sync(() => nativeScriptClient(backendOrigin)),
      (client) => Effect.promise(() => client.dispose()),
    );

    const submit = (email: string, firstName: string) =>
      Effect.gen(function* () {
        const submission = yield* Schema.decodeEffect(SubmitApplicationRequest)({
          departmentId,
          firstName,
          lastName: "Applicant",
          phone: "12345678",
          email,
          gender: 0,
          fieldOfStudyId: "field-native-journey-0049",
          yearOfStudy: 2,
          availability: {
            mondayUnavailable: false,
            tuesdayUnavailable: true,
            wednesdayUnavailable: false,
            thursdayUnavailable: false,
            fridayUnavailable: false,
            positionWeeks: 4,
            preferredGroup: "all",
            language: "Norsk",
          },
        });

        const answer = yield* Effect.promise(() =>
          applications.call({}, (client) =>
            client["admissions.submitApplication"]({
              idempotencyKey: IdempotencyKey.make(randomBytes(18).toString("base64url")),
              request: submission,
            }),
          ),
        );

        assert.ok(answer.ok, yield* jsonText(answer));

        return answer.value;
      });

    const browserApplication = yield* submit(persons.applicant.email, "Onboarding");
    let revokedReplayObserved = false;

    const lastMail = () => [...mail.values()].at(-1)!.message;

    const issue = (applicationId: string) =>
      Effect.gen(function* () {
        const before = yield* board;
        const key = randomBytes(18).toString("hex");
        const body = { applicationId, action: "Issue" };
        const response = yield* request(boardPath, leader, body, before.etag, key);
        yield* expectStatus(response, 200);
        const count = mail.size;
        yield* expectStatus(yield* request(boardPath, leader, body, before.etag, key), 200);
        assert.equal(mail.size, count);

        if (!revokedReplayObserved) {
          yield* query(
            `UPDATE organization_memberships SET is_suspended=true WHERE person_id=$1`,
            [leaderId],
          );

          yield* Effect.gen(function* () {
            yield* expectStatus(yield* request(boardPath, leader, body, before.etag, key), 403);
            yield* expectStatus(yield* request(boardPath, leader), 403);
          }).pipe(
            Effect.ensuring(
              query(`UPDATE organization_memberships SET is_suspended=false WHERE person_id=$1`, [
                leaderId,
              ]).pipe(Effect.orDie),
            ),
          );

          revokedReplayObserved = true;
        }

        yield* expectStatus(
          yield* request(boardPath, leader, { applicationId, action: "Revoke" }, before.etag, key),
          409,
        );

        return lastMail();
      });

    const claimToken = (message: MailMessage) =>
      new URL(message.text.split(" ").at(-1)!).hash.slice(1);

    yield* expectStatus(yield* request(boardPath, existing), 403);
    yield* expectStatus(yield* request(boardPath), 401);
    yield* query(
      `INSERT INTO organization_departments(department_id,name,short_name,email,city,active,revision) VALUES('onboarding-wrong-dept','Other','Other','other@example.invalid','Other',true,0)`,
    );
    yield* expectStatus(
      yield* request("/api/onboarding?departmentId=onboarding-wrong-dept", leader),
      403,
    );

    const existingApplication = yield* submit("onboarding-existing@example.invalid", "Existing");

    const priorProfile = Effect.map(
      query(
        `SELECT jsonb_build_object('user',u,'account',a,'profile',p)::text AS value FROM auth."user" u JOIN auth."account" a ON a."userId"=u.id JOIN person_profiles p ON p.person_id=u.id WHERE u.id='journey-rec-interviewer-a-0049'`,
      ),
      (result) => result.rows,
    );

    const prior = yield* priorProfile;
    const invitation = yield* issue(existingApplication.applicationId);
    const token = claimToken(invitation);
    yield* expectStatus(
      yield* request("/api/onboarding/claim", undefined, { mode: "ExistingAccount", token }),
      401,
    );
    yield* expectStatus(
      yield* request("/api/onboarding/claim", existing, { mode: "ExistingAccount", token }),
      200,
    );
    yield* expectStatus(
      yield* request("/api/onboarding/claim", existing, { mode: "ExistingAccount", token }),
      400,
    );
    assert.deepEqual(yield* priorProfile, prior);
    const collisionApplication = yield* submit(persons.existing.email, "Collision");
    const collision = yield* issue(collisionApplication.applicationId);
    yield* expectStatus(
      yield* request("/api/onboarding/claim", undefined, {
        mode: "NewAccount",
        token: claimToken(collision),
        password: persons.applicant.password,
      }),
      409,
    );

    const concurrentApplication = yield* submit(
      "onboarding-concurrent@example.invalid",
      "Concurrent",
    );

    const concurrent = yield* issue(concurrentApplication.applicationId);
    const concurrentToken = claimToken(concurrent);

    const concurrentClaim = request("/api/onboarding/claim", undefined, {
      mode: "NewAccount",
      token: concurrentToken,
      password: persons.applicant.password,
    });

    const claims = yield* Effect.all([concurrentClaim, concurrentClaim], {
      concurrency: "unbounded",
    });

    assert.deepEqual(
      claims.map((r) => r.status).toSorted((a, b) => a - b),
      [200, 400],
    );
    const retryApplication = yield* submit("onboarding-retry@example.invalid", "Retry");
    rejectNext = true;
    const pre = yield* board;
    yield* expectStatus(
      yield* request(
        boardPath,
        leader,
        { applicationId: retryApplication.applicationId, action: "Issue" },
        pre.etag,
      ),
      200,
    );

    const retryDelivery = Effect.map(
      board,
      (current) =>
        current.items.find(
          (item: { applicationId: string }) =>
            item.applicationId === retryApplication.applicationId,
        ).delivery,
    );

    assert.equal(yield* retryDelivery, "Pending");
    yield* backend.stop;
    backend = yield* startBackend;
    yield* ready;
    const retryPre = yield* board;
    yield* expectStatus(
      yield* request(
        boardPath,
        leader,
        { applicationId: retryApplication.applicationId, action: "RetryDelivery" },
        retryPre.etag,
      ),
      200,
    );
    assert.equal(yield* retryDelivery, "Delivered");
    const revokePre = yield* board;
    yield* expectStatus(
      yield* request(
        boardPath,
        leader,
        { applicationId: retryApplication.applicationId, action: "Revoke" },
        revokePre.etag,
      ),
      200,
    );

    const revoked = [...mail.values()].find(
      (item) => item.message.to === "onboarding-retry@example.invalid",
    )!.message;

    yield* expectStatus(
      yield* request("/api/onboarding/claim", undefined, {
        mode: "NewAccount",
        token: claimToken(revoked),
        password: persons.applicant.password,
      }),
      400,
    );
    const rollbackApplication = yield* submit("onboarding-rollback@example.invalid", "Rollback");
    const rollbackInvite = yield* issue(rollbackApplication.applicationId);
    const rollbackToken = claimToken(rollbackInvite);
    yield* query(
      `CREATE FUNCTION public.reject_onboarding_test_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM auth."user" WHERE id=NEW."userId" AND email='onboarding-rollback@example.invalid') THEN RAISE EXCEPTION 'synthetic credential write rejection'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_onboarding_test_credential BEFORE INSERT ON auth."account" FOR EACH ROW EXECUTE FUNCTION public.reject_onboarding_test_credential()`,
    );

    yield* Effect.gen(function* () {
      yield* expectStatus(
        yield* request("/api/onboarding/claim", undefined, {
          mode: "NewAccount",
          token: rollbackToken,
          password: persons.applicant.password,
        }),
        500,
      );
      assert.equal(
        (yield* query(
          `SELECT count(*)::int AS count FROM person_contact_profiles WHERE email='onboarding-rollback@example.invalid'`,
        )).rows[0].count,
        0,
      );
      assert.equal(
        (yield* query(
          `SELECT count(*)::int AS count FROM auth."user" WHERE email='onboarding-rollback@example.invalid'`,
        )).rows[0].count,
        0,
      );
    }).pipe(
      Effect.ensuring(
        query(
          `DROP TRIGGER reject_onboarding_test_credential ON auth."account"; DROP FUNCTION public.reject_onboarding_test_credential()`,
        ).pipe(Effect.orDie),
      ),
    );

    yield* expectStatus(
      yield* request("/api/onboarding/claim", undefined, {
        mode: "NewAccount",
        token: rollbackToken,
        password: persons.applicant.password,
      }),
      200,
    );
    const expiring = yield* submit("onboarding-expiry@example.invalid", "Expiry");
    const expiryToken = "onboard_" + randomBytes(32).toString("hex");
    const expiryDigest = createHash("sha256").update(expiryToken).digest("hex");
    yield* query(
      `INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) SELECT 'expiry-race',application_id,applicant_id,$2,date_trunc('milliseconds',clock_timestamp(),'UTC')+interval '3 seconds','Open',$3,date_trunc('milliseconds',clock_timestamp(),'UTC')-interval '24 hours'+interval '3 seconds' FROM admission_applications WHERE application_id=$1`,
      [expiring.applicationId, expiryDigest, leaderId],
    );
    yield* query(
      `INSERT INTO applicant_account_delivery(invitation_id,state,recipient) VALUES('expiry-race','Delivered','onboarding-expiry@example.invalid')`,
    );

    const holder = yield* Effect.tryPromise({
      try: (): Promise<any> => pool.connect(),
      catch: (cause) => new DatabaseFailure({ cause }),
    });

    const hold = (text: string, values?: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: (): Promise<QueryResult> => holder.query(text, values),
        catch: (cause) => new DatabaseFailure({ cause }),
      });

    yield* hold("BEGIN");
    yield* hold(
      `SELECT p.applicant_id FROM admission_applicants p JOIN admission_applications a USING(applicant_id) WHERE a.application_id=$1 FOR UPDATE OF p`,
      [expiring.applicationId],
    );

    yield* Effect.gen(function* () {
      const delayed = yield* Effect.forkChild(
        request("/api/onboarding/claim", undefined, {
          mode: "NewAccount",
          token: expiryToken,
          password: persons.applicant.password,
        }),
      );

      for (let n = 0; ; n++) {
        const waiting = yield* query(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%admission_applicants%'`,
        );

        if (waiting.rows[0].count > 0) break;

        if (n > 100)
          return yield* new ProbeFailure({ message: "Claim did not wait on applicant lock" });
        yield* Effect.sleep("20 millis");
      }

      for (;;) {
        const expired = yield* query(
          `SELECT expires_at<clock_timestamp() AS expired FROM applicant_account_invitations WHERE invitation_id='expiry-race'`,
        );

        if (expired.rows[0].expired === true) break;
        yield* Effect.sleep("30 millis");
      }

      yield* hold("COMMIT");
      yield* expectStatus(yield* Fiber.join(delayed), 400);
    }).pipe(
      Effect.ensuring(
        hold("ROLLBACK").pipe(
          Effect.orDie,
          Effect.andThen(Effect.sync(() => holder.release())),
        ),
      ),
    );

    assert.equal(
      (yield* query(
        `SELECT count(*)::int AS count FROM auth."user" WHERE email='onboarding-expiry@example.invalid'`,
      )).rows[0].count,
      0,
    );
    // Expiry is enforced immediately; physical secret cleanup belongs to the backend lifetime.
    const cleanupApplication = yield* submit("onboarding-cleanup@example.invalid", "Cleanup");
    yield* backend.stop;
    // Seed an already-expired pending effect; invitation timestamps are immutable.
    const cleanupId = "expiry-cleanup";
    const cleanupToken = "onboard_" + randomBytes(32).toString("hex");
    yield* query(
      `INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) SELECT $2,application_id,applicant_id,$3,date_trunc('milliseconds',clock_timestamp(),'UTC')-interval '1 second','Open',$4,date_trunc('milliseconds',clock_timestamp(),'UTC')-interval '24 hours 1 second' FROM admission_applications WHERE application_id=$1`,
      [
        cleanupApplication.applicationId,
        cleanupId,
        createHash("sha256").update(cleanupToken).digest("hex"),
        leaderId,
      ],
    );
    yield* query(
      `INSERT INTO applicant_account_delivery(invitation_id,state,recipient,secret,envelope) VALUES($1,'Pending','onboarding-cleanup@example.invalid',$2,'{}'::jsonb)`,
      [cleanupId, cleanupToken],
    );
    yield* query(`CREATE FUNCTION public.reject_onboarding_expiry_rehearsal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic expiry cleanup failure'; END $$;
    CREATE TRIGGER reject_onboarding_expiry_rehearsal BEFORE UPDATE ON applicant_account_delivery FOR EACH ROW WHEN (OLD.state='Pending' AND NEW.state='Cancelled') EXECUTE FUNCTION public.reject_onboarding_expiry_rehearsal()`);
    backend = yield* startBackend;

    const failedWorkerExit = yield* backend.exitCode.pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(new ProbeFailure({ message: "expiry worker failure did not stop backend" })),
      }),
    );

    assert.equal(failedWorkerExit, 1, "unexpected expiry worker failure must not report success");
    yield* query(
      "DROP TRIGGER reject_onboarding_expiry_rehearsal ON applicant_account_delivery; DROP FUNCTION public.reject_onboarding_expiry_rehearsal()",
    );
    backend = yield* startBackend;
    yield* ready;

    for (let attempt = 0; ; attempt++) {
      const cleaned = (yield* query(
        "SELECT state, secret IS NULL AS secret_removed, envelope IS NULL AS envelope_removed FROM applicant_account_delivery WHERE invitation_id=$1",
        [cleanupId],
      )).rows[0];

      if (
        cleaned.state === "Cancelled" &&
        cleaned.secret_removed === true &&
        cleaned.envelope_removed === true
      )
        break;
      assert.ok(attempt < 50, "startup expiry cleanup must erase the pending secret");
      yield* Effect.sleep("100 millis");
    }

    const manifest = {
      revision,
      backendOrigin,
      dashboardOrigin,
      artifacts,
      departmentId,
      semesterId,
      schoolId: 995,
      persons,
      applicationId: browserApplication.applicationId,
      mailboxOrigin,
      mailboxToken,
    };

    const manifestPath = path.join(artifacts, "manifest.json");
    yield* fs.writeFileString(manifestPath, yield* jsonText(manifest), { mode: 0o600 });
    let browserEvidence: Schema.Json = null;

    if (mode === "--browser") {
      let output = "";

      const browserRun = yield* startOwnedProcess({
        command: "bun",
        args: ["apps/dashboard/e2e/run-real-native-onboarding.mjs"],
        cwd: root,
        env: { ...environment, ONBOARDING_JOURNEY_MANIFEST: manifestPath },
        output: (text) => {
          output += text;
        },
      });

      const browserFailed = () => new ProbeFailure({ message: "Browser journey failed: " + safe(output) });

      const code = yield* browserRun.exitCode.pipe(
        Effect.timeoutOrElse({
          duration: "300 seconds",
          orElse: () => browserRun.stop.pipe(Effect.andThen(Effect.fail(browserFailed()))),
        }),
        Effect.catchTag("AcceptanceCommandFailed", () => Effect.fail(browserFailed())),
      );

      if (code !== 0) return yield* browserFailed();

      browserEvidence = yield* Schema.decodeEffect(JsonBody)(
        yield* fs.readFileString(path.join(artifacts, "browser-evidence.json")),
      );

      const observed = (yield* query(
        `SELECT l.person_id FROM applicant_account_links l JOIN admission_applicants a USING(applicant_id) WHERE a.email=$1`,
        [persons.applicant.email],
      )).rows;

      assert.equal(observed.length, 1);
      assert.equal(
        (yield* query(
          `SELECT count(*)::int AS count FROM assistant_placements WHERE person_id=$1 AND active`,
          [observed[0].person_id],
        )).rows[0].count,
        1,
      );
    }

    assert.equal(
      (yield* query(
        `SELECT count(*)::int AS count FROM applicant_account_delivery WHERE state IN ('Delivered','Cancelled') AND (secret IS NOT NULL OR envelope IS NOT NULL)`,
      )).rows[0].count,
      0,
    );

    const evidence: Schema.JsonObject = {
      revision,
      passed: true,
      mode,
      browserEvidence,
      mailAttempts: attempts,
      acceptedDeliveries: mail.size,
      gates: [
        "public application native authority",
        "scoped coordinator invitation and idempotency conflict",
        "wrong department, inactive issuer and revoked receipt replay denied",
        "real credential write failure rolls back account/profile/link/consumption",
        "existing claim preserves profile/credentials",
        "email collision rejected",
        "concurrent claim one account",
        "failed delivery restart retry",
        "revoked and consumed token rejected",
        "terminal secret cleanup",
        "expired pending secret erased on restart; failed expiry worker exits nonzero",
        "claim rejects expiry crossed while waiting for applicant lock",
      ],
      scope: "synthetic loopback only",
    };

    return evidence;
  }).pipe(Effect.scoped);

  const evidence = yield* checks;
  assertNoSecrets(yield* jsonText(evidence));
  const evidencePath = path.join(artifacts, "evidence.json");

  yield* fs.writeFileString(
    evidencePath,
    yield* indentedJsonText(
      Struct.assign(evidence, { cleanup: "owned processes and credential manifest removed" }),
    ),
  );
  yield* Console.log(evidencePath);
});

BunRuntime.runMain(
  journey.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);

      return Effect.fail(
        new OnboardingFailed({
          message: safe(error instanceof Error ? error.message : "Onboarding runtime failed"),
        }),
      );
    }),
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  ),
);
