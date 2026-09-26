import { nativeFailureFrom } from "../lib/native-problem";
import { Schema as S, flow } from "effect";

import { data } from "react-router";
import {
  SocialEventListResource,
  SocialEventResource,
  SocialEventScopeResource,
  SocialEventsBridgeOperation,
  socialEventsBridgeFailure,
  type SocialEventsBridgeErrorTag,
} from "../foldkit/social-events/bridge";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/__foldkit.social-events";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const statusFor = (tag: SocialEventsBridgeErrorTag): number => {
  switch (tag) {
    case "UnauthenticatedActor":
      return 401;
    case "NotInScope":
      return 403;
    case "InvalidScope":
    case "ValidationFailed":
    case "SocialEventsDecodeError":
      return 422;
    case "CommandConflict":
      return 409;
    case "Network":
      return 502;
    case "SocialEventsPersistenceError":
    case "Configuration":
      return 503;
  }
};

const tagFrom = flow(nativeFailureFrom, (error): SocialEventsBridgeErrorTag => {
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return "UnauthenticatedActor";
  }

  const code = error instanceof Error || error instanceof Response ? "" : error?.code ?? "";

  if (code === "credential.missing" || code === "credential.invalid") {
    return "UnauthenticatedActor";
  }

  if (code === "authority.denied" || code === "origin.denied") return "NotInScope";

  if (code === "scope.invalid") return "InvalidScope";

  if (code.startsWith("idempotency.")) return "CommandConflict";

  if (
    code === "validation.failed" ||
    code === "request.malformed" ||
    code === "header.malformed" ||
    code === "request.too-large" ||
    code === "media-type.unsupported"
  ) {
    return "ValidationFailed";
  }

  if (code === "dependency.unavailable" || code === "organization.unavailable") return "Network";

  if (code === "") return "SocialEventsPersistenceError";

  return "SocialEventsPersistenceError";
});

export async function loader({ request }: Route.LoaderArgs) {
  let cookie: string;

  try {
    cookie = await requireAuth(request);
  } catch (error) {
    const tag = tagFrom(error);

    return data(socialEventsBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }

  try {
    const result = await createAuthenticatedClient(cookie, request)["social-events"].readScope({});

    if (result.body === undefined) throw new Error("Social-events scope response did not include a body");

    return data(
      S.decodeSync(SocialEventScopeResource)(result.body, { onExcessProperty: "error" }),
      { headers: responseHeaders },
    );
  } catch (error) {
    const tag = tagFrom(error);

    return data(socialEventsBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }
}

export async function action({ request }: Route.ActionArgs) {
  let cookie: string;

  try {
    cookie = await requireAuth(request);
  } catch (error) {
    const tag = tagFrom(error);

    return data(socialEventsBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }

  let operation: S.Schema.Type<typeof SocialEventsBridgeOperation>;

  try {
    operation = S.decodeUnknownSync(SocialEventsBridgeOperation)(
      await request.json().catch(() => null),
      { onExcessProperty: "error" },
    );
  } catch {
    return data(socialEventsBridgeFailure("SocialEventsDecodeError"), {
      status: statusFor("SocialEventsDecodeError"),
      headers: responseHeaders,
    });
  }

  try {
    const socialEvents = createAuthenticatedClient(cookie, request)["social-events"];

    switch (operation.operation) {
      case "list": {
        const result = await socialEvents.list({ query: operation.query });

        if (result.body === undefined) throw new Error("Social-events list response did not include a body");

        return data(
          S.decodeSync(SocialEventListResource)(result.body, { onExcessProperty: "error" }),
          { headers: responseHeaders },
        );
      }

      case "create": {
        const { operation: _, commandId, ...payload } = operation;

        const result = await socialEvents.create({
          headers: { "idempotency-key": commandId },
          payload,
        });

        if (result.body === undefined) throw new Error("Social-events create response did not include a body");

        return data(
          S.decodeSync(SocialEventResource)(result.body, { onExcessProperty: "error" }),
          { headers: responseHeaders },
        );
      }
    }
  } catch (error) {
    const tag = tagFrom(error);

    return data(socialEventsBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }
}

export const headers = () => responseHeaders;
