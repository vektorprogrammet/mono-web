/**
 * The ContactRpcs handlers: the public contact form that the homepage server relays.
 *
 * The ContactBackend credential admits only the homepage server's deployment secret, and the RPC
 * payload schema admits only a well-formed message. The handler reads the visitor address that the
 * homepage server sends beside the secret, consumes one attempt of that visitor's quota, and waits
 * for the delivery transport to accept the message.
 */
import { ContactQuotaLive } from "@vektorprogrammet/database/contact";
import {
  ContactDelivery,
  ContactFailure,
  CONTACT_IP_HEADER,
  ContactVisitorIp,
  submitContact,
} from "@vektorprogrammet/domain/contact";
import { ContactRpcs } from "@vektorprogrammet/rpc";
import { Problem } from "@vektorprogrammet/rpc/problem";
import { Effect, Layer, Match, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { deliverJson } from "../delivery/http.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import { problemMapper, requestInvalid } from "../rpc/problem.js";
import type { ContactConfig } from "./config.js";

/** The one answer for every contact failure. */
const contactProblems = problemMapper<ContactFailure>()({
  ContactFailure: ({ reason }) =>
    Match.value(reason).pipe(
      // A recipient that cannot receive the message makes the message itself invalid.
      Match.when("InvalidRecipient", requestInvalid),
      Match.when("RateLimited", () => Problem.rateLimited(3_600)),
      Match.when("Unavailable", () => Problem.make("contact.unavailable")),
      Match.exhaustive,
    ),
});

const deliveryFor = (config: ContactConfig) =>
  Layer.effect(
    ContactDelivery,
    Effect.map(HttpClient.HttpClient, (client) =>
      ContactDelivery.of({
        send: (envelope) =>
          deliverJson(
            {
              from: config.sender,
              to: envelope.to,
              replyTo: envelope.replyTo,
              subject: `[Kontaktskjema] ${envelope.subject}`,
              text: `Navn: ${envelope.name}\nE-post: ${envelope.replyTo}\n\n${envelope.message}`,
            },
            config.delivery,
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.mapError(() => new ContactFailure({ reason: "Unavailable" })),
          ),
      }),
    ),
  );

/** The one canonical visitor address that the homepage server sends; anything else is malformed. */
const decodeVisitorIp = Schema.decodeUnknownEffect(ContactVisitorIp);

/** The ContactRpcs handlers. */
export const ContactRpcHandlers = (options: NativeRpcOptions) => {
  const config = options.config.contact;

  return ContactRpcs.toLayer(
    Effect.gen(function* () {
      // Built once with the handlers: the quota and the delivery hold no state of a request.
      const services =
        config === undefined
          ? undefined
          : yield* Layer.build(Layer.merge(ContactQuotaLive, deliveryFor(config)));

      return ContactRpcs.of({
        "contact.submitContactMessage": (message, { headers }) =>
          Effect.gen(function* () {
            const ip = yield* decodeVisitorIp(headers[CONTACT_IP_HEADER]).pipe(
              Effect.mapError(() => Problem.make("header.malformed")),
            );

            // Without configuration the credential admits every request, and nothing can be delivered.
            if (services === undefined) return yield* Problem.make("contact.unavailable");

            yield* submitContact(message, ip).pipe(
              Effect.provideContext(services),
              contactProblems,
            );
          }),
      });
    }),
  );
};
