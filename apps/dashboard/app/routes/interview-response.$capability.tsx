import { redirect } from "react-router";
import {
  clearInvitationCapabilityCookie,
  createInvitationCapabilityCookie,
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
    throw redirect(redactedLocation, {
      headers: {
        ...responseHeaders,
        "Set-Cookie": clearInvitationCapabilityCookie(),
      },
    });
  }

  throw redirect(redactedLocation, {
    headers: {
      ...responseHeaders,
      "Set-Cookie": createInvitationCapabilityCookie(capability),
    },
  });
}

export default function InterviewResponseExchangeRoute() {
  return null;
}
