import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Pool, PoolClient } from "pg";
import type {
  IdentityRequestContext,
  IdentitySecurityEventKind,
  IdentitySecurityOutcomeCode,
} from "@vektorprogrammet/domain/identity";
import type { MailShape } from "@vektorprogrammet/domain/mail";
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
const transaction = async <A>(pool: Pool, run: (client: PoolClient) => Promise<A>): Promise<A> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
const audit = async (
  db: Pool | PoolClient,
  kind: IdentitySecurityEventKind,
  code: IdentitySecurityOutcomeCode,
  subject: string | null,
  context: IdentityRequestContext | null,
) => {
  await db.query(
    `INSERT INTO auth.identity_security_audit(event_id,event_kind,subject_person_id,request_correlation,details)
    VALUES($1,$2,$3,$4,$5::jsonb)`,
    [
      randomUUID(),
      kind,
      subject,
      context?.requestCorrelation ?? null,
      JSON.stringify({ outcomeCode: code, affectedSessionCount: null }),
    ],
  );
};

/** One AsyncLocalStorage scope per HTTP request; never keyed by caller-controlled correlation. */
export const makePasswordRecovery = (pool: Pool, config: AuthEngineConfig) => {
  const local = new AsyncLocalStorage<Coordination>();
  const callback = `${config.oauth.dashboardOrigin}/tilbakestill-passord`;
  if (!config.trustedOrigins.includes(config.oauth.dashboardOrigin))
    throw new Error("Recovery dashboard origin is not trusted");
  return {
    sendResetPassword: async ({
      user,
      token,
      url,
    }: {
      user: { id: string };
      token: string;
      url: string;
    }) => {
      const state = local.getStore();
      if (!state) throw new Error("Recovery requires an owned request");
      try {
        if (
          url !==
          `${config.oauth.canonicalOrigin}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(callback)}`
        )
          throw new Error("Recovery callback mismatch");
        await transaction(pool, async (client) => {
          const verification = await client.query<{ id: string }>(
            `SELECT id FROM auth.verification WHERE identifier=$1 AND value=$2 AND "expiresAt">CURRENT_TIMESTAMP`,
            [`reset-password:${token}`, user.id],
          );
          if (verification.rows.length !== 1) throw new Error("Recovery verification missing");
          const id = verification.rows[0]!.id;
          await client.query(
            `INSERT INTO auth.password_reset_email_outbox(effect_id,verification_id,subject_person_id,status) VALUES($1,$2,$3,'Pending')`,
            [`password-reset:${id}`, id, user.id],
          );
          await audit(
            client,
            "password-reset-request-accepted",
            "mail-enqueued",
            user.id,
            state.context,
          );
        });
        state.enqueue = "Accepted";
      } catch {
        state.enqueue = "Failed";
        throw new Error("Recovery enqueue unavailable");
      }
    },
    onPasswordReset: async ({ user }: { user: { id: string } }) => {
      const state = local.getStore();
      if (state) state.subject = user.id;
    },
    handler: (
      handler: (request: Request) => Promise<Response>,
      request: Request,
      context: IdentityRequestContext,
    ): Promise<Response> => {
      const url = new URL(request.url);
      const requesting =
        request.method === "POST" && url.pathname === "/api/auth/request-password-reset";
      const resetting = request.method === "POST" && url.pathname === "/api/auth/reset-password";
      const following =
        request.method === "GET" && url.pathname.startsWith("/api/auth/reset-password/");
      if (!requesting && !resetting && !following) return handler(request);
      return local.run({ context, enqueue: "Absent", subject: null }, async () => {
        const state = local.getStore()!;
        try {
          const reject = async (code: "origin-not-trusted" | "redirect-not-allowed") => {
            await audit(pool, "password-reset-request-rejected", code, null, context);
            return Response.json({ code: "RECOVERY_REJECTED" }, { status: 403 });
          };
          if (
            (requesting || resetting) &&
            !config.trustedOrigins.includes(request.headers.get("origin") ?? "")
          )
            return await reject("origin-not-trusted");
          if (
            following &&
            (url.searchParams.getAll("callbackURL").length !== 1 ||
              url.searchParams.get("callbackURL") !== callback)
          )
            return await reject("redirect-not-allowed");
          if (requesting) {
            let body: unknown;
            try {
              body = await request.clone().json();
            } catch {
              await audit(pool, "password-reset-request-rejected", "input-invalid", null, context);
              return Response.json({ code: "INPUT_INVALID" }, { status: 400 });
            }
            if (
              body === null ||
              typeof body !== "object" ||
              !("redirectTo" in body) ||
              body.redirectTo !== callback
            )
              return await reject("redirect-not-allowed");
          }
          if (resetting && url.search) return await reject("redirect-not-allowed");
          const response = await handler(request);
          if (requesting) {
            if (state.enqueue === "Failed") {
              await audit(
                pool,
                "password-reset-mail-enqueue-failed",
                "outbox-unavailable",
                null,
                context,
              );
              return unavailable();
            }
            if (state.enqueue === "Absent")
              await audit(
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
            const body = response.ok
              ? null
              : await response
                  .clone()
                  .json()
                  .catch(() => null);
            const code =
              body !== null && typeof body === "object" && "code" in body ? body.code : undefined;
            await audit(
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
        } catch {
          if (resetting)
            await audit(
              pool,
              "password-reset-failure",
              "engine-failure",
              state.subject,
              context,
            ).catch(() => undefined);
          return unavailable();
        }
      });
    },
  };
};

/** One bounded attempt. SKIP LOCKED and claim fencing allow independent operators safely. */
export const drainPasswordResetMail = async (
  pool: Pool,
  config: Pick<AuthEngineConfig, "oauth">,
  mail: MailShape,
  sender: string,
): Promise<"Empty" | "Delivered" | "Failed" | "Quarantined" | "LostClaim"> => {
  const claim = randomUUID();
  const row = await transaction(pool, async (client) => {
    await client.query(
      `UPDATE auth.password_reset_email_outbox SET status='Quarantined',claim_id=NULL,claimed_at=NULL,last_failure_code='stale-claim' WHERE status='Processing' AND claimed_at<CURRENT_TIMESTAMP-INTERVAL '60 seconds'`,
    );
    return (
      await client.query<{
        effect_id: string;
        verification_id: string;
        subject_person_id: string;
        attempts: number;
      }>(
        `WITH next AS (SELECT effect_id FROM auth.password_reset_email_outbox WHERE status='Pending' OR (status='Failed' AND attempts<3) ORDER BY created_at,effect_id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE auth.password_reset_email_outbox o SET status='Processing',claim_id=$1,claimed_at=CURRENT_TIMESTAMP,attempts=attempts+1 FROM next WHERE o.effect_id=next.effect_id RETURNING o.*`,
        [claim],
      )
    ).rows[0];
  });
  if (!row) return "Empty";
  const verification = (
    await pool.query<{ identifier: string; value: string; expiresAt: Date; email: string | null }>(
      `SELECT v.identifier,v.value,v."expiresAt",u.email FROM auth.verification v LEFT JOIN auth."user" u ON u.id=$2 WHERE v.id=$1`,
      [row.verification_id, row.subject_person_id],
    )
  ).rows[0];
  let failure:
    | "verification-invalid"
    | "verification-expired"
    | "authority-mismatch"
    | "provider-rejected"
    | "provider-unavailable"
    | "delivery-timeout"
    | null = null;
  let providerReference: string | null = null;
  let quarantined = false;
  if (!verification || !/^reset-password:[A-Za-z0-9_-]+$/.test(verification.identifier)) {
    failure = "verification-invalid";
  } else if (verification.value !== row.subject_person_id || !verification.email) {
    failure = "authority-mismatch";
  } else if (verification.expiresAt.getTime() <= Date.now()) {
    failure = "verification-expired";
  }
  quarantined = failure !== null;
  if (!failure && verification) {
    const token = verification.identifier.slice("reset-password:".length);
    const result = await Effect.runPromise(
      Effect.result(
        mail.deliver({
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
        }),
      ),
    );
    if (result._tag === "Failure") {
      failure =
        result.failure.kind === "permanent-rejection"
          ? "provider-rejected"
          : result.failure.kind === "ambiguous-outcome"
            ? "delivery-timeout"
            : "provider-unavailable";
      quarantined = result.failure.kind !== "temporary-unavailability" || row.attempts >= 3;
    } else {
      providerReference = result.success.providerReference;
    }
  }
  return transaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE auth.password_reset_email_outbox SET status=$3,claim_id=NULL,claimed_at=NULL,delivered_at=CASE WHEN $3='Delivered' THEN CURRENT_TIMESTAMP ELSE NULL END,last_failure_code=$4,provider_reference=$5 WHERE effect_id=$1 AND claim_id=$2 AND status='Processing'`,
      [
        row.effect_id,
        claim,
        failure === null ? "Delivered" : quarantined ? "Quarantined" : "Failed",
        failure,
        providerReference,
      ],
    );
    if (updated.rowCount !== 1) return "LostClaim";
    await audit(
      client,
      failure === null ? "password-reset-mail-delivered" : "password-reset-mail-failed",
      failure ?? "provider-acknowledged",
      row.subject_person_id,
      null,
    );
    return failure === null ? "Delivered" : quarantined ? "Quarantined" : "Failed";
  });
};
