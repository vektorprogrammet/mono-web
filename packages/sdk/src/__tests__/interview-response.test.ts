import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Schema } from "effect"
import { ValidationError } from "../errors.js"
import { createClient } from "../promise.js"
import { ResponseCapability } from "../schemas/interview.js"
describe("interview response capability", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 31,
            scheduled: "2026-09-14T15:00:00+02:00",
            room: "Rom 31",
            campus: "Gløshaugen",
            mapLink: "https://maps.example.invalid/interview-0031",
            interviewerName: "Intervjuer 0031",
            status: "Ingen svar",
            responseCode: "response_0031",
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 204 })
    })
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("decodes a capability response without exposing the raw response code", async () => {
    const client = createClient("http://api.test")
    const capability = Schema.decodeUnknownSync(ResponseCapability)("response_0031")

    const view = await client.interviewResponses.read(capability)

    expect(view).toMatchObject({
      schedulingStatus: "pending",
      interviewTime: "2026-09-14T15:00:00+02:00",
      room: "Rom 31",
      campus: "Gløshaugen",
    })
    expect(view).not.toHaveProperty("responseCode")
  })

  it("maps domain transitions to the canonical Symfony endpoints", async () => {
    const client = createClient("http://api.test")
    const capability = Schema.decodeUnknownSync(ResponseCapability)("response_0031")

    await client.interviewResponses.confirm(capability)
    await client.interviewResponses.reject(capability, "Jeg kan ikke delta")
    await client.interviewResponses.requestNewTime(capability, "Kan vi møtes torsdag?")

    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      body: init?.body,
    }))).toEqual([
      {
        url: "http://api.test/api/interview-responses/response_0031/accept",
        method: "POST",
        body: "{}",
      },
      {
        url: "http://api.test/api/interview-responses/response_0031/cancel",
        method: "POST",
        body: JSON.stringify({ cancelMessage: "Jeg kan ikke delta" }),
      },
      {
        url: "http://api.test/api/interview-responses/response_0031/request-new-time",
        method: "POST",
        body: JSON.stringify({ newTimeMessage: "Kan vi møtes torsdag?" }),
      },
    ])
  })

  it("accepts the server-held browser capability sentinel", () => {
    expect(Schema.decodeUnknownSync(ResponseCapability)("server-held")).toBe("server-held")
  })

  it("fails malformed capabilities and empty new-time messages through typed validation", async () => {
    expect(() => Schema.decodeUnknownSync(ResponseCapability)("bad capability")).toThrow()
    const client = createClient("http://api.test")
    const capability = Schema.decodeUnknownSync(ResponseCapability)("response_0031")

    await expect(client.interviewResponses.requestNewTime(capability, ""))
      .rejects.toBeInstanceOf(ValidationError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
