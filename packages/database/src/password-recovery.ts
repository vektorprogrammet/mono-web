import { DatabasePgPool, pgQuery, pgTransaction } from "./pg-pool.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { Pool, PoolClient } from "pg";
import {
  IdentityEngineError,
  type IdentityRequestContext,
  type IdentitySecurityEventKind,
  type IdentitySecurityOutcomeCode,
} from "@vektorprogrammet/domain/identity";
import type { MailOperations } from "@vektorprogrammet/domain/mail";
import type { AuthEngineConfig } from "./auth-engine.js";

interface Coordination {
  readonly context: IdentityRequestContext;
  enqueue: "Absent" | "Accepted" | "Failed";
  subject: string | null;
}

const unavailable = () =>
  Response.json(
    { code: "RECOVERY_UNAVAILABLE" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );

const encodeAuditDetails = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ outcomeCode: Schema.String, affectedSessionCount: Schema.Null }),
  ),
);

const audit = (
  db: Pool | PoolClient,
  kind: IdentitySecurityEventKind,
  code: IdentitySecurityOutcomeCode,
  subject: string | null,
  context: IdentityRequestContext | null,
) =>
  Effect.gen(function* () {
    const details = yield* encodeAuditDetails({ outcomeCode: code, affectedSessionCount: null });

    yield* pgQuery(
      db,
      `INSERT INTO auth.identity_security_audit(event_id,event_kind,subject_person_id,request_correlation,details)
    VALUES($1,$2,$3,$4,$5::jsonb)`,
      [randomUUID(), kind, subject, context?.requestCorrelation ?? null, details],
    );
  });

/** The mail request whose canonical JSON the outbox row freezes as `payload_sha256`. */
const encodeMailRequestJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      deliveryId: Schema.String,
      sender: Schema.String,
      recipient: Schema.String,
      subject: Schema.String,
      text: Schema.String,
    }),
  ),
);

/** Better Auth's password-reset callbacks and the request scope they run in. */
export interface PasswordRecoveryService {
  /** Better Auth's `sendResetPassword`; it runs inside the request scope that `handler` opened. */
  readonly sendResetPassword: (data: {
    readonly user: { readonly id: string };
    readonly token: string;
    readonly url: string;
  }) => Effect.Effect<void, IdentityEngineError>;
  /** Better Auth's `onPasswordReset`; it runs inside the request scope that `handler` opened. */
  readonly onPasswordReset: (data: {
    readonly user: { readonly id: string };
  }) => Effect.Effect<void>;
  /** Answers one request with `engineHandler`, owning the password-recovery routes. */
  readonly handler: (
    engineHandler: (request: Request) => Promise<Response>,
    request: Request,
    context: IdentityRequestContext,
  ) => Effect.Effect<Response, IdentityEngineError>;
}

