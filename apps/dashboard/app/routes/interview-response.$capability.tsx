import { redirect } from "react-router";
import {
  createInvitationCapabilityCookie,
  createInvitationInteractionId,
  readInvitationCapability,
  responseHeaders,
} from "../lib/interview-bridge.server";
import type { Route } from "./+types/interview-response.$capability";

const redactedLocation = "/interview-response/redacted";

export async function loader({ params }: Route.LoaderArgs) {
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
      "Set-Cookie": createInvitationCapabilityCookie(interactionId, capability),
    },
  });
}

export default function InterviewResponseExchangeRoute() {
  return null;
}
