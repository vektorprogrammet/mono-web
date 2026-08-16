import { createElement } from "react"
import { DASHBOARD_ELEMENT } from "../foldkit/interview/elements"
import { ownerEnabled, responseHeaders } from "../lib/interview-bridge.server"

export function loader() {
  if (!ownerEnabled()) throw new Response(null, { status: 404, headers: responseHeaders })
  return new Response(null, { headers: responseHeaders })
}

export const headers = () => responseHeaders

export default function DashboardFoldkitInterviewRoute() {
  return createElement(DASHBOARD_ELEMENT)
}