/** One AsyncLocalStorage scope per HTTP request; never keyed by caller-controlled correlation. */
export const makePasswordRecovery = (
  pool: Pool,
  config: AuthEngineConfig,
): PasswordRecoveryService => {
  const local = new AsyncLocalStorage<Coordination>();
  const callback = `${config.oauth.dashboardOrigin}/tilbakestill-passord`;

  if (!config.trustedOrigins.includes(config.oauth.dashboardOrigin))
    throw new Error("Recovery dashboard origin is not trusted");

  const enqueueResetMail = (user: { id: string }, token: string, url: string) =>
    Effect.gen(function* () {
      if (
        url !==
        `${config.oauth.canonicalOrigin}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(callback)}`
      ) {
        return yield* new IdentityEngineError({
          operation: "sendResetPassword",
          message: "Recovery callback mismatch",
        });
      }

      return yield* pgTransaction(pool, (client) =>
        Effect.gen(function* () {
          yield* pgQuery(client, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
            `vektorprogrammet:person-authorization:v1:${user.id}`,
          ]);

          const usable = yield* pgQuery(
            client,
            `SELECT 1 FROM auth."user" WHERE id=$1 AND NOT access_disabled`,
            [user.id],
          );

          if (usable.rowCount !== 1) {
            yield* pgQuery(
              client,
              `DELETE FROM auth.verification WHERE identifier=$1 AND value=$2`,
              [`reset-password:${token}`, user.id],
            );

            return false;
          }

          const verification = yield* pgQuery<{ id: string }>(
            client,
            `SELECT id FROM auth.verification WHERE identifier=$1 AND value=$2 AND "expiresAt">CURRENT_TIMESTAMP`,
            [`reset-password:${token}`, user.id],
          );

          const [row] = verification.rows;

          if (verification.rows.length !== 1 || row === undefined) {
            return yield* new IdentityEngineError({
              operation: "sendResetPassword",
              message: "Recovery verification missing",
            });
          }

          yield* pgQuery(
            client,
            `INSERT INTO auth.password_reset_email_outbox(effect_id,verification_id,subject_person_id,status) VALUES($1,$2,$3,'Pending')`,
            [`password-reset:${row.id}`, row.id, user.id],
          );
          yield* audit(
            client,
            "password-reset-request-accepted",
            "mail-enqueued",
            user.id,
            local.getStore()?.context ?? null,
          );

          return true;
        }),
      );
    });

  return {
    /**
     * Better Auth calls this inside the request scope that `handler` opened. The scope is read
     * when Better Auth calls, before the returned program runs.
     */
    sendResetPassword: ({
      user,
      token,
      url,
    }: {
      user: { id: string };
      token: string;
      url: string;
    }) => {
      const state = local.getStore();

      if (!state) {
        return Effect.fail(
          new IdentityEngineError({
            operation: "sendResetPassword",
            message: "Recovery requires an owned request",
          }),
        );
      }

      return enqueueResetMail(user, token, url).pipe(
        Effect.tap((accepted) =>
          Effect.sync(() => {
            state.enqueue = accepted ? "Accepted" : "Absent";
          }),
        ),
        Effect.asVoid,
        Effect.catch(() =>
          Effect.sync(() => {
            state.enqueue = "Failed";
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new IdentityEngineError({
                  operation: "sendResetPassword",
                  message: "Recovery enqueue unavailable",
                }),
              ),
            ),
          ),
        ),
      );
    },
    /** Better Auth calls this inside the request scope that `handler` opened. */
    onPasswordReset: ({ user }: { user: { id: string } }) => {
      const state = local.getStore();

      return Effect.sync(() => {
        if (state) state.subject = user.id;
      });
    },
    handler: (
      engineHandler: (request: Request) => Promise<Response>,
      request: Request,
      context: IdentityRequestContext,
    ): Effect.Effect<Response, IdentityEngineError> => {
      const url = new URL(request.url);

      const requesting =
        request.method === "POST" && url.pathname === "/api/auth/request-password-reset";

      const resetting = request.method === "POST" && url.pathname === "/api/auth/reset-password";

      const following =
        request.method === "GET" && url.pathname.startsWith("/api/auth/reset-password/");

      if (!requesting && !resetting && !following) {
        return Effect.tryPromise({
          try: () => engineHandler(request),
          catch: (cause) =>
            new IdentityEngineError({
              operation: "handler",
              message: cause instanceof Error ? cause.message : "identity engine failure",
            }),
        });
      }

      const state: Coordination = { context, enqueue: "Absent", subject: null };

      const reject = (code: "origin-not-trusted" | "redirect-not-allowed") =>
        audit(pool, "password-reset-request-rejected", code, null, context).pipe(
          Effect.as(Response.json({ code: "RECOVERY_REJECTED" }, { status: 403 })),
        );

      return Effect.gen(function* () {
        if (
          (requesting || resetting) &&
          !config.trustedOrigins.includes(request.headers.get("origin") ?? "")
        )
          return yield* reject("origin-not-trusted");

        if (
          following &&
          (url.searchParams.getAll("callbackURL").length !== 1 ||
            url.searchParams.get("callbackURL") !== callback)
        )
          return yield* reject("redirect-not-allowed");

        if (requesting) {
          const body = yield* Effect.tryPromise(() => request.clone().json()).pipe(Effect.option);

          if (Option.isNone(body)) {
            yield* audit(pool, "password-reset-request-rejected", "input-invalid", null, context);

            return Response.json({ code: "INPUT_INVALID" }, { status: 400 });
          }

          const redirect = Schema.decodeUnknownOption(Schema.Struct({ redirectTo: Schema.String }))(
            body.value,
          );

          if (Option.isNone(redirect) || redirect.value.redirectTo !== callback)
            return yield* reject("redirect-not-allowed");
        }

        if (resetting && url.search) return yield* reject("redirect-not-allowed");

        // Better Auth calls sendResetPassword and onPasswordReset inside this request scope.
        const response = yield* Effect.tryPromise({
          try: () => local.run(state, () => engineHandler(request)),
          catch: (cause) =>
            new IdentityEngineError({
              operation: "handler",
              message: cause instanceof Error ? cause.message : "identity engine failure",
            }),
        });

        if (requesting) {
          if (state.enqueue === "Failed") {
            yield* audit(
              pool,
              "password-reset-mail-enqueue-failed",
              "outbox-unavailable",
              null,
              context,
            );

            return unavailable();
          }

          if (state.enqueue === "Absent")
            yield* audit(
              pool,
              response.ok ? "password-reset-request-accepted" : "password-reset-request-rejected",
              response.ok
                ? "identity-undisclosed"
                : response.status === 429
                  ? "rate-limited"
                  : "input-invalid",
              null,
              context,
            );
        }

        if (resetting) {
          if (response.ok && state.subject === null) return unavailable();

          const code = response.ok
            ? undefined
            : yield* Effect.tryPromise(() => response.clone().json()).pipe(
                Effect.map(
                  (body) =>
                    Option.getOrUndefined(
                      Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(body),
                    )?.code,
                ),
                Effect.orElseSucceed(() => undefined),
              );

          yield* audit(
            pool,
            response.ok ? "password-reset-success" : "password-reset-failure",
            response.ok
              ? "password-updated-sessions-revoked"
              : code === "INVALID_TOKEN"
                ? "invalid-token"
                : code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG"
                  ? "password-policy-rejected"
                  : "engine-failure",
            state.subject,
            context,
          );
        }

        response.headers.set("cache-control", "no-store");
        response.headers.set("referrer-policy", "no-referrer");

        return response;
      }).pipe(
        Effect.catch(() =>
          (resetting
            ? Effect.ignore(
                audit(pool, "password-reset-failure", "engine-failure", state.subject, context),
              )
            : Effect.void
          ).pipe(Effect.as(unavailable())),
        ),
      );
    },
  };
};

