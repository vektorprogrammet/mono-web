import { UserProfile } from "@vektorprogrammet/sdk/effect";
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
  const client = createAuthenticatedClient(cookie);

  let observation: S.Schema.Type<typeof UserProfile>;
  try {
    observation = await client.me.profile();
  } catch {
    throw await expiredSessionRedirect(request);
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


export default function RedigerProfil() {
  const { serializedInput } = useLoaderData<typeof loader>();
  return createElement(PROFILE_ELEMENT, {
    [PROFILE_INPUT_ATTRIBUTE]: serializedInput,
    [PROFILE_SEED_ATTRIBUTE]: crypto.randomUUID(),
  });
}
