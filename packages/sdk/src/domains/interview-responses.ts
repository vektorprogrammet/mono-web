import { Effect, Schema } from "effect"
import type { Transport } from "../transport.js"
import { Validation, type InternalSdkError } from "../errors.js"
import {
  CandidateInterviewViewFromRaw,
  InterviewResponseNewTimeInput,
  InterviewResponseRejectInput,
  ResponseCapability,
  type CandidateInterviewView,
} from "../schemas/interview.js"

const decodeCapability = (capability: unknown): Effect.Effect<ResponseCapability, InternalSdkError> =>
  Schema.decodeUnknownEffect(ResponseCapability)(capability).pipe(
    Effect.mapError((error) => new Validation({ message: `Invalid response capability: ${error.message}`, fields: {} })),
  )

export interface InterviewResponsesDomain {
  read(capability: ResponseCapability): Effect.Effect<CandidateInterviewView, InternalSdkError>
  confirm(capability: ResponseCapability): Effect.Effect<void, InternalSdkError>
  reject(capability: ResponseCapability, message?: string): Effect.Effect<void, InternalSdkError>
  requestNewTime(capability: ResponseCapability, message: string): Effect.Effect<void, InternalSdkError>
}

export function createInterviewResponsesDomain(transport: Transport): InterviewResponsesDomain {
  return {
    read(capability) {
      return decodeCapability(capability).pipe(
        Effect.flatMap((decodedCapability) =>
          transport.get(
            `/api/interview-responses/${encodeURIComponent(decodedCapability)}`,
            CandidateInterviewViewFromRaw,
          )
        ),
      )
    },
    confirm(capability) {
      return decodeCapability(capability).pipe(
        Effect.flatMap((decodedCapability) =>
          transport.postVoid(
            `/api/interview-responses/${encodeURIComponent(decodedCapability)}/accept`,
            {},
          )
        ),
      )
    },
    reject(capability, message = "") {
      return decodeCapability(capability).pipe(
        Effect.flatMap((decodedCapability) =>
          Schema.decodeUnknownEffect(InterviewResponseRejectInput)({ message }).pipe(
            Effect.mapError((error) => new Validation({ message: `Invalid rejection: ${error.message}`, fields: {} })),
            Effect.map(({ message: cancelMessage }) => ({ cancelMessage })),
            Effect.flatMap((body) =>
              transport.postVoid(
                `/api/interview-responses/${encodeURIComponent(decodedCapability)}/cancel`,
                body,
              )
            ),
          )
        ),
      )
    },
    requestNewTime(capability, message) {
      return decodeCapability(capability).pipe(
        Effect.flatMap((decodedCapability) =>
          Schema.decodeUnknownEffect(InterviewResponseNewTimeInput)({ message }).pipe(
            Effect.mapError((error) => new Validation({ message: `Invalid new-time request: ${error.message}`, fields: {} })),
            Effect.map(({ message: newTimeMessage }) => ({ newTimeMessage })),
            Effect.flatMap((body) =>
              transport.postVoid(
                `/api/interview-responses/${encodeURIComponent(decodedCapability)}/request-new-time`,
                body,
              )
            ),
          )
        ),
      )
    },
  }
}
