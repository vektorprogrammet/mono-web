import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { AdminReceipt } from "../../schemas/receipt.js"
import type { Page } from "../../schemas/common.js"

export interface AdminReceiptsDomain {
  list(params?: { status?: string; page?: number; pageSize?: number }): Effect.Effect<Page<AdminReceipt>, InternalSdkError>
  approve(id: number): Effect.Effect<void, InternalSdkError>
  reject(id: number): Effect.Effect<void, InternalSdkError>
  reopen(id: number): Effect.Effect<void, InternalSdkError>
}

export function createAdminReceiptsDomain(transport: Transport): AdminReceiptsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.status !== undefined) query.status = params.status
      if (params?.page !== undefined) query.page = params.page
      if (params?.pageSize !== undefined) query.itemsPerPage = params.pageSize
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
