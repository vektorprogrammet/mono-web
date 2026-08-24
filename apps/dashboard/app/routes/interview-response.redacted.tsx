import { createElement } from "react"
import { CANDIDATE_ELEMENT } from "../foldkit/interview/elements"
import { responseHeaders } from "../lib/interview-bridge.server"

export function loader() {
  return new Response(null, { headers: responseHeaders })
}

export const headers = () => responseHeaders

export default function InterviewResponseRoute() {
  return createElement(CANDIDATE_ELEMENT)
}
