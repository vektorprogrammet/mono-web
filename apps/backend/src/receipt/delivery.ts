import { ContactEmail } from "@vektorprogrammet/domain/contact";
import { Database } from "@vektorprogrammet/domain/database";
import {
  ReceiptAuxiliaryEffects,
  ReceiptDeliveryUnavailable,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Layer, Schema } from "effect";
import { deliverJson, type HttpDeliveryConfig, type DeliveryFetch } from "../delivery/http.js";

const Envelope = Schema.Struct({
  deliveryId: Schema.String,
  from: ContactEmail,
  to: ContactEmail,
  subject: Schema.String,
  text: Schema.String,
});
export interface ReceiptDeliveryConfig {
  readonly sender: string;
  readonly economyRecipients: Readonly<Record<string, string>>;
  readonly transport: HttpDeliveryConfig;
}
/** Absent configuration leaves notifications failed/retryable; partial configuration is an error. */
export const receiptDeliveryConfig = (
  env: Readonly<Record<string, string | undefined>>,
): ReceiptDeliveryConfig | undefined => {
  const keys = [
    "RECEIPT_DELIVERY_URL",
    "RECEIPT_DELIVERY_TOKEN",
    "RECEIPT_DELIVERY_TIMEOUT_MS",
    "RECEIPT_DELIVERY_SENDER",
    "RECEIPT_DELIVERY_ECONOMY_RECIPIENTS",
  ] as const;
  if (keys.every((key) => env[key] === undefined)) return undefined;
  try {
    const endpoint = new URL(env.RECEIPT_DELIVERY_URL!);
    const token = env.RECEIPT_DELIVERY_TOKEN!;
    const sender = Schema.decodeUnknownSync(ContactEmail)(env.RECEIPT_DELIVERY_SENDER);
    const timeout = Number(env.RECEIPT_DELIVERY_TIMEOUT_MS);
    const recipients = Schema.decodeUnknownSync(Schema.Record(Schema.String, ContactEmail))(
      JSON.parse(env.RECEIPT_DELIVERY_ECONOMY_RECIPIENTS!),
    );
    // Cleartext delivery is confined to local rehearsals; credentials never follow redirects.
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.search ||
      !(
        endpoint.protocol === "https:" ||
        (endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname))
      ) ||
      !token ||
      /[\r\n]/.test(token) ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 30_000 ||
      Object.keys(recipients).length === 0 ||
      Object.keys(recipients).some((key) => !key.trim())
    )
      throw new Error();
    return {
      sender,
      economyRecipients: recipients,
      transport: { endpoint, token, deliveryTimeoutMilliseconds: timeout },
    };
  } catch {
    throw new TypeError("Invalid receipt delivery configuration");
  }
};

