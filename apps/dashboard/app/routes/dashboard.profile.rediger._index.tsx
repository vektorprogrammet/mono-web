import { UpdateOwnProfileCommand, UserProfile } from "@vektorprogrammet/sdk/effect";
import { Schema as S } from "effect";
import { createElement } from "react";
import { data, useLoaderData } from "react-router";
import {
  PROFILE_ELEMENT,
  PROFILE_INPUT_ATTRIBUTE,
  PROFILE_SEED_ATTRIBUTE,
} from "../foldkit/profile/elements";
import { ProfileInputJson } from "../foldkit/profile/model";
import { toProfileBridgeFailure, type ProfileBridgeFailure } from "../foldkit/profile/bridge";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.profile.rediger._index";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

type ProfileFailureTag = ProfileBridgeFailure["_tag"];

const statusFor = (failure: ProfileFailureTag): number => {
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

export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  let observation: S.Schema.Type<typeof UserProfile>;
  try {
    observation = await client.me.profile();
  } catch {
    throw expiredSessionRedirect();
  }

  // Strict re-decode at the route boundary so the serialized element input can
  // never drift from the schema the custom element decodes with.
  const strict = S.decodeUnknownSync(UserProfile)(observation, {
    onExcessProperty: "error",
  });

  return data(
    { serializedInput: S.encodeSync(ProfileInputJson)(strict) },
    { headers: responseHeaders },
  );
}

const readFreshProfile = async (
  token: string,
): Promise<S.Schema.Type<typeof UserProfile>> => {
  const fresh = await createAuthenticatedClient(token).me.profile();
  return S.decodeUnknownSync(UserProfile)(fresh, { onExcessProperty: "error" });
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

  if (request.method === "GET") {
    try {
      return data(S.encodeSync(ProfileInputJson)(await readFreshProfile(token)), {
        headers: responseHeaders,
      });
    } catch (error) {
      const failure = toProfileBridgeFailure(error);
      if (failure._tag === "Unauthorized") throw expiredSessionRedirect();
      return data(failure, { status: statusFor(failure._tag), headers: responseHeaders });
    }
  }

  if (request.method !== "PUT") {
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

  try {
    await createAuthenticatedClient(token).me.updateProfile(command);
    return data(S.encodeSync(ProfileInputJson)(await readFreshProfile(token)), {
      headers: responseHeaders,
    });
  } catch (error) {
    const failure = toProfileBridgeFailure(error);
    if (failure._tag === "Unauthorized") throw expiredSessionRedirect();
    return data(failure, { status: statusFor(failure._tag), headers: responseHeaders });
  }
}

export default function RedigerProfil() {
  const { serializedInput } = useLoaderData<typeof loader>();
  return createElement(PROFILE_ELEMENT, {
    [PROFILE_INPUT_ATTRIBUTE]: serializedInput,
    [PROFILE_SEED_ATTRIBUTE]: crypto.randomUUID(),
  });
}
