import {
  ContactDelivery,
  ContactFailure,
  ContactMessage,
  type ContactVisitorIp,
  CONTACT_IP_HEADER,
  submitContact,
} from "@vektorprogrammet/domain/contact";
import { ContactQuotaLive } from "@vektorprogrammet/database/contact";
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Layer, Match } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { ContactConfig } from "./config.js";
import { deliverJson } from "../delivery/http.js";
import {
  decodeRequest,
  problemMapper,
  readJsonBody,
  requestInvalid,
  webHandler,
} from "../http-api/problem.js";

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
  Layer.succeed(
    ContactDelivery,
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
          globalThis.fetch,
        ).pipe(Effect.mapError(() => new ContactFailure({ reason: "Unavailable" }))),
    }),
  );

/**
 * The public contact form. ContactSSR security admits only the homepage
 * server's token and the endpoint schema admits only a canonical visitor
 * address, so the handler starts at the message itself.
 */
export const ContactApiHandlers = (config: ContactConfig | undefined) => {
  const services =
    config === undefined ? undefined : Layer.merge(ContactQuotaLive, deliveryFor(config));

  const submit = (request: Request, ip: ContactVisitorIp) =>
    Effect.gen(function* () {
      // Without configuration the ingress admits every request, and nothing can be delivered.
      if (services === undefined) return yield* Problem.make("contact.unavailable");

      const input = yield* readJsonBody(request, /^application\/json(?:\s*;|$)/iu, 65_536);

      const message = yield* decodeRequest(ContactMessage)(input);

      yield* submitContact(message, ip).pipe(Effect.provide(services), contactProblems);

      return new Response(null, {
        status: 201,
        headers: { "cache-control": "no-store", vary: "Origin" },
      });
    });

  return HttpApiBuilder.group(ExternalNativeApi, "contact", (handlers) =>
    handlers.handleRaw("submitContactMessage", ({ request, headers }) =>
      webHandler(request, (webRequest) => submit(webRequest, headers[CONTACT_IP_HEADER])),
    ),
  );
};
