import { Schema as S } from "effect";
import { createElement } from "react";
import { data, useLoaderData } from "react-router";
import {
  PROFILE_ELEMENT,
  PROFILE_INPUT_ATTRIBUTE,
  PROFILE_SEED_ATTRIBUTE,
} from "../foldkit/profile/elements";
import { ProfileInputJson } from "../foldkit/profile/model";
import { callNative } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.profile.rediger._index";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);

  try {
    const resource = await callNative(cookie, request, (client) =>
      client["profile.readOwnProfile"](),
    );

    return data(
      { serializedInput: S.encodeSync(ProfileInputJson)(resource) },
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
