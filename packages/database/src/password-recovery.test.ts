/**
 * EX-0021: native stable SQL carries upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { startDisposablePostgres } from "@monoweb/postgres";
import { createLocalAccountIssuer } from "better-auth";
import { Context, Layer, Logger, Redacted } from "effect";
import { Database } from "./service.js";
import { DatabaseLive } from "./layers.js";
import { AuthPoolLive } from "./pg-pool.js";
import {
  NativeAuthEngine,
  NativeAuthEngineLive,
  withNativeAuthProvisioning,
} from "./auth-engine.js";
import { PasswordRecovery } from "./password-recovery.js";
import { expect, layer } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Schema } from "effect";
import { MailDeliveryError } from "@vektorprogrammet/domain/mail";
import { IdentityEngineError, IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { withPostgresTestDatabase } from "./test-support/postgres.js";
import { TestPlatform } from "./test-support/platform.js";
import type { AuthEngineConfig } from "./auth-engine.js";
import {
  drainPasswordResetMail,
  makePasswordRecovery,
  withIdentityRequestCancellation,
} from "./password-recovery.js";
import * as SqlClient from "effect/sql/SqlClient";
import { executePostgresMigration } from "./postgres-migration-statements.js";

const config: AuthEngineConfig = {
  postgresUrl: "",
  secret: "synthetic",
  oauth: {
    canonicalOrigin: "http://127.0.0.1:8790",
    dashboardOrigin: "http://127.0.0.1:5174",
    nativeApiResource: "urn:vektorprogrammet:native-api",
  },
  trustedOrigins: ["http://127.0.0.1:5174"],
  secureCookies: false,
} as const;

const context = new IdentityRequestContext({
  requestCorrelation: "focused-recovery",
  sourceIp: null,
  userAgent: null,
});

/** The bytes that `JSON.stringify` writes for `value`. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const recoveryToken = "synthetic-recovery-token";

const secondRecoveryToken = "synthetic-recovery-token-two";

const seedRecoveryRequest = (sql: SqlClient.SqlClient) =>
  executePostgresMigration(`
    INSERT INTO public.person_profiles(person_id, first_name, last_name) VALUES ('recovery-request-person', 'Recovery', 'Request');
    INSERT INTO auth."user"(id, name, email, "emailVerified") VALUES ('recovery-request-person', 'Recovery Request', 'recovery-request@example.invalid', TRUE);
    INSERT INTO auth.verification(id, identifier, value, "expiresAt", "createdAt", "updatedAt")
    VALUES ('recovery-request-verification', 'reset-password:${recoveryToken}', 'recovery-request-person', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `).pipe(Effect.provideService(SqlClient.SqlClient, sql));

const decodeAcceptedAudit = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ event_kind: Schema.String, request_correlation: Schema.String })),
);

/** The audit rows that the enqueue itself writes; the handler writes its own response row. */
const enqueueAuditSql =
  "SELECT event_kind, request_correlation FROM auth.identity_security_audit WHERE event_kind='password-reset-request-accepted' AND details->>'outcomeCode'='mail-enqueued'";

/**
 * One migrated, disposable PostgreSQL cluster for `use`. A failed statement inside a transaction
 * rolls it back, a wire path that the PGlite socket server does not survive; real PostgreSQL
 * carries every failure-path proof.
 */
const withRealPostgres = <A, E, R>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const cluster = yield* Effect.acquireRelease(
      Effect.promise(() => startDisposablePostgres({ listen: "tcp", maxConnections: 4 })),
      (disposable) => Effect.promise(() => disposable.stop()),
    );

    const services = yield* Layer.build(
      DatabaseLive({
        url: Redacted.make(cluster.url),
        maxConnections: 2,
        applicationName: "recovery-failure-proof",
      }),
    );

    return yield* use(Context.get(services, Database));
  }).pipe(Effect.scoped);

/**
 * Runs the real request handler, captures the sendResetPassword program that the engine would run
 * in a background task, and returns it after the request scope has ended.
 */
