import {
  CandidateInterviewView,
  Interview,
  InterviewId,
  InterviewScheduleInput,
  type EffectSdk,
} from "@vektorprogrammet/sdk/effect"
import { Effect, Schema } from "effect"

const interviewListSchema = Schema.Struct({
  items: Schema.Array(Interview),
  totalItems: Schema.Number,
})

type BridgeFailure = {
  readonly _tag: "Unauthorized" | "NotFound" | "Validation" | "Conflict" | "Network" | "RateLimited" | "Configuration"
  readonly message: string
}

const bridgeRequest = <A>(
  operation: string,
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
        typeof cause === "object" && cause !== null &&
        "_tag" in cause && "message" in cause &&
        typeof cause._tag === "string" && typeof cause.message === "string"
      ) {
        const tag = cause._tag
        if (
          tag === "Unauthorized" || tag === "NotFound" || tag === "Validation" ||
          tag === "Conflict" || tag === "Network" || tag === "RateLimited" ||
          tag === "Configuration"
        ) return { _tag: tag, message: cause.message }
      }
      return { _tag: "Network", message: "Same-origin interview request failed" }
    },
  })

export const createBrowserInterviewClient = (): EffectSdk => ({
  admin: {
    interviews: {
      list: () =>
        bridgeRequest("listInterviews", {}, Schema.decodeUnknownSync(interviewListSchema)),
      read: (id: number) =>
        bridgeRequest(
          "readInterview",
          { interviewId: Schema.decodeUnknownSync(InterviewId)(id) },
          Schema.decodeUnknownSync(Interview),
        ),
      schedule: (
        id: number,
        input: typeof InterviewScheduleInput.Type,
      ) =>
        bridgeRequest(
          "scheduleInterview",
          {
            interviewId: Schema.decodeUnknownSync(InterviewId)(id),
            input: Schema.decodeUnknownSync(InterviewScheduleInput)(input),
          },
          () => undefined,
        ),
    },
  },
  interviewResponses: {
    read: () =>
      bridgeRequest("readCandidate", {}, Schema.decodeUnknownSync(CandidateInterviewView)),
    accept: () => bridgeRequest("acceptCandidate", {}, () => undefined),
  },
} as unknown as EffectSdk)
