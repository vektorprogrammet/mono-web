import { createElement } from "react";
import { useLoaderData } from "react-router";
import { CANDIDATE_ELEMENT } from "../foldkit/interview/elements";
import {
  decodeInvitationInteractionId,
  INVITATION_INTERACTION_ATTRIBUTE,
} from "../foldkit/interview/bridge";
import { responseHeaders } from "../lib/interview-bridge.server";
import type { Route } from "./+types/interview-response.redacted";

export function loader({ request }: Route.LoaderArgs) {
  const parameters = [...new URL(request.url).searchParams.entries()];
  const parameter = parameters[0];
  if (parameters.length !== 1 || parameter?.[0] !== "interactionId") {
    throw new Response(null, { status: 404, headers: responseHeaders });
  }
  try {
    return { interactionId: decodeInvitationInteractionId(parameter[1]) };
  } catch {
    throw new Response(null, { status: 404, headers: responseHeaders });
  }
}

export const headers = () => responseHeaders;

export default function InterviewResponseRoute() {
  const { interactionId } = useLoaderData<typeof loader>();
  return createElement(CANDIDATE_ELEMENT, {
    [INVITATION_INTERACTION_ATTRIBUTE]: interactionId,
  });
}
