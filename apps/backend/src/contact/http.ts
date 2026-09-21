import { timingSafeEqual } from "node:crypto";
import {
  ContactDelivery,
  ContactFailure,
  ContactMessage,
  ContactVisitorIp,
  CONTACT_BACKEND_HEADER,
  CONTACT_IP_HEADER,
  submitContact,
} from "@vektorprogrammet/domain/contact";
import { ContactQuotaLive } from "@vektorprogrammet/database/contact";
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { BackendRun } from "../router.js";
import type { ContactConfig } from "./config.js";
import { deliverJson } from "../delivery/http.js";
import { readBoundedJson } from "../http-api/read-json.js";
import { HttpSemanticFailure, nativeProblemResponse } from "../http-semantics.js";
import { toHttpApiResponse } from "../http-api/transport.js";

const denied = () =>
  nativeProblemResponse("credential.invalid", 401, {
    "www-authenticate": 'ContactSSR realm="native-contact"',
  });
const tokenMatches = (supplied: string | null, expected: string): boolean => {
  if (supplied === null) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};
const failure = (error: unknown): Response => {
  if (error instanceof HttpSemanticFailure) return nativeProblemResponse(error.code, error.status);
  if (error instanceof ContactFailure) {
    if (error.reason === "InvalidRecipient") return nativeProblemResponse("validation.failed", 422);
    if (error.reason === "RateLimited")
      return nativeProblemResponse("rate-limit.exceeded", 429, { "retry-after": "3600" });
  }
  return nativeProblemResponse("contact.unavailable", 503);
};
export const makeContactHandler = (run: BackendRun, config: ContactConfig | undefined) => {
  const delivery = Layer.succeed(
    ContactDelivery,
    ContactDelivery.of({
      send: (envelope) =>
        config === undefined
          ? Effect.fail(new ContactFailure({ reason: "Unavailable" }))
          : deliverJson(
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
  const services = Layer.merge(ContactQuotaLive, delivery);
  return async (request: Request): Promise<Response> => {
    if (config === undefined) return nativeProblemResponse("contact.unavailable", 503);
    if (!tokenMatches(request.headers.get(CONTACT_BACKEND_HEADER), config.backendToken))
      return denied();
    let ip: ContactVisitorIp;
    try {
      ip = Schema.decodeUnknownSync(ContactVisitorIp)(request.headers.get(CONTACT_IP_HEADER));
    } catch {
      return denied();
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? ""))
      return nativeProblemResponse("media-type.unsupported", 415);
    let input: unknown;
    try {
      input = await readBoundedJson(request, 65_536);
    } catch (error) {
      return failure(error);
    }
    let message: ContactMessage;
    try {
      message = Schema.decodeUnknownSync(ContactMessage)(input, { onExcessProperty: "error" });
    } catch {
      return nativeProblemResponse("validation.failed", 422);
    }
    try {
      return await run(
        submitContact(message, ip).pipe(
          Effect.provide(services),
          Effect.match({
            onFailure: failure,
            onSuccess: () =>
              new Response(null, {
                status: 201,
                headers: { "cache-control": "no-store", vary: "Origin" },
              }),
          }),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  };
};
export const ContactApiHandlers = (run: BackendRun, config: ContactConfig | undefined) => {
  const handle = makeContactHandler(run, config);
  return HttpApiBuilder.group(ExternalNativeApi, "contact", (handlers) =>
    handlers.handleRaw("submitContactMessage", ({ request }) =>
      toHttpApiResponse(request, handle, failure),
    ),
  );
};
