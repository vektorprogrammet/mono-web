import { redirect } from "react-router"
import {
  createCandidateCookie,
  ownerEnabled,
  readCandidateCapability,
  responseHeaders,
} from "../lib/interview-bridge.server"
import type { Route } from "./+types/interview-response.$capability"

export async function loader({ params }: Route.LoaderArgs) {
  if (!ownerEnabled()) throw new Response(null, { status: 404, headers: responseHeaders })
  const capability = params.capability
  if (capability === undefined || capability === "redacted") {
    throw redirect("/interview-response/redacted", { headers: responseHeaders })
  }

  try {
    await readCandidateCapability(capability)
  } catch {
    throw redirect("/interview-response/redacted", { headers: responseHeaders })
  }

  throw redirect("/interview-response/redacted", {
    headers: {
      ...responseHeaders,
      "Set-Cookie": createCandidateCookie(capability),
    },
  })
}

export default function InterviewResponseExchangeRoute() {
  return null
}
