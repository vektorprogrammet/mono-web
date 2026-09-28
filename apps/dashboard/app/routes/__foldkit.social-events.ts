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
import { callNative } from "../lib/api.server";
import { IdempotencyKey } from "@vektorprogrammet/rpc/problem";
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
    const scope = await callNative(cookie, request, (client) =>
      client["social-events.readScope"](),
    );

    return data(S.encodeSync(SocialEventScopeResource)(scope), { headers: responseHeaders });
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
    switch (operation.operation) {
      case "list": {
        const scope = operation.query;

        const list = await callNative(cookie, request, (client) =>
          client["social-events.list"](scope),
        );

        return data(S.encodeSync(SocialEventListResource)(list), { headers: responseHeaders });
      }

      case "create": {
        const { operation: _, commandId, ...event } = operation;

        const created = await callNative(cookie, request, (client) =>
          client["social-events.create"]({
            idempotencyKey: IdempotencyKey.make(commandId),
            request: event,
          }),
        );

        return data(S.encodeSync(SocialEventResource)(created), { headers: responseHeaders });
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
