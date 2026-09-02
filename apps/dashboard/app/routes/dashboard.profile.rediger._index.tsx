import { Schema as S } from "effect";
import { createElement } from "react";
import { data, useLoaderData } from "react-router";
import {
  PROFILE_ELEMENT,
  PROFILE_INPUT_ATTRIBUTE,
  PROFILE_SEED_ATTRIBUTE,
} from "../foldkit/profile/elements";
import { ProfileInputJson } from "../foldkit/profile/model";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.profile.rediger._index";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  try {
    const result = await client.profile.readOwnProfile({ headers: {} });
    if (result.body === undefined) throw new Error("Profile response did not include a body");
    return data(
      {
        serializedInput: S.encodeSync(ProfileInputJson)({
          profile: result.body,
          etag: result.headers.etag,
        }),
      },
      { headers: responseHeaders },
    );
  } catch {
    throw await expiredSessionRedirect(request);
  }
}

export default function RedigerProfil() {
  const { serializedInput } = useLoaderData<typeof loader>();
  return createElement(PROFILE_ELEMENT, {
    [PROFILE_INPUT_ATTRIBUTE]: serializedInput,
    [PROFILE_SEED_ATTRIBUTE]: crypto.randomUUID(),
  });
}
