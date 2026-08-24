import { UpdateOwnProfileCommand, UserProfile } from "@vektorprogrammet/sdk/effect";
import { Schema as S } from "effect";
import { data } from "react-router";
import {
  toProfileBridgeFailure,
  type ProfileBridgeFailure,
} from "../foldkit/profile/bridge";
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
  let token: string;
  try {
    token = requireAuth(request);
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

  let command: S.Schema.Type<typeof UpdateOwnProfileCommand>;
  try {
    command = S.decodeUnknownSync(UpdateOwnProfileCommand)(await request.json(), {
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

  const client = createAuthenticatedClient(token);
  try {
    await client.me.updateProfile(command);
    const fresh = await client.me.profile();
    return data(S.decodeUnknownSync(UserProfile)(fresh, { onExcessProperty: "error" }), {
      headers: responseHeaders,
    });
  } catch (error) {
    const failure = toProfileBridgeFailure(error);
    return data(failure, { status: statusFor(failure._tag), headers: responseHeaders });
  }
}
