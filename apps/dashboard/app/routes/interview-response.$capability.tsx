import { redirect } from "react-router";
import {
  createInvitationCapabilityCookie,
  createInvitationInteractionId,
  readInvitationCapability,
  responseHeaders,
} from "../lib/interview-bridge.server";
import type { Route } from "./+types/interview-response.$capability";

export async function loader({ params, request }: Route.LoaderArgs) {
  const exchangeUrl = new URL(request.url);
  exchangeUrl.pathname = exchangeUrl.pathname.replace(/\/+$/u, "");
  const redactedLocation = new URL("./redacted", exchangeUrl).pathname;
  const bridgePath = new URL("../interview", exchangeUrl).pathname;
  const capability = params.capability;

  if (capability === undefined || capability === "redacted") {
    throw redirect(redactedLocation, { headers: responseHeaders });
  }

  try {
    await readInvitationCapability(capability);
  } catch {
    throw redirect(redactedLocation, { headers: responseHeaders });
  }

  const interactionId = createInvitationInteractionId();

  const redactedInteractionLocation = `${redactedLocation}?${new URLSearchParams({
    interactionId,
  })}`;

  throw redirect(redactedInteractionLocation, {
    headers: {
      ...responseHeaders,
      "Set-Cookie": createInvitationCapabilityCookie(interactionId, capability, bridgePath),
    },
  });
}

export default function InterviewResponseExchangeRoute() {
  return null;
}
