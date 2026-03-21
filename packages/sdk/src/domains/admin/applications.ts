/**
 * Admin applications domain — list, get, delete, bulk-delete.
 *
 * Endpoints:
 *   GET    /api/admin/applications
 *   GET    /api/admin/applications/{id}
 *   DELETE /api/admin/applications/{id}
 *   POST   /api/admin/applications/bulk-delete
 */

import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { ApplicationFromRaw, ApplicationDetailFromRaw, type Application, type ApplicationDetail } from "../../schemas/application.js"

export interface AdminApplicationsDomain {
  list(params?: {
    page?: number
    pageSize?: number
    status?: string
  }): Effect.Effect<{ items: Application[]; totalItems: number }, InternalSdkError>

  get(id: number): Effect.Effect<ApplicationDetail, InternalSdkError>

  delete(id: number): Effect.Effect<void, InternalSdkError>

  bulkDelete(ids: number[]): Effect.Effect<void, InternalSdkError>
}

export function createAdminApplicationsDomain(transport: Transport): AdminApplicationsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.page !== undefined) query.page = params.page
      if (params?.pageSize !== undefined) query.itemsPerPage = params.pageSize
      if (params?.status !== undefined) query.status = params.status
      return transport.getCollection("/api/admin/applications", ApplicationFromRaw, query)
    },

    get(id) {
      return transport.get(`/api/admin/applications/${id}`, ApplicationDetailFromRaw)
    },

    delete(id) {
      return transport.del(`/api/admin/applications/${id}`)
    },

    bulkDelete(ids) {
      return transport.postVoid("/api/admin/applications/bulk-delete", { ids })
    },
  }
}
