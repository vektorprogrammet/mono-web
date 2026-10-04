import {
  ContactMessage,
  ContactVisitorIp,
  CONTACT_BACKEND_HEADER,
  CONTACT_IP_HEADER,
} from "@vektorprogrammet/domain/contact";
import { Schema } from "effect";
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi";
import { SessionUnauthorizedResponse } from "./common.js";
import { problemUnion, type NativeProblemCode } from "./http-semantics.js";

export { ContactMessage, ContactVisitorIp };

export class ContactSsrSecurity extends HttpApiMiddleware.Service<ContactSsrSecurity>()(
  "@vektorprogrammet/http-api/ContactSsrSecurity",
  {
    security: {
      contactBackend: HttpApiSecurity.apiKey({ key: CONTACT_BACKEND_HEADER, in: "header" }).pipe(
        HttpApiSecurity.annotateMerge(
          OpenApi.annotations({
            description:
              "Server-only homepage-to-backend contact credential. Visitor needs no account; direct anonymous API requests are rejected.",
          }),
        ),
      ),
    },
    error: SessionUnauthorizedResponse,
  },
) {}

/** The required canonical visitor address that the trusted homepage ingress derives. */
export const ContactIpHeaders = Schema.Struct({ [CONTACT_IP_HEADER]: ContactVisitorIp });

/**
 * The success body of a submission: none. The generated declaration gives it status 201, so the
 * rendered response has no content and no media type.
 */
export const ContactSubmitted = Schema.Void;

/** The no-store, origin-varying headers of the bodyless 201. */
export const ContactSubmittedResponseHeaders = Schema.Struct({
  "cache-control": Schema.Literal("no-store"),
  vary: Schema.Literal("Origin"),
});

/** The eight ordered problems of `contact.submitContactMessage`. */
export const ContactCodes = [
  "request.malformed",
  "header.malformed",
  "request.too-large",
  "validation.failed",
  "rate-limit.exceeded",
  "contact.unavailable",
  "media-type.unsupported",
  "internal.error",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const ContactProblem = problemUnion("ContactProblem", ContactCodes);
