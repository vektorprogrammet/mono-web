import { Effect } from "effect"
import type { Transport } from "../transport.js"
import type { InternalSdkError } from "../errors.js"
import {
  CandidateInterviewViewFromRaw,
  type CandidateInterviewView,
  type ResponseCapability,
} from "../schemas/interview.js"

export interface InterviewResponsesDomain {
  read(capability: ResponseCapability): Effect.Effect<CandidateInterviewView, InternalSdkError>
  accept(capability: ResponseCapability): Effect.Effect<void, InternalSdkError>
}

export function createInterviewResponsesDomain(transport: Transport): InterviewResponsesDomain {
  return {
    read(capability) {
      return transport.get(
        `/api/interview-responses/${encodeURIComponent(capability)}`,
        CandidateInterviewViewFromRaw,
      )
    },
    accept(capability) {
      return transport.postVoid(
        `/api/interview-responses/${encodeURIComponent(capability)}/accept`,
        {},
      )
    },
  }
}
