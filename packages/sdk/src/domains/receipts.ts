import { Effect, Schema } from "effect"
import type { Transport } from "../transport.js"
import type { InternalSdkError } from "../errors.js"

export type Receipt = {
  id: number
  visualId: string
  description: string
  sum: number
  receiptDate: string | null
  submitDate: string | null
  status: "pending" | "refunded" | "rejected"
  refundDate: string | null
}

export interface ReceiptsDomain {
  list(params?: { status?: string }): Effect.Effect<{ items: Receipt[], totalItems: number }, InternalSdkError>
  delete(id: string | number): Effect.Effect<void, InternalSdkError>
}

export function createReceiptsDomain(transport: Transport): ReceiptsDomain {
  return {
    list(params) {
      return transport.getCollection(
        "/api/my/receipts",
        Schema.Unknown,
        params?.status ? { status: params.status } : undefined,
      ) as Effect.Effect<{ items: Receipt[], totalItems: number }, InternalSdkError>
    },
    delete(id) {
      return transport.del(`/api/receipts/${id}`)
    },
  }
}
