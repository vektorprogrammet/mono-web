/**
 * Loopback delivery target for the receipt outbox of a disposable backend.
 *
 * The outbox delivers the effects of one receipt in order. If a notification has no
 * delivery target, it keeps failing, and every later effect of that receipt waits
 * behind it. A runner whose journey submits receipts starts this sink and spreads
 * `environment` into the backend settings.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { ReceiptDeliveryEnvelope } from "@vektorprogrammet/backend/receipt/delivery";
import { Predicate, Schema } from "effect";

export interface ReceiptDeliverySinkOptions {
  /** Sender address of the economy notifications. */
  readonly sender: string;
  /** Economy mailbox of each department whose receipts the journey submits. */
  readonly economyRecipients: Readonly<Record<string, string>>;
}

const maxEnvelopeBytes = 65_536;

const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(ReceiptDeliveryEnvelope));

/**
 * Accepts bearer-authenticated JSON envelopes at `/receipts`. A replay of a delivery id
 * must repeat its envelope exactly, else the sink answers 409.
 */
export const startReceiptDeliverySink = async (options: ReceiptDeliverySinkOptions) => {
  const token = randomBytes(32).toString("hex");
  const deliveries = new Map<string, typeof ReceiptDeliveryEnvelope.Type>();

  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/receipts" ||
        request.headers.authorization !== `Bearer ${token}` ||
        request.headers["content-type"] !== "application/json"
      ) {
        response.writeHead(401).end();

        return;
      }

      const chunks: Array<Buffer> = [];
      let byteLength = 0;

      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        byteLength += bytes.byteLength;

        if (byteLength > maxEnvelopeBytes)
          throw new Error("Receipt delivery envelope is too large");
        chunks.push(bytes);
      }

      const envelope = decodeEnvelope(Buffer.concat(chunks).toString("utf8"), {
        onExcessProperty: "error",
      });

      if (request.headers["idempotency-key"] !== envelope.deliveryId) {
        throw new Error("Receipt delivery idempotency key does not name the envelope");
      }

      const previous = deliveries.get(envelope.deliveryId);

      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(envelope)) {
        response.writeHead(409).end();

        return;
      }

      deliveries.set(envelope.deliveryId, envelope);
      response.writeHead(204).end();
    } catch {
      response.writeHead(400).end();
    }
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;

  const address = server.address();

  const close = () => {
    const closed = Promise.withResolvers<void>();
    server.closeAllConnections();
    server.close((error) => {
      if (error === undefined || ("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) {
        closed.resolve();
      } else {
        closed.reject(error);
      }
    });

    return closed.promise;
  };

  if (address === null || Predicate.isString(address)) {
    await close();
    throw new Error("Receipt delivery sink did not bind a TCP port");
  }

  return {
    environment: {
      RECEIPT_DELIVERY_URL: `http://127.0.0.1:${address.port}/receipts`,
      RECEIPT_DELIVERY_TOKEN: token,
      RECEIPT_DELIVERY_TIMEOUT_MS: "2000",
      RECEIPT_DELIVERY_SENDER: options.sender,
      RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: JSON.stringify(options.economyRecipients),
    },
    /** Acknowledged envelopes in delivery id order. */
    evidence: (): ReadonlyArray<typeof ReceiptDeliveryEnvelope.Type> =>
      [...deliveries.values()].sort((left, right) =>
        left.deliveryId.localeCompare(right.deliveryId),
      ),
    close,
  };
};
