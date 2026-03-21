import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"

export type Interview = {
  applicant: string
  interviewer: string
  date: string
  status: string
}

export interface AdminInterviewsDomain {
  list(): Effect.Effect<Interview[], InternalSdkError>
  assign(applicationId: number, interviewerId: number, interviewSchemaId: number): Effect.Effect<void, InternalSdkError>
}

export function createAdminInterviewsDomain(transport: Transport): AdminInterviewsDomain {
  return {
    list() {
      return transport.get("/api/admin/interviews", Schema.Unknown) as Effect.Effect<Interview[], InternalSdkError>
    },
    assign(applicationId, interviewerId, interviewSchemaId) {
      return transport.postVoid("/api/admin/interviews/assign", { applicationId, interviewerId, interviewSchemaId })
    },
  }
}
