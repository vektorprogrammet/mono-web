import { Database } from "@vektorprogrammet/database";
import { Effect, Schema } from "effect";
import { ContactEmail } from "@vektorprogrammet/domain/contact";
import { deliverJson, type HttpDeliveryConfig, type DeliveryFetch } from "../delivery/http.js";
import { pollForever } from "../worker-support.js";

export interface OnboardingDeliveryConfig {
  readonly sender: string;
  readonly claimUrl: URL;
  readonly transport: HttpDeliveryConfig;
}

export const onboardingDeliveryConfig = (
  env: Readonly<Record<string, string | undefined>>,
): OnboardingDeliveryConfig | undefined => {
  const keys = [
    "ONBOARDING_DELIVERY_URL",
    "ONBOARDING_DELIVERY_TOKEN",
    "ONBOARDING_DELIVERY_TIMEOUT_MS",
    "ONBOARDING_DELIVERY_SENDER",
  ];

  if (keys.every((k) => env[k] === undefined)) return undefined;

  try {
    const endpoint = new URL(env.ONBOARDING_DELIVERY_URL!);
    const origin = new URL(env.OAUTH_DASHBOARD_ORIGIN!);

    if (origin.pathname !== "/" || origin.search || origin.hash) throw new Error();
    const claimUrl = new URL("/konto-aktivering", origin);
    const token = env.ONBOARDING_DELIVERY_TOKEN!;
    const timeout = Number(env.ONBOARDING_DELIVERY_TIMEOUT_MS);
    const sender = Schema.decodeUnknownSync(ContactEmail)(env.ONBOARDING_DELIVERY_SENDER);

    for (const url of [endpoint, claimUrl])
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw new Error();

    if (!token?.trim() || !Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
      throw new Error();

    return {
      sender,
      claimUrl,
      transport: { endpoint, token, deliveryTimeoutMilliseconds: timeout },
    };
  } catch {
    throw new Error("Invalid onboarding delivery configuration");
  }
};

/** One durable queue, explicit operator retry; receiver must deduplicate deliveryId. */
export const drainOnboardingDelivery = (
  applicationId: string,
  config: OnboardingDeliveryConfig | undefined,
  fetchEffect: DeliveryFetch = fetch,
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* expireOnboardingSecrets;

      if (!config) return "Pending" as const;
      const claimId = crypto.randomUUID();

      const selected = yield* sql<{
        invitationId: string;
        secret: string;
        recipient: string;
        envelope: unknown;
      }>`UPDATE public.applicant_account_delivery d SET state='Claimed',claim_id=${claimId},claimed_at=date_trunc('milliseconds',clock_timestamp(),'UTC'),attempts=attempts+1 FROM public.applicant_account_invitations i WHERE d.invitation_id=i.invitation_id AND i.application_id=${applicationId} AND i.state='Open' AND i.expires_at>clock_timestamp() AND (d.state='Pending' OR(d.state='Claimed' AND d.claimed_at<clock_timestamp()-interval '60 seconds')) RETURNING d.invitation_id AS "invitationId",d.secret,d.recipient,d.envelope`;

      const row = selected[0];

      if (!row) return "BusyOrComplete" as const;
      const url = new URL(config.claimUrl);
      url.hash = row.secret;

      const envelope = yield* Schema.decodeUnknownEffect(Schema.Json)(
        row.envelope ?? {
          deliveryId: row.invitationId,
          from: config.sender,
          to: row.recipient,
          subject: "Opprett eller knytt din Vektorkonto",
          text: "Åpne lenken innen 24 timer: " + url.toString(),
        },
      );

      const saved = yield* sql<{
        envelope: unknown;
      }>`UPDATE public.applicant_account_delivery SET envelope=${sql.json(envelope)} WHERE invitation_id=${row.invitationId} AND claim_id=${claimId} AND state='Claimed' RETURNING envelope`;

      if (!saved.length) return "BusyOrComplete" as const;

      const delivered = yield* deliverJson(
        yield* Schema.decodeUnknownEffect(Schema.Json)(saved[0]!.envelope),
        config.transport,
        fetchEffect,
        {
          "idempotency-key": row.invitationId,
        },
      ).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));

      if (delivered) {
        const acknowledged =
          yield* sql`UPDATE public.applicant_account_delivery SET state='Delivered',secret=NULL,envelope=NULL,claim_id=NULL,claimed_at=NULL WHERE invitation_id=${row.invitationId} AND claim_id=${claimId} AND state='Claimed' RETURNING invitation_id`;

        if (!acknowledged.length) return "BusyOrComplete" as const;
      } else {
        const retried =
          yield* sql`UPDATE public.applicant_account_delivery SET state='Pending',claim_id=NULL,claimed_at=NULL WHERE invitation_id=${row.invitationId} AND claim_id=${claimId} AND state='Claimed' RETURNING invitation_id`;

        if (!retried.length) return "BusyOrComplete" as const;
      }

      return delivered ? ("Delivered" as const) : ("Pending" as const);
    }),
  );

export const expireOnboardingSecrets = Database.use(
  (sql) =>
    sql`UPDATE public.applicant_account_delivery d SET state='Cancelled',secret=NULL,envelope=NULL,claim_id=NULL,claimed_at=NULL FROM public.applicant_account_invitations i WHERE d.invitation_id=i.invitation_id AND d.state IN ('Pending','Claimed') AND (i.expires_at<=clock_timestamp() OR i.state<>'Open')`,
);

/** Lifecycle belongs to backend composition; interruption releases the sleeper. */
export const runOnboardingExpirySweeper = pollForever(expireOnboardingSecrets, {
  interval: "60 seconds",
});