/** First-attempt contact snapshot, durable before network IO. Receiver must deduplicate deliveryId. */
export const makeReceiptDeliveryLayer = (
  config: ReceiptDeliveryConfig | undefined,
  fetchEffect: DeliveryFetch = globalThis.fetch,
) =>
  Layer.effect(
    ReceiptAuxiliaryEffects,
    Effect.gen(function* () {
      const sql = yield* Database;
      return ReceiptAuxiliaryEffects.of({
        apply: (request, claimId) =>
          Effect.gen(function* () {
            if (!claimId)
              return yield* Effect.fail(
                new ReceiptDeliveryUnavailable({ effectId: request.effectId }),
              );
            if (request._tag === "WriteReceiptAudit") {
              const audit =
                yield* sql`SELECT 1 FROM economy_receipt_audit WHERE command_id = ${request.commandId} AND receipt_id = ${request.receiptId}`;
              if (audit.length !== 1)
                return yield* Effect.fail(
                  new ReceiptDeliveryUnavailable({ effectId: request.effectId }),
                );
              return;
            }
            if (config === undefined)
              return yield* Effect.fail(
                new ReceiptDeliveryUnavailable({ effectId: request.effectId }),
              );
            const envelope = yield* sql.withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<{ delivery_envelope: unknown; effect_type: string }>`
            SELECT delivery_envelope, effect_type FROM economy_receipt_outbox
            WHERE effect_id = ${request.effectId} AND command_id = ${request.commandId}
              AND receipt_id = ${request.receiptId} AND status = 'Processing' AND claim_id = ${claimId}
            FOR UPDATE`;
                const row = rows[0];
                if (!row || row.effect_type !== request._tag)
                  return yield* Effect.fail(new Error("Receipt delivery claim unavailable"));
                if (row.delivery_envelope !== null)
                  return yield* Schema.decodeUnknownEffect(Envelope)(row.delivery_envelope, {
                    onExcessProperty: "error",
                  });
                const facts = yield* sql<{
                  department_id: string;
                  email: string;
                  visual_id: string;
                  status: string;
                  amount: string;
                  description: string;
                  receipt_date: string;
                }>`
            SELECT receipt.department_id, contact.email,
              command.observation_json ->> 'visualId' AS visual_id,
              command.observation_json ->> 'status' AS status,
              COALESCE((SELECT h.command_json ->> 'amountOre' FROM economy_receipt_command_receipts h JOIN economy_receipt_audit a ON a.command_id=h.command_id WHERE h.receipt_id=receipt.receipt_id AND a.receipt_revision<=audit.receipt_revision AND h.command_json ->> 'amountOre' IS NOT NULL ORDER BY a.receipt_revision DESC LIMIT 1), receipt.amount_ore::text) AS amount,
              COALESCE((SELECT h.command_json ->> 'description' FROM economy_receipt_command_receipts h JOIN economy_receipt_audit a ON a.command_id=h.command_id WHERE h.receipt_id=receipt.receipt_id AND a.receipt_revision<=audit.receipt_revision AND h.command_json ->> 'description' IS NOT NULL ORDER BY a.receipt_revision DESC LIMIT 1), receipt.description) AS description,
              COALESCE((SELECT h.command_json ->> 'receiptDate' FROM economy_receipt_command_receipts h JOIN economy_receipt_audit a ON a.command_id=h.command_id WHERE h.receipt_id=receipt.receipt_id AND a.receipt_revision<=audit.receipt_revision AND h.command_json ->> 'receiptDate' IS NOT NULL ORDER BY a.receipt_revision DESC LIMIT 1), receipt.receipt_date::text) AS receipt_date
            FROM economy_receipts receipt
            JOIN person_contact_profiles contact ON contact.person_id = receipt.owner_person_id
            JOIN economy_receipt_command_receipts command ON command.receipt_id = receipt.receipt_id
            JOIN economy_receipt_audit audit ON audit.command_id = command.command_id
            WHERE receipt.receipt_id = ${request.receiptId} AND command.command_id = ${request.commandId}`;
                const fact = facts[0];
                const status =
                  request._tag === "NotifyEconomyReceiptSubmitted"
                    ? "Pending"
                    : request._tag === "NotifyReceiptRefunded"
                      ? "Refunded"
                      : "Rejected";
                if (!fact || fact.status !== status)
                  return yield* Effect.fail(new Error("Receipt notification facts unavailable"));
                const submitted = request._tag === "NotifyEconomyReceiptSubmitted";
                const subject = submitted
                  ? "Nytt utlegg registrert"
                  : request._tag === "NotifyReceiptRefunded"
                    ? "Utlegget ditt er markert som refundert"
                    : "Utlegget ditt er avvist";
                const prepared = yield* Schema.decodeUnknownEffect(Envelope)({
                  deliveryId: request.effectId,
                  from: config.sender,
                  to: submitted ? config.economyRecipients[fact.department_id] : fact.email,
                  subject,
                  text: `${subject}. Referanse: ${fact.visual_id}.\nBeløp: ${(Number(fact.amount) / 100).toFixed(2)} NOK\nDato: ${fact.receipt_date}\nBeskrivelse: ${fact.description}${request._tag === "NotifyReceiptRejected" ? `\nKontakt økonomiansvarlig på ${config.sender} dersom du har spørsmål om avvisningen.` : ""}`,
                });
                yield* sql`UPDATE economy_receipt_outbox SET delivery_envelope = ${sql.json(prepared)} WHERE effect_id = ${request.effectId} AND claim_id = ${claimId}`;
                return prepared;
              }),
            );
            yield* deliverJson(envelope, config.transport, fetchEffect, {
              "idempotency-key": request.effectId,
            });
          }).pipe(
            Effect.mapError(() => new ReceiptDeliveryUnavailable({ effectId: request.effectId })),
          ),
      });
    }),
  );
