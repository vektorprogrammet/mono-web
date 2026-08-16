import { data } from "react-router"
import {
  decodeOperation,
  ownerEnabled,
  responseHeaders,
  runOperation,
} from "../lib/interview-bridge.server"
import type { Route } from "./+types/__foldkit.interview"

const errorBody = (error: unknown): { _tag: string; message: string } => {
  if (typeof error === "object" && error !== null) {
    const type = "type" in error && typeof error.type === "string" ? error.type : undefined
    if (type === "unauthorized") return { _tag: "Unauthorized", message: "Unauthorized" }
    if (type === "not_found") return { _tag: "NotFound", message: "Not found" }
    if (type === "validation") return { _tag: "Validation", message: "Validation failed" }
    if (type === "conflict") return { _tag: "Conflict", message: "Conflict" }
    if (type === "rate_limited") return { _tag: "RateLimited", message: "Rate limited" }
    if (type === "configuration") return { _tag: "Configuration", message: "Configuration error" }
  }
  return { _tag: "Network", message: "Interview request failed" }
}

const statusFor = (tag: string): number => {
  switch (tag) {
    case "Unauthorized": return 403
    case "NotFound": return 404
    case "Validation": return 422
    case "Conflict": return 409
    case "RateLimited": return 429
    case "Configuration": return 503
    default: return 502
  }
}

export async function action({ request }: Route.ActionArgs) {
  if (!ownerEnabled()) throw new Response(null, { status: 404, headers: responseHeaders })
  try {
    const operation = decodeOperation(await request.json())
    return data(await runOperation(request, operation), { headers: responseHeaders })
  } catch (error) {
    const body = errorBody(error)
    return data(body, { status: statusFor(body._tag), headers: responseHeaders })
  }
}
