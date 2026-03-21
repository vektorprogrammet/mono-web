/**
 * Transport layer tests.
 * Mocks globalThis.fetch to exercise HTTP mapping, auth injection, and error mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Effect, Schema } from "effect"
import { createTransport } from "../transport.js"
import {
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  NetworkError,
} from "../errors.js"

// Helper: run an Effect to a Promise, mapping InternalSdkError to public SdkError
function run<A>(effect: Effect.Effect<A, any>): Promise<A> {
  return Effect.runPromise(effect)
}

function runFail<E>(effect: Effect.Effect<any, E>): Promise<E> {
  return Effect.runPromise(
    effect.pipe(
      Effect.flip,
    ),
  )
}

function makeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

function makeFetchNetworkError(message: string): () => never {
  return () => {
    throw new Error(message)
  }
}

const SimpleSchema = Schema.Struct({ name: Schema.String })

describe("createTransport", () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal("fetch", mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("successful GET", () => {
    it("returns decoded data when response is 200", async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse(200, { name: "Alice" }))
      const transport = createTransport("http://api.test")
      const result = await run(transport.get("/test", SimpleSchema))
      expect(result).toEqual({ name: "Alice" })
    })
  })

  describe("error mapping", () => {
    it("throws error with _tag Unauthorized on 401 response", async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse(401, {}))
      const transport = createTransport("http://api.test")
      const error = await runFail(transport.get("/test", SimpleSchema))
      expect(error._tag).toBe("Unauthorized")
    })

    it("throws error with _tag NotFound on 404 response", async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse(404, {}))
      const transport = createTransport("http://api.test")
      const error = await runFail(transport.get("/test", SimpleSchema))
      expect(error._tag).toBe("NotFound")
    })

    it("throws error with _tag Validation on 422 response", async () => {
      const body = {
        violations: [{ propertyPath: "email", message: "Invalid email" }],
      }
      mockFetch.mockResolvedValueOnce(makeFetchResponse(422, body))
      const transport = createTransport("http://api.test")
      const error = await runFail(transport.get("/test", SimpleSchema))
      expect(error._tag).toBe("Validation")
      expect(error.fields).toEqual({ email: "Invalid email" })
    })

    it("throws error with _tag Network on fetch rejection", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      const transport = createTransport("http://api.test")
      const error = await runFail(transport.get("/test", SimpleSchema))
      expect(error._tag).toBe("Network")
    })
  })

  describe("auth", () => {
    it("sends static string auth as Bearer header", async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse(200, { name: "Bob" }))
      const transport = createTransport("http://api.test", "my-token")
      await run(transport.get("/test", SimpleSchema))
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-token")
    })

    it("calls auth function before each request and uses returned token", async () => {
      const authFn = vi.fn().mockResolvedValue("dynamic-token")
      mockFetch.mockResolvedValue(makeFetchResponse(200, { name: "Bob" }))
      const transport = createTransport("http://api.test", authFn)

      await run(transport.get("/test", SimpleSchema))
      await run(transport.get("/test", SimpleSchema))

      expect(authFn).toHaveBeenCalledTimes(2)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer dynamic-token")
    })
  })
})
