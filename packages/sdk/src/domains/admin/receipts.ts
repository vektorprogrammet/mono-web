import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { AdminReceipt } from "../../schemas/receipt.js"

export interface AdminReceiptsDomain {
  list(params?: { status?: string; page?: number; pageSize?: number }): Effect.Effect<{ items: AdminReceipt[]; totalItems: number }, InternalSdkError>
  approve(id: number): Effect.Effect<void, InternalSdkError>
  reject(id: number): Effect.Effect<void, InternalSdkError>
  reopen(id: number): Effect.Effect<void, InternalSdkError>
}

export function createAdminReceiptsDomain(transport: Transport): AdminReceiptsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.status) query.status = params.status
      if (params?.page) query.page = params.page
      if (params?.pageSize) query.itemsPerPage = params.pageSize
      return transport.getCollection("/api/admin/receipts", AdminReceipt, query)
    },

    approve(id) {
      return transport.put(`/api/admin/receipts/${id}/status`, { status: "refunded" })
    },

    reject(id) {
      return transport.put(`/api/admin/receipts/${id}/status`, { status: "rejected" })
    },

    reopen(id) {
      return transport.put(`/api/admin/receipts/${id}/status`, { status: "pending" })
    },
  }
}
