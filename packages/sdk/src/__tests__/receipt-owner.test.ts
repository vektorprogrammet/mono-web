import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient } from "../promise.js"

const observation = {
  commandId: "command-1",
  receiptId: "receipt-1",
  visualId: "R-0001",
  status: "Pending",
  revision: 1,
  replayed: false,
}

const projection = {
  receiptId: "receipt-1",
  visualId: "R-0001",
  ownerPersonId: "person-1",
  departmentId: "department-1",
  amountOre: 12345,
  currency: "NOK",
  description: "Train ticket",
  receiptDate: "2026-08-20",
  status: "Pending",
  revision: 1,
}

const response = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
} as Response)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("canonical owner Receipt capability", () => {
  it("submits the exact multipart wire fields and preserves the observation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, observation))
    vi.stubGlobal("fetch", fetchMock)
    const client = createClient("http://api.test", { auth: "loopback-token" })
    const file = new File(["receipt"], "receipt.pdf", { type: "application/pdf" })

    const result = await client.receipts.submit(
      {
        commandId: "command-1",
        description: "Train ticket",
        amountOre: 12345,
        receiptDate: "2026-08-20",
      },
      file,
    )

    expect(result).toEqual(observation)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://api.test/api/receipts/submit")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer loopback-token")
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()

    const body = init.body as FormData
    expect(Array.from(body.keys())).toEqual([
      "commandId",
      "description",
      "amountOre",
      "receiptDate",
      "file",
    ])
    expect(body.get("commandId")).toBe("command-1")
    expect(body.get("description")).toBe("Train ticket")
    expect(body.get("amountOre")).toBe("12345")
    expect(body.get("receiptDate")).toBe("2026-08-20")
    expect(body.get("file")).toBeInstanceOf(File)
  })

  it("strictly decodes the command observation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response(200, { ...observation, unexpected: true }),
    ))
    const client = createClient("http://api.test")
    const file = new File(["receipt"], "receipt.pdf", { type: "application/pdf" })

    await expect(
      client.receipts.submit(
        {
          commandId: "command-1",
          description: "Train ticket",
          amountOre: 12345,
          receiptDate: "2026-08-20",
        },
        file,
      ),
    ).rejects.toMatchObject({
      type: "receipt_rejection",
      _tag: "ReceiptDecodeError",
      receiptTag: "ReceiptDecodeError",
    })
  })

  it("lists the strict owner projection and maps typed Receipt rejection tags", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { items: [projection], totalItems: 1 }))
      .mockResolvedValueOnce(response(409, {
        error: { tag: "DuplicateReceiptCommandConflict" },
      }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createClient("http://api.test", { auth: "loopback-token" })

    await expect(client.receipts.listOwned()).resolves.toEqual({
      items: [projection],
      totalItems: 1,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://api.test/api/receipts")
    expect(init.method).toBe("GET")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer loopback-token")

    await expect(client.receipts.listOwned()).rejects.toMatchObject({
      type: "receipt_rejection",
      _tag: "DuplicateReceiptCommandConflict",
      receiptTag: "DuplicateReceiptCommandConflict",
    })
  })
})
