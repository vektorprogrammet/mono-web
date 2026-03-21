/**
 * Schema round-trip tests — encode/decode and derived getters.
 */

import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { Receipt } from "../schemas/receipt.js"
import { ApplicationFromRaw } from "../schemas/application.js"

// Raw Receipt as returned from the API (dates as ISO strings)
const rawReceipt = {
  id: 1,
  visualId: "R-001",
  description: "Bus ticket",
  sum: 150,
  receiptDate: "2026-02-01",
  submitDate: "2026-02-05",
  status: "pending" as const,
  refundDate: null,
}

describe("Receipt", () => {
  it("decodes from raw API shape", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(Receipt)(rawReceipt),
    )
    expect(result).toBeInstanceOf(Receipt)
    expect(result.id).toBe(1)
    expect(result.description).toBe("Bus ticket")
    expect(result.receiptDate).toBeInstanceOf(Date)
    expect(result.submitDate).toBeInstanceOf(Date)
    expect(result.refundDate).toBeNull()
  })

  it("encodes back to raw API shape (round-trip)", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(Receipt)(rawReceipt),
    )
    const encoded = Schema.encodeSync(Receipt)(decoded)
    expect(typeof encoded.receiptDate).toBe("string")
    expect(typeof encoded.submitDate).toBe("string")
    expect(encoded.id).toBe(1)
  })

  it("isPending returns true when status is 'pending'", async () => {
    const receipt = await Effect.runPromise(
      Schema.decodeUnknown(Receipt)(rawReceipt),
    )
    expect(receipt.isPending).toBe(true)
  })

  it("isPending returns false when status is 'refunded'", async () => {
    const receipt = await Effect.runPromise(
      Schema.decodeUnknown(Receipt)({ ...rawReceipt, status: "refunded" }),
    )
    expect(receipt.isPending).toBe(false)
  })

  it("formattedAmount returns '<sum> kr'", async () => {
    const receipt = await Effect.runPromise(
      Schema.decodeUnknown(Receipt)(rawReceipt),
    )
    expect(receipt.formattedAmount).toBe("150 kr")
  })
})

const rawApplication = {
  id: 42,
  userName: "Alice",
  userEmail: "alice@example.com",
  applicationStatus: 1,
  interviewStatus: null,
  interviewer: null,
  interviewScheduled: null,
  previousParticipation: false,
}

describe("Application (ApplicationFromRaw)", () => {
  it("decodes from raw API shape with integer status", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ApplicationFromRaw)(rawApplication),
    )
    expect(result.status).toBe("received")
    expect(result.id).toBe(42)
    expect(result.userName).toBe("Alice")
  })

  it("encodes back (round-trip)", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(ApplicationFromRaw)(rawApplication),
    )
    const encoded = Schema.encodeSync(ApplicationFromRaw)(decoded)
    expect(typeof encoded.applicationStatus).toBe("number")
    expect(encoded.userName).toBe("Alice")
  })

  it("statusLabel returns a non-empty Norwegian label", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ApplicationFromRaw)(rawApplication),
    )
    expect(typeof result.statusLabel).toBe("string")
    expect(result.statusLabel.length).toBeGreaterThan(0)
  })
})
