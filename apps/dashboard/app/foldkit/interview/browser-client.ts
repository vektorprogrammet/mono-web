import {
  CandidateInterviewView,
  ResponseCapability,
} from "@vektorprogrammet/sdk/effect"
import { Effect, Schema } from "effect"

type BridgeFailure = {
  readonly _tag:
    | "Unauthorized"
    | "NotFound"
    | "Validation"
    | "Conflict"
    | "Network"
    | "RateLimited"
    | "Configuration"
  readonly message: string
}

type CandidateBridgeOperation =
  | "readCandidate"
  | "confirmCandidate"
  | "rejectCandidate"
  | "requestNewTimeCandidate"

export interface InterviewResponseClient {
  readonly interviewResponses: Readonly<{
    readonly read: (
      capability: typeof ResponseCapability.Type,
    ) => Effect.Effect<typeof CandidateInterviewView.Type, BridgeFailure>
    readonly confirm: (
      capability: typeof ResponseCapability.Type,
    ) => Effect.Effect<void, BridgeFailure>
    readonly reject: (
      capability: typeof ResponseCapability.Type,
      message?: string,
    ) => Effect.Effect<void, BridgeFailure>
    readonly requestNewTime: (
      capability: typeof ResponseCapability.Type,
      message: string,
    ) => Effect.Effect<void, BridgeFailure>
  }>
}

const bridgeRequest = <A>(
  operation: CandidateBridgeOperation,
  body: Record<string, unknown>,
  decode: (value: unknown) => A,
): Effect.Effect<A, BridgeFailure> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch("/interview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, ...body }),
      })
      const payload: unknown = await response.json()
      if (!response.ok) throw payload
      return decode(payload)
    },
    catch: (cause): BridgeFailure => {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        "message" in cause &&
        typeof cause._tag === "string" &&
        typeof cause.message === "string"
      ) {
        const tag = cause._tag
        if (
          tag === "Unauthorized" ||
          tag === "NotFound" ||
          tag === "Validation" ||
          tag === "Conflict" ||
          tag === "Network" ||
          tag === "RateLimited" ||
          tag === "Configuration"
        ) {
          return { _tag: tag, message: cause.message }
        }
      }
      return { _tag: "Network", message: "Same-origin interview request failed" }
    },
  })

export const createBrowserInterviewClient = (): InterviewResponseClient => ({
  interviewResponses: {
    read: (_capability) =>
      bridgeRequest("readCandidate", {}, Schema.decodeUnknownSync(CandidateInterviewView)),
    confirm: (_capability) => bridgeRequest("confirmCandidate", {}, () => undefined),
    reject: (_capability, message) =>
      bridgeRequest("rejectCandidate", { message: message ?? "" }, () => undefined),
    requestNewTime: (_capability, message) =>
      bridgeRequest("requestNewTimeCandidate", { message }, () => undefined),
  },
})