const captureSendResetPassword = (
  sql: SqlClient.SqlClient,
  requestContext = context,
  token = recoveryToken,
) =>
  Effect.gen(function* () {
    const recovery = makePasswordRecovery(sql, config);
    let captured: Effect.Effect<void, IdentityEngineError> | undefined;

    yield* recovery.handler(
      () => {
        captured = recovery.sendResetPassword({
          user: { id: "recovery-request-person" },
          token,
          url: `${config.oauth.canonicalOrigin}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(`${config.oauth.dashboardOrigin}/tilbakestill-passord`)}`,
        });

        return Promise.resolve(Response.json({ status: true }));
      },
      new Request(`${config.oauth.canonicalOrigin}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
        body: yield* jsonText({
          email: "recovery-request@example.invalid",
          redirectTo: `${config.oauth.dashboardOrigin}/tilbakestill-passord`,
        }),
      }),
      requestContext,
    );

    if (captured === undefined) return yield* Effect.die("the engine callback did not run");

    return { program: captured };
  });

const seedRecoveryDelivery = (sql: SqlClient.SqlClient) =>
  executePostgresMigration(`
  INSERT INTO public.person_profiles(person_id, first_name, last_name) VALUES ('recovery-delivery-person', 'Recovery', 'Delivery');
  INSERT INTO auth."user"(id, name, email, "emailVerified") VALUES ('recovery-delivery-person', 'Recovery Delivery', 'recovery-delivery@example.invalid', TRUE);
  INSERT INTO auth.verification(id, identifier, value, "expiresAt", "createdAt", "updatedAt")
  VALUES ('recovery-delivery-verification', 'reset-password:synthetic-delivery-token', 'recovery-delivery-person', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  INSERT INTO auth.password_reset_email_outbox(effect_id, verification_id, subject_person_id, status)
  VALUES ('password-reset:recovery-delivery-verification', 'recovery-delivery-verification', 'recovery-delivery-person', 'Pending');
`).pipe(Effect.provideService(SqlClient.SqlClient, sql));

const decodeDeliveryStates = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      status: Schema.String,
      attempts: Schema.Int,
      claim_id: Schema.NullOr(Schema.String),
      last_failure_code: Schema.NullOr(Schema.String),
      payload_sha256: Schema.NullOr(Schema.String),
      provider_reference: Schema.NullOr(Schema.String),
    }),
  ),
);

const deliveryStates = (sql: SqlClient.SqlClient) =>
  sql
    .unsafe(
      "SELECT status, attempts, claim_id, last_failure_code, payload_sha256, provider_reference FROM auth.password_reset_email_outbox",
    )
    .pipe(Effect.flatMap(decodeDeliveryStates));

layer(TestPlatform, { excludeTestServices: true })("owned recovery boundary", (it) => {
  it("keeps cancellation's success, failure and Database requirement channels", () => {
    const request = new Request("http://127.0.0.1:8790/api/auth/get-session");

    const operation = Database.use((sql) =>
      sql.unsafe("SELECT 1").pipe(
        Effect.as("retained" as const),
        Effect.mapError(() => new MailDeliveryError({ kind: "temporary-unavailability" })),
      ),
    );

    const guarded = operation.pipe(withIdentityRequestCancellation(request));
    expectTypeOf<Effect.Success<typeof guarded>>().toEqualTypeOf<"retained">();
    expectTypeOf<Effect.Error<typeof guarded>>().toEqualTypeOf<MailDeliveryError>();
    expectTypeOf<Effect.Services<typeof guarded>>().toEqualTypeOf<Database>();
    expectTypeOf<Effect.Services<typeof guarded>>().not.toEqualTypeOf<never>();
    expectTypeOf<Effect.Error<typeof guarded>>().not.toEqualTypeOf<never>();
  });

  it.effect("preserves typed failures and defects without cancelling a completed operation", () =>
    Effect.gen(function* () {
      const request = new Request("http://127.0.0.1:8790/api/auth/get-session");
      const failure = new MailDeliveryError({ kind: "permanent-rejection" });
      expect(
        yield* Effect.flip(Effect.fail(failure).pipe(withIdentityRequestCancellation(request))),
      ).toBe(failure);

      const defect = yield* Effect.exit(
        Effect.die("request-defect").pipe(withIdentityRequestCancellation(request)),
      );

      expect(Exit.isFailure(defect) && Cause.hasInterrupts(defect.cause)).toBe(false);
      expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true);
    }),
  );

  it.effect(
    "enqueues a reset mail from a task that runs outside the request's ambient scope",
    () =>
      withPostgresTestDatabase((sql) =>
        Effect.gen(function* () {
          yield* seedRecoveryRequest(sql);
          const { program } = yield* captureSendResetPassword(sql);

          // Better Auth runs this task after the request scope ended: ambient storage is empty.
          yield* program;

          expect(
            yield* sql.unsafe(enqueueAuditSql).pipe(Effect.flatMap(decodeAcceptedAudit)),
          ).toEqual([
            {
              event_kind: "password-reset-request-accepted",
              request_correlation: context.requestCorrelation,
            },
          ]);
          expect((yield* deliveryStates(sql)).length).toBe(1);
        }),
      ),
    15_000,
  );

  it.effect(
    "logs the real cause of a failed enqueue without secrets and keeps the public failure",
    () =>
      withRealPostgres((sql) =>
        Effect.gen(function* () {
          yield* seedRecoveryRequest(sql);

          yield* executePostgresMigration(
            `CREATE FUNCTION auth.refuse_recovery_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recovery outbox refused'; END $$; CREATE TRIGGER refuse_recovery_outbox BEFORE INSERT ON auth.password_reset_email_outbox FOR EACH ROW EXECUTE FUNCTION auth.refuse_recovery_outbox()`,
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql));

          const { program } = yield* captureSendResetPassword(sql);
          const lines: Array<string> = [];
          const capture = Logger.make((options) => lines.push(Logger.formatSimple.log(options)));

          const failure = yield* Effect.flip(program.pipe(Effect.provide(Logger.layer([capture]))));

          expect(failure).toMatchObject({
            operation: "sendResetPassword",
            message: "Recovery enqueue unavailable",
          });
          expect(lines.join("\n")).toContain("recovery outbox refused");
          expect(lines.join("\n")).not.toContain(recoveryToken);
        }),
      ),
    15_000,
  );

  it.effect(
    "keeps each sequential request's own context in its audit rows",
    () =>
      withPostgresTestDatabase((sql) =>
        Effect.gen(function* () {
          yield* seedRecoveryRequest(sql);

          const first = new IdentityRequestContext({
            requestCorrelation: "recovery-request-one",
            sourceIp: null,
            userAgent: null,
          });

          const second = new IdentityRequestContext({
            requestCorrelation: "recovery-request-two",
            sourceIp: null,
            userAgent: null,
          });

          yield* executePostgresMigration(`
          INSERT INTO auth.verification(id, identifier, value, "expiresAt", "createdAt", "updatedAt")
          VALUES ('recovery-request-verification-two', 'reset-password:${secondRecoveryToken}', 'recovery-request-person', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        `).pipe(Effect.provideService(SqlClient.SqlClient, sql));

          const firstCapture = yield* captureSendResetPassword(sql, first);
          yield* firstCapture.program;
          const secondCapture = yield* captureSendResetPassword(sql, second, secondRecoveryToken);
          yield* secondCapture.program;

          expect(
            yield* sql
              .unsafe(enqueueAuditSql + " ORDER BY request_correlation")
              .pipe(Effect.flatMap(decodeAcceptedAudit)),
          ).toEqual([
            {
              event_kind: "password-reset-request-accepted",
              request_correlation: "recovery-request-one",
            },
            {
              event_kind: "password-reset-request-accepted",
              request_correlation: "recovery-request-two",
            },
          ]);
        }),
      ),
    15_000,
  );

  it.effect(
    "runs supported Better Auth reset and session revocation against real native PostgreSQL",
    () =>
      Effect.gen(function* () {
        const cluster = yield* Effect.acquireRelease(
          Effect.promise(() => startDisposablePostgres({ listen: "tcp", maxConnections: 8 })),
          (cluster) => Effect.promise(() => cluster.stop()),
        );

        const liveConfig = {
          ...config,
          postgresUrl: cluster.url,
          secret: "native-recovery-proof-secret-at-least-thirty-two-characters",
        };

        const services = yield* Layer.build(
          NativeAuthEngineLive(liveConfig).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                DatabaseLive({
                  url: Redacted.make(cluster.url),
                  maxConnections: 1,
                  applicationName: "native-recovery-proof-sql",
                }),
                AuthPoolLive(liveConfig, {
                  maxConnections: 1,
                  applicationName: "native-recovery-proof-auth",
                  pipeline: true,
                  startupOptions: "-c search_path=auth",
                }),
              ),
            ),
          ),
        );

        const sql = Context.get(services, Database);
        const engine = Context.get(services, NativeAuthEngine);
        const recovery = Context.get(services, PasswordRecovery);
        yield* sql.unsafe(
          "INSERT INTO public.person_profiles(person_id, first_name, last_name) VALUES ('real-recovery-person', 'Real', 'Recovery')",
        );
        const engineContext = yield* Effect.promise(() => engine.$context);
        yield* withNativeAuthProvisioning(engineContext, () =>
          engineContext.internalAdapter.createUser(
            {
              id: "real-recovery-person",
              name: "Real Recovery",
              email: "real-recovery@example.invalid",
              emailVerified: true,
            },
            { method: "email-password" },
          ),
        );
        const oldPassword = "OriginalRecoveryPassword!2032";
        const password = yield* Effect.tryPromise(() => engineContext.password.hash(oldPassword));
        yield* withNativeAuthProvisioning(engineContext, () =>
          engineContext.internalAdapter.linkAccount({
            accountId: "real-recovery-person",
            providerId: "credential",
            issuer: createLocalAccountIssuer("credential"),
            userId: "real-recovery-person",
            password,
          }),
        );

        const signedIn = yield* Effect.tryPromise(() =>
          engine.api.signInEmail({
            body: { email: "real-recovery@example.invalid", password: oldPassword },
            asResponse: true,
          }),
        );

        expect(signedIn.status).toBe(200);
        expect(
          (yield* sql.unsafe('SELECT id FROM auth."session" WHERE "userId"=$1', [
            "real-recovery-person",
          ])).length,
        ).toBe(1);

        const accepted = yield* recovery.handler(
          engine.handler,
          new Request(config.oauth.canonicalOrigin + "/api/auth/request-password-reset", {
            method: "POST",
            headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
            body: yield* jsonText({
              email: "real-recovery@example.invalid",
              redirectTo: config.oauth.dashboardOrigin + "/tilbakestill-passord",
            }),
          }),
          context,
        );

        expect(accepted.status).toBe(200);
        expect(yield* deliveryStates(sql)).toMatchObject([{ status: "Pending", attempts: 0 }]);

        const delivered = yield* drainPasswordResetMail(
          sql,
          liveConfig,
          {
            deliver: () =>
              sql
                .unsafe("SELECT 1 AS provider_can_use_sql")
                .pipe(
                  Effect.orDie,
                  Effect.as({ providerReference: "real-pg-test-provider-receipt" }),
                ),
          },
          "recovery-sender@example.invalid",
        );

        expect(delivered).toBe("Delivered");

        const verification = yield* sql
          .unsafe("SELECT identifier FROM auth.verification WHERE value=$1", [
            "real-recovery-person",
          ])
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ identifier: Schema.String })),
              ),
            ),
          );

        const token = verification[0]?.identifier.slice("reset-password:".length);
        expect(token).toBeDefined();
        const newPassword = "RecoveredNativePassword!2032";

        const reset = yield* recovery.handler(
          engine.handler,
          new Request(config.oauth.canonicalOrigin + "/api/auth/reset-password", {
            method: "POST",
            headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
            body: yield* jsonText({ token, newPassword }),
          }),
          context,
        );

        expect(reset.status).toBe(200);
        expect(
          yield* sql.unsafe('SELECT id FROM auth."session" WHERE "userId"=$1', [
            "real-recovery-person",
          ]),
        ).toEqual([]);

        const rejectedBody = yield* jsonText({
          email: "real-recovery@example.invalid",
          password: oldPassword,
        });

        const rejectedOldPassword = yield* Effect.tryPromise(() =>
          engine.handler(
            new Request(config.oauth.canonicalOrigin + "/api/auth/sign-in/email", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
              body: rejectedBody,
            }),
          ),
        );

        expect(rejectedOldPassword.status).toBe(401);

        const recovered = yield* Effect.tryPromise(() =>
          engine.api.signInEmail({
            body: { email: "real-recovery@example.invalid", password: newPassword },
            asResponse: true,
          }),
        );

        expect(recovered.status).toBe(200);
        expect(yield* deliveryStates(sql)).toMatchObject([
          { status: "Delivered", claim_id: null, attempts: 1 },
        ]);
      }),
    120_000,
  );

  it.effect(
    "commits a provider receipt without retaining a claim-owned SQL connection",
    () =>
      withPostgresTestDatabase((sql) =>
        Effect.gen(function* () {
          yield* seedRecoveryDelivery(sql);

          const result = yield* drainPasswordResetMail(
            sql,
            config,
            {
              deliver: () =>
                sql
                  .unsafe("SELECT 1 AS provider_can_use_sql")
                  .pipe(
                    Effect.orDie,
                    Effect.as({ providerReference: "recovery-provider-receipt" }),
                  ),
            },
            "recovery-sender@example.invalid",
          );

          expect(result).toBe("Delivered");
          expect(yield* deliveryStates(sql)).toMatchObject([
            {
              status: "Delivered",
              attempts: 1,
              claim_id: null,
              provider_reference: "recovery-provider-receipt",
            },
          ]);
          expect((yield* deliveryStates(sql))[0]?.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
          expect(
            yield* drainPasswordResetMail(
              sql,
              config,
              { deliver: () => Effect.die("completed delivery must not replay") },
              "recovery-sender@example.invalid",
            ),
          ).toBe("Empty");
        }),
      ),
    15_000,
  );

  it.effect(
    "quarantines bounded temporary provider failures at the third attempted delivery",
    () =>
      withPostgresTestDatabase((sql) =>
        Effect.gen(function* () {
          yield* seedRecoveryDelivery(sql);

          const mail = {
            deliver: () => Effect.fail(new MailDeliveryError({ kind: "temporary-unavailability" })),
          };

          expect(
            yield* drainPasswordResetMail(sql, config, mail, "recovery-sender@example.invalid"),
          ).toBe("Failed");
          expect(
            yield* drainPasswordResetMail(sql, config, mail, "recovery-sender@example.invalid"),
          ).toBe("Failed");
          expect(
            yield* drainPasswordResetMail(sql, config, mail, "recovery-sender@example.invalid"),
          ).toBe("Quarantined");
          expect(yield* deliveryStates(sql)).toMatchObject([
            {
              status: "Quarantined",
              attempts: 3,
              claim_id: null,
              last_failure_code: "provider-unavailable",
            },
          ]);
        }),
      ),
    15_000,
  );

  it.effect(
    "persists ambiguous-delivery quarantine before interruption propagates",
    () =>
      withPostgresTestDatabase((sql) =>
        Effect.gen(function* () {
          yield* seedRecoveryDelivery(sql);
          const acquired = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();

          const fiber = yield* Effect.forkChild(
            drainPasswordResetMail(
              sql,
              config,
              {
                deliver: () =>
                  Deferred.succeed(acquired, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(released, undefined)),
                  ),
              },
              "recovery-sender@example.invalid",
            ),
          );

          yield* Deferred.await(acquired);
          yield* Fiber.interrupt(fiber);
          yield* Deferred.await(released);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(yield* deliveryStates(sql)).toMatchObject([
            {
              status: "Quarantined",
              attempts: 1,
              claim_id: null,
              last_failure_code: "delivery-timeout",
            },
          ]);
        }),
      ),
    15_000,
  );

  it.effect(
    "refuses a provider receipt after the persisted claim fence changes",
    () =>
      withPostgresTestDatabase((sql) =>
        Effect.gen(function* () {
          yield* seedRecoveryDelivery(sql);

          const result = yield* drainPasswordResetMail(
            sql,
            config,
            {
              deliver: () =>
                sql
                  .unsafe(
                    "UPDATE auth.password_reset_email_outbox SET claim_id=gen_random_uuid() WHERE status='Processing'",
                  )
                  .pipe(
                    Effect.orDie,
                    Effect.as({ providerReference: "lost-claim-provider-receipt" }),
                  ),
            },
            "recovery-sender@example.invalid",
          );

          expect(result).toBe("LostClaim");
          expect(yield* deliveryStates(sql)).toMatchObject([
            { status: "Processing", attempts: 1, provider_reference: null },
          ]);
          expect(
            yield* sql.unsafe(
              "SELECT event_id FROM auth.identity_security_audit WHERE event_kind='password-reset-mail-delivered'",
            ),
          ).toEqual([]);
        }),
      ),
    15_000,
  );

  it.effect("interrupts an already-aborted request before starting work", () => {
    const controller = new AbortController();

    const request = new Request("http://127.0.0.1:8790/api/auth/get-session", {
      signal: controller.signal,
    });

    let invoked = false;

    const program = Effect.sync(() => {
      invoked = true;
    }).pipe(withIdentityRequestCancellation(request));

    controller.abort();

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(program);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(invoked).toBe(false);
    });
  });

  it.effect(
    "propagates actual request abortion through the host callback and awaits cleanup",
    () => {
      const controller = new AbortController();

      return withPostgresTestDatabase((sql) =>
        Effect.gen(function* () {
          const acquired = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();
          const run = yield* FiberSet.makeRuntimePromise();

          const request = new Request("http://127.0.0.1:8790/api/auth/request-password-reset", {
            method: "POST",
            signal: controller.signal,
            headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
            body: yield* jsonText({
              email: "cancel@example.invalid",
              redirectTo: config.oauth.dashboardOrigin + "/tilbakestill-passord",
            }),
          });

          const recovery = makePasswordRecovery(sql, config);

          const fiber = yield* Effect.forkChild(
            recovery.handler(
              (incoming) =>
                run(
                  Deferred.succeed(acquired, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(released, undefined)),
                  ),
                  { signal: incoming.signal },
                ),
              request,
              context,
            ),
          );

          yield* Deferred.await(acquired);
          controller.abort();
          const exit = yield* Fiber.await(fiber);
          yield* Deferred.await(released);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(controller.signal.aborted).toBe(true);
          expect(
            yield* sql.unsafe("SELECT effect_id FROM auth.password_reset_email_outbox"),
          ).toEqual([]);
        }),
      );
    },
    15_000,
  );

  it.effect(
    "rejects a trusted-origin different callback path before invoking credential engine",
    () =>
      withPostgresTestDatabase((pool) =>
        Effect.gen(function* () {
          const recovery = makePasswordRecovery(pool, config);
          let called = false;

          const r = yield* recovery.handler(
            () => {
              called = true;

              return Promise.resolve(Response.json({ status: true }));
            },
            new Request("http://127.0.0.1:8790/api/auth/request-password-reset", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
              body: yield* jsonText({
                email: "synthetic@example.invalid",
                redirectTo: "http://127.0.0.1:5174/login",
              }),
            }),
            context,
          );

          expect(r.status).toBe(403);
          expect(called).toBe(false);
          const audit = yield* pool.unsafe(`SELECT details FROM auth.identity_security_audit`);
          const auditText = yield* jsonText(audit);
          expect(auditText).toContain("redirect-not-allowed");
          expect(auditText).not.toContain("synthetic@example.invalid");
        }),
      ),
    15_000,
  );
  it.effect(
    "rejects reset query tokens before invoking credential engine",
    () =>
      withPostgresTestDatabase((pool) =>
        Effect.gen(function* () {
          const recovery = makePasswordRecovery(pool, config);
          let called = false;

          const r = yield* recovery.handler(
            () => {
              called = true;

              return Promise.resolve(Response.json({ status: true }));
            },
            new Request("http://127.0.0.1:8790/api/auth/reset-password?token=forbidden-query", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin },
            }),
            context,
          );

          expect(r.status).toBe(403);
          expect(called).toBe(false);
        }),
      ),
    15_000,
  );
  it.effect(
    "cannot claim complete success without the credential engine establishing its subject",
    () =>
      withPostgresTestDatabase((pool) =>
        Effect.gen(function* () {
          const recovery = makePasswordRecovery(pool, config);

          const r = yield* recovery.handler(
            () => Promise.resolve(Response.json({ status: true })),
            new Request("http://127.0.0.1:8790/api/auth/reset-password", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin },
            }),
            context,
          );

          expect(r.status).toBe(503);
        }),
      ),
    15_000,
  );
  it.effect(
    "concealed request audit failure replaces engine success with unavailable",
    () =>
      withPostgresTestDatabase((pool) =>
        Effect.gen(function* () {
          yield* executePostgresMigration(
            `CREATE FUNCTION auth.reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON auth.identity_security_audit FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_audit()`,
          ).pipe(Effect.provideService(SqlClient.SqlClient, pool));
          const recovery = makePasswordRecovery(pool, config);

          const r = yield* recovery.handler(
            () => Promise.resolve(Response.json({ status: true })),
            new Request("http://127.0.0.1:8790/api/auth/request-password-reset", {
              method: "POST",
              headers: { origin: config.oauth.dashboardOrigin, "content-type": "application/json" },
              body: yield* jsonText({
                email: "unknown@example.invalid",
                redirectTo: "http://127.0.0.1:5174/tilbakestill-passord",
              }),
            }),
            context,
          );

          expect(r.status).toBe(503);
        }),
      ),
    15_000,
  );
});
