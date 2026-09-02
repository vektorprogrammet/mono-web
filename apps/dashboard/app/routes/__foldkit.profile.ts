import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { data } from "react-router";
import { toProfileBridgeFailure, type ProfileBridgeFailure } from "../foldkit/profile/bridge";
import { ProfileCommand, ProfileInput } from "../foldkit/profile/model";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/__foldkit.profile";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const statusFor = (failure: ProfileBridgeFailure["_tag"]): number => {
  switch (failure) {
    case "Unauthorized":
      return 401;
    case "Forbidden":
      return 403;
    case "NotFound":
      return 404;
    case "Conflict":
      return 409;
    case "Validation":
      return 422;
    case "RateLimited":
      return 429;
    case "Configuration":
    case "Network":
      return 503;
  }
};

export async function action({ request }: Route.ActionArgs) {
  let cookie: string;
  try {
    cookie = await requireAuth(request);
  } catch {
    return data(
      {
        _tag: "Unauthorized",
        message: "Sesjonen har utløpt. Logg inn på nytt.",
      } satisfies ProfileBridgeFailure,
      { status: 401, headers: responseHeaders },
    );
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (request.method !== "PUT" || contentType !== "application/json") {
    return new Response(null, { status: 405, headers: responseHeaders });
  }

  let command: typeof ProfileCommand.Type;
  try {
    command = S.decodeUnknownSync(ProfileCommand)(await request.json(), {
      onExcessProperty: "error",
    });
  } catch {
    return data(
      {
        _tag: "Validation",
        message: "Serveren godtok ikke verdiene. Kontroller feltene og prøv igjen.",
      } satisfies ProfileBridgeFailure,
      { status: 422, headers: responseHeaders },
    );
  }

  const { commandId, etag, ...payload } = command;
  const client = createAuthenticatedClient(cookie, request);
  try {
    const result = await client.profile.updateOwnProfile({
      headers: {
        "idempotency-key": IdempotencyKey.make(commandId),
        "if-match": etag,
      },
      payload,
    });
    return data(
      S.decodeUnknownSync(ProfileInput)(
        { profile: result.body, etag: result.headers.etag },
        { onExcessProperty: "error" },
      ),
      { headers: responseHeaders },
    );
  } catch (error) {
    const failure = toProfileBridgeFailure(error);
    return data(failure, { status: statusFor(failure._tag), headers: responseHeaders });
  }
}