/** One bounded attempt. SKIP LOCKED and claim fencing allow independent operators safely. */
export const drainPasswordResetMail = (
  pool: Pool,
  config: Pick<AuthEngineConfig, "oauth">,
  mail: MailOperations,
  sender: string,
): Effect.Effect<"Empty" | "Delivered" | "Failed" | "Quarantined" | "LostClaim"> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const claim = randomUUID();

      const row = yield* pgTransaction(pool, (client) =>
        Effect.gen(function* () {
          yield* pgQuery(
            client,
            `UPDATE auth.password_reset_email_outbox SET status='Quarantined',claim_id=NULL,claimed_at=NULL,last_failure_code='stale-claim' WHERE status='Processing' AND claimed_at<CURRENT_TIMESTAMP-INTERVAL '60 seconds'`,
          );

          return (yield* pgQuery<{
            effect_id: string;
            verification_id: string;
            subject_person_id: string;
            attempts: number;
            payload_sha256: string | null;
          }>(
            client,
            `WITH next AS (SELECT effect_id FROM auth.password_reset_email_outbox WHERE status='Pending' OR (status='Failed' AND attempts<3) ORDER BY created_at,effect_id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE auth.password_reset_email_outbox o SET status='Processing',claim_id=$1,claimed_at=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),attempts=attempts+1 FROM next WHERE o.effect_id=next.effect_id RETURNING o.*`,
            [claim],
          )).rows[0];
        }),
      ).pipe(Effect.orDie);

      if (!row) return "Empty";

      const verification = (yield* pgQuery<{
        identifier: string;
        value: string;
        expiresAt: Date;
        email: string | null;
      }>(
        pool,
        `SELECT v.identifier,v.value,v."expiresAt",u.email FROM auth.verification v LEFT JOIN auth."user" u ON u.id=$2 AND NOT u.access_disabled WHERE v.id=$1`,
        [row.verification_id, row.subject_person_id],
      ).pipe(Effect.orDie)).rows[0];

      let failure:
        | "verification-invalid"
        | "verification-expired"
        | "authority-mismatch"
        | "provider-rejected"
        | "provider-unavailable"
        | "delivery-timeout"
        | null = null;

      let providerReference: string | null = null;
      let interruptedCause: Cause.Cause<never> | undefined;
      let quarantined = false;

      if (!verification || !/^reset-password:[A-Za-z0-9_-]+$/.test(verification.identifier)) {
        failure = "verification-invalid";
      } else if (verification.value !== row.subject_person_id || !verification.email) {
        failure = "authority-mismatch";
      } else if (verification.expiresAt.getTime() <= (yield* Clock.currentTimeMillis)) {
        failure = "verification-expired";
      }

      quarantined = failure !== null;

      if (!failure && verification) {
        const token = verification.identifier.slice("reset-password:".length);

        const request = {
          deliveryId: row.effect_id,
          sender,
          recipient: verification.email!,
          subject: "Tilbakestill passordet ditt",
          text: [
            "Det ble bedt om et nytt passord for Vektorprogrammet-kontoen din.",
            "",
            "Bruk denne lenken for å velge et nytt passord:",
            `${config.oauth.canonicalOrigin}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(`${config.oauth.dashboardOrigin}/tilbakestill-passord`)}`,
            `Lenken utløper ${verification.expiresAt.toISOString()}.`,
            "",
            "Hvis du ikke ba om dette, kan du se bort fra e-posten.",
          ].join("\n"),
        };

        const fingerprint = createHash("sha256")
          .update(yield* encodeMailRequestJson(request).pipe(Effect.orDie))
          .digest("hex");

        const frozen = yield* pgQuery(
          pool,
          "UPDATE auth.password_reset_email_outbox SET payload_sha256=COALESCE(payload_sha256,$3) WHERE effect_id=$1 AND claim_id=$2 AND status='Processing' RETURNING payload_sha256",
          [row.effect_id, claim, fingerprint],
        ).pipe(Effect.orDie);

        if (frozen.rowCount !== 1) return "LostClaim";

        if (frozen.rows[0]?.payload_sha256 !== fingerprint) {
          failure = "verification-invalid";
          quarantined = true;
        } else {
          const deliveryExit = yield* Effect.exit(restore(Effect.result(mail.deliver(request))));

          if (Exit.isFailure(deliveryExit)) {
            // Interruption is ambiguous. Persist quarantine before the owning fiber releases the pool.
            if (!Cause.hasInterruptsOnly(deliveryExit.cause))
              return yield* Effect.failCause(deliveryExit.cause);
            interruptedCause = deliveryExit.cause;
            failure = "delivery-timeout";
            quarantined = true;
          } else {
            const result = deliveryExit.value;

            if (Predicate.isTagged(result, "Failure")) {
              failure = Match.value(result.failure.kind).pipe(
                Match.when("permanent-rejection", () => "provider-rejected" as const),
                Match.when("ambiguous-outcome", () => "delivery-timeout" as const),
                Match.orElse(() => "provider-unavailable" as const),
              );
              quarantined = result.failure.kind !== "temporary-unavailability" || row.attempts >= 3;
            } else {
              providerReference = result.success.providerReference;
            }
          }
        }
      }

      const outcome = yield* pgTransaction(pool, (client) =>
        Effect.gen(function* () {
          const updated = yield* pgQuery(
            client,
            `UPDATE auth.password_reset_email_outbox SET status=$3,claim_id=NULL,claimed_at=NULL,delivered_at=CASE WHEN $3='Delivered' THEN date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC') ELSE NULL END,last_failure_code=$4,provider_reference=$5 WHERE effect_id=$1 AND claim_id=$2 AND status='Processing'`,
            [
              row.effect_id,
              claim,
              failure === null ? "Delivered" : quarantined ? "Quarantined" : "Failed",
              failure,
              providerReference,
            ],
          );

          if (updated.rowCount !== 1) return "LostClaim" as const;
          yield* audit(
            client,
            failure === null ? "password-reset-mail-delivered" : "password-reset-mail-failed",
            failure ?? "provider-acknowledged",
            row.subject_person_id,
            null,
          );

          return failure === null ? "Delivered" : quarantined ? "Quarantined" : "Failed";
        }),
      ).pipe(Effect.orDie);

      if (interruptedCause) return yield* Effect.failCause(interruptedCause);

      return outcome;
    }),
  );

export class PasswordRecovery extends Context.Service<PasswordRecovery, PasswordRecoveryService>()(
  "@vektorprogrammet/database/PasswordRecovery",
) {}

export const PasswordRecoveryLive = (config: AuthEngineConfig) =>
  Layer.effect(
    PasswordRecovery,
    Effect.map(DatabasePgPool, (pool) => makePasswordRecovery(pool, config)),
  );
