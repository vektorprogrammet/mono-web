import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"

export type AdminReceipt = {
  id: number
  visualId: string
  userName: string
  description: string
  sum: number
  receiptDate: string
  submitDate: string | null
  status: "pending" | "refunded" | "rejected"
}

export interface AdminReceiptsDomain {
  list(params?: { status?: string | null }): Effect.Effect<{ items: AdminReceipt[], totalItems: number }, InternalSdkError>
  approve(id: string | number): Effect.Effect<void, InternalSdkError>
  reject(id: string | number): Effect.Effect<void, InternalSdkError>
  reopen(id: string | number): Effect.Effect<void, InternalSdkError>
}

export function createAdminReceiptsDomain(transport: Transport): AdminReceiptsDomain {
  return {
    list(params) {
      return transport.getCollection(
        "/api/admin/receipts",
        Schema.Unknown,
        params?.status ? { status: params.status } : undefined,
      ) as Effect.Effect<{ items: AdminReceipt[], totalItems: number }, InternalSdkError>
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
