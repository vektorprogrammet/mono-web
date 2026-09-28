/**
 * Loopback delivery target for the receipt outbox of a disposable backend.
 *
 * The outbox delivers the effects of one receipt in order. If a notification has no
 * delivery target, it keeps failing, and every later effect of that receipt waits
 * behind it. A runner whose journey submits receipts builds `ReceiptDeliverySinkLive` on a
 * loopback `HttpServer` and spreads `environment` into the backend settings; closing the
 * layer's scope stops the sink. `startReceiptDeliverySink` is the runtime bridge of the Promise
 * runners: it builds the sink on a loopback Bun server in its own runtime.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { ReceiptDeliveryEnvelope } from "@vektorprogrammet/backend/receipt/delivery";
import { Context, Data, Effect, Exit, Layer, Predicate, Schema, Scope, Stream } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export interface ReceiptDeliverySinkOptions {
  /** Sender address of the economy notifications. */
  readonly sender: string;
  /** Economy mailbox of each department whose receipts the journey submits. */
  readonly economyRecipients: Readonly<Record<string, string>>;
}

export class ReceiptDeliverySink extends Context.Service<
  ReceiptDeliverySink,
  {
    /** Backend settings that point the receipt outbox at this sink. */
    readonly environment: Readonly<Record<string, string>>;
    /** Acknowledged envelopes in delivery id order. */
    readonly evidence: () => ReadonlyArray<typeof ReceiptDeliveryEnvelope.Type>;
  }
>()("@monoweb/e2e/receipt-delivery-sink/ReceiptDeliverySink") {}

class ReceiptDeliveryRejected extends Data.TaggedError("ReceiptDeliveryRejected")<{
  readonly message: string;
}> {}

class ReceiptDeliverySinkUnbound extends Data.TaggedError("ReceiptDeliverySinkUnbound")<{
  readonly message: string;
}> {}

const maxEnvelopeBytes = 65_536;

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiptDeliveryEnvelope));

const envelopeText = Schema.encodeEffect(Schema.fromJsonString(ReceiptDeliveryEnvelope));

const recipientsText = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const tooLarge = new ReceiptDeliveryRejected({ message: "Receipt delivery envelope is too large" });

// Stops reading at the first chunk past the limit, as the envelope can never be accepted.
const readBoundedBody = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: new Array<Uint8Array>(), byteLength: 0 }),
      (body, chunk) => {
        const byteLength = body.byteLength + chunk.byteLength;

        return byteLength > maxEnvelopeBytes
          ? Effect.fail(tooLarge)
          : Effect.succeed({ chunks: [...body.chunks, chunk], byteLength });
      },
    ),
    Effect.map((body) => Buffer.concat(body.chunks).toString("utf8")),
  );

/**
 * Accepts bearer-authenticated JSON envelopes at `/receipts`. A replay of a delivery id
 * must repeat its envelope exactly, else the sink answers 409.
 */
export const ReceiptDeliverySinkLive = (
  options: ReceiptDeliverySinkOptions,
): Layer.Layer<ReceiptDeliverySink, ReceiptDeliverySinkUnbound, HttpServer.HttpServer> =>
  Layer.effect(
    ReceiptDeliverySink,
    Effect.gen(function* () {
      const token = randomBytes(32).toString("hex");
      const deliveries = new Map<string, typeof ReceiptDeliveryEnvelope.Type>();

      const accept = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (
          request.method !== "POST" ||
          request.url !== "/receipts" ||
          request.headers["authorization"] !== `Bearer ${token}` ||
          request.headers["content-type"] !== "application/json"
        ) {
          return HttpServerResponse.empty({ status: 401 });
        }

        const text = yield* readBoundedBody(request.stream);
        const envelope = yield* decodeEnvelope(text, { onExcessProperty: "error" });

        if (request.headers["idempotency-key"] !== envelope.deliveryId) {
          return yield* new ReceiptDeliveryRejected({
            message: "Receipt delivery idempotency key does not name the envelope",
          });
        }

        const previous = deliveries.get(envelope.deliveryId);

        if (
          previous !== undefined &&
          (yield* envelopeText(previous)) !== (yield* envelopeText(envelope))
        ) {
          return HttpServerResponse.empty({ status: 409 });
        }

        deliveries.set(envelope.deliveryId, envelope);

        return HttpServerResponse.empty({ status: 204 });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 })));

      yield* HttpServer.serveEffect(accept);

      const { address } = yield* HttpServer.HttpServer;

      if (Predicate.isTagged(address, "UnixPathAddress")) {
        return yield* new ReceiptDeliverySinkUnbound({
          message: "Receipt delivery sink did not bind a TCP port",
        });
      }

      const economyRecipients = yield* recipientsText(options.economyRecipients).pipe(Effect.orDie);

      return ReceiptDeliverySink.of({
        environment: {
          RECEIPT_DELIVERY_URL: `http://127.0.0.1:${address.port}/receipts`,
          RECEIPT_DELIVERY_TOKEN: token,
          RECEIPT_DELIVERY_TIMEOUT_MS: "2000",
          RECEIPT_DELIVERY_SENDER: options.sender,
          RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: economyRecipients,
        },
        evidence: () =>
          [...deliveries.values()].sort((left, right) =>
            left.deliveryId.localeCompare(right.deliveryId),
          ),
      });
    }),
  );

/** Starts the sink on an ephemeral loopback port; `close` stops it and releases the port. */
export const startReceiptDeliverySink = (options: ReceiptDeliverySinkOptions) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();

      const context = yield* Layer.buildWithScope(
        ReceiptDeliverySinkLive(options).pipe(
          Layer.provide(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })),
        ),
        scope,
      ).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));

      return { sink: Context.get(context, ReceiptDeliverySink), scope };
    }),
  ).then(({ sink, scope }) => ({
    ...sink,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }));
