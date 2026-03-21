import { Effect } from "effect"
import type { Transport } from "../transport.js"
import type { InternalSdkError } from "../errors.js"
import { Receipt, ReceiptCreateResponse, ReceiptInput } from "../schemas/receipt.js"

export interface ReceiptsDomain {
  list(params?: { status?: string; page?: number; pageSize?: number }): Effect.Effect<{ items: Receipt[]; totalItems: number }, InternalSdkError>
  create(input: typeof ReceiptInput.Type, file?: File): Effect.Effect<{ id: number }, InternalSdkError>
  update(id: number, input: typeof ReceiptInput.Type, file?: File): Effect.Effect<void, InternalSdkError>
  delete(id: number): Effect.Effect<void, InternalSdkError>
}

export function createReceiptsDomain(transport: Transport): ReceiptsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.status) query.status = params.status
      if (params?.page) query.page = params.page
      if (params?.pageSize) query.itemsPerPage = params.pageSize
      return transport.getCollection("/api/receipts", Receipt, query)
    },

    create(input, file) {
      if (file) {
        const formData = new FormData()
        formData.append("description", input.description)
        formData.append("sum", String(input.sum))
        formData.append("receiptDate", input.receiptDate)
        formData.append("file", file)
        return transport.postFormData("/api/receipts", formData, ReceiptCreateResponse)
      }
      return transport.post("/api/receipts", input, ReceiptCreateResponse)
    },

    update(id, input, file) {
      if (file) {
        const formData = new FormData()
        formData.append("description", input.description)
        formData.append("sum", String(input.sum))
        formData.append("receiptDate", input.receiptDate)
        formData.append("file", file)
        return transport.postFormDataVoid(`/api/receipts/${id}`, formData)
      }
      return transport.put(`/api/receipts/${id}`, input)
    },

    delete(id) {
      return transport.del(`/api/receipts/${id}`)
    },
  }
}
