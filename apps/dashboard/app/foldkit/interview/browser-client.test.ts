import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect, Schema } from "effect"
import { ResponseCapability } from "@vektorprogrammet/sdk/effect"
import { createBrowserInterviewClient } from "./browser-client"
describe("browser interview response bridge", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(null),
    })
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("forwards response messages without persisting the capability", async () => {
    const client = createBrowserInterviewClient()
    const capability = Schema.decodeUnknownSync(ResponseCapability)("server-held")

    await Effect.runPromise(client.interviewResponses.reject(capability, "Jeg kan ikke delta."))
    await Effect.runPromise(client.interviewResponses.requestNewTime(capability, "Kan vi møtes torsdag?"))

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { operation: "rejectCandidate", message: "Jeg kan ikke delta." },
      { operation: "requestNewTimeCandidate", message: "Kan vi møtes torsdag?" },
    ])
  })
})
