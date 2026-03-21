import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { SchedulingAssistant, SchedulingSchool, Substitute } from "../../schemas/scheduling.js"

export interface AdminSchedulingDomain {
  assistants(params?: { page?: number; pageSize?: number }): Effect.Effect<{ items: SchedulingAssistant[]; totalItems: number }, InternalSdkError>
  schools(params?: { page?: number; pageSize?: number }): Effect.Effect<{ items: SchedulingSchool[]; totalItems: number }, InternalSdkError>
  substitutes(params?: { page?: number; pageSize?: number }): Effect.Effect<{ items: Substitute[]; totalItems: number }, InternalSdkError>
}

export function createAdminSchedulingDomain(transport: Transport): AdminSchedulingDomain {
  return {
    assistants(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.page) query.page = params.page
      if (params?.pageSize) query.itemsPerPage = params.pageSize
      return transport.getCollection("/api/admin/scheduling/assistants", SchedulingAssistant, query)
    },

    schools(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.page) query.page = params.page
      if (params?.pageSize) query.itemsPerPage = params.pageSize
      return transport.getCollection("/api/admin/scheduling/schools", SchedulingSchool, query)
    },

    substitutes(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.page) query.page = params.page
      if (params?.pageSize) query.itemsPerPage = params.pageSize
      return transport.getCollection("/api/admin/substitutes", Substitute, query)
    },
  }
}
