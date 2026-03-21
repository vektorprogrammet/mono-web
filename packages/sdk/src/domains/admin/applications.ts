import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"

export type Application = {
  id: number
  userName: string
  userEmail: string
  applicationStatus: number
  interviewStatus: string | null
  interviewScheduled: string | null
  interviewer: string | null
  previousParticipation: boolean
}

export type AdminApplicationListData = {
  status: string
  applications: Application[]
}

export interface AdminApplicationsDomain {
  list(params?: { status?: string | null }): Effect.Effect<AdminApplicationListData, InternalSdkError>
  delete(id: string | number): Effect.Effect<void, InternalSdkError>
}

export function createAdminApplicationsDomain(transport: Transport): AdminApplicationsDomain {
  return {
    list(params) {
      return transport.get(
        "/api/admin/applications",
        Schema.Unknown,
        params?.status ? { status: params.status } : undefined,
      ) as Effect.Effect<AdminApplicationListData, InternalSdkError>
    },
    delete(id) {
      return transport.del(`/api/admin/applications/${id}`)
    },
  }
}
