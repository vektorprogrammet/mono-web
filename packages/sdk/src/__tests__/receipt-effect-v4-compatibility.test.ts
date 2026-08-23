import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { createClient, ConfigurationError, NetworkError, NotFoundError, UnauthorizedError, ValidationError, ConflictError, RateLimitedError } from "../promise.js"
import { createEffectClient } from "../effect-client.js"
import { apiUrl } from "../config.js"

const FIXTURE_URL = "https://receipt-fixture.invalid"
const RAILWAY_URL = "https://vektorprogrammet-production.up.railway.app"

const validReceipt = {
  id: 42,
  visualId: "receipt-42",
  description: "Travel to course",
  sum: 125.5,
  receiptDate: "2026-08-08",
  submitDate: "2026-08-09T10:00:00Z",
  status: "pending",
  refundDate: null,
  userName: "Synthetic User",
}

const validHydra = {
  "hydra:member": [validReceipt],
  "hydra:totalItems": 1,
}

type RecordedRequest = { url: string; init: RequestInit }

function makeResponse(status: number, body?: unknown, parse = true): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: parse
      ? () => Promise.resolve(body)
      : () => {
          throw new Error("response.json() must not be called")
        },
  } as unknown as Response
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (headers === undefined) return undefined
  const record = headers as Record<string, string>
  return record[name] ?? record[name.toLowerCase()]
}

function expectMethods(domain: object, names: readonly string[]): void {
  for (const name of names) {
    expect(typeof (domain as Record<string, unknown>)[name]).toBe("function")
  }
}

describe("Effect v4 Receipt compatibility", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let requests: RecordedRequest[]

  beforeEach(() => {
    requests = []
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps both public entrypoints, namespaces, verbs, and execution shapes", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init: init ?? {} })
      return makeResponse(200, validHydra)
    })

    const promiseClient = createClient(FIXTURE_URL, { auth: "trace-token" })
    const effectClient = createEffectClient(FIXTURE_URL, { auth: "trace-token" })

    for (const client of [promiseClient, effectClient]) {
      expect(client).toHaveProperty("auth")
      expect(client).toHaveProperty("me")
      expect(client).toHaveProperty("receipts")
      expect(client).toHaveProperty("admin")
      expect(client).toHaveProperty("public")
      expect(client).toHaveProperty("context")
      expectMethods(client.auth, ["login", "resetPassword", "setPassword"])
      expectMethods(client.me, ["profile", "dashboard", "updateProfile"])
      expectMethods(client.receipts, ["list", "create", "update", "delete"])
      expectMethods(client.admin.receipts, ["list", "approve", "reject", "reopen"])
      expectMethods(client.admin.applications, ["list", "get", "delete", "bulkDelete"])
      expectMethods(client.admin.interviews, ["list", "assign", "schedule", "conduct", "cancel", "schemas"])
      expectMethods(client.admin.users, ["list"])
      expectMethods(client.admin.scheduling, ["assistants", "schools", "substitutes"])
      expectMethods(client.admin.teams, ["list", "interest"])
      expectMethods(client.admin, ["mailingLists", "admissionStats"])
      expectMethods(client.public, ["departments", "fieldOfStudies", "sponsors", "teams"])
      expectMethods(client.public.contactMessages, ["submit"])
    }

    const promiseResult = promiseClient.admin.receipts.list({ status: "pending", page: 1, pageSize: 2 })
    expect(typeof promiseResult.then).toBe("function")
    await promiseResult

    const effectResult = effectClient.admin.receipts.list({ status: "pending", page: 1, pageSize: 2 })
    expect(Effect.isEffect(effectResult)).toBe(true)
    await Effect.runPromise(effectResult)
  })

  it("exports undefined apiUrl without absent-env module side effects", async () => {
    const originalApiUrl = process.env.API_URL
    const originalViteApiUrl = process.env.VITE_API_URL
    try {
      delete process.env.API_URL
      delete process.env.VITE_API_URL
      vi.resetModules()
      // Deliberately reload the known module to exercise evaluation with both env inputs absent.
      const imported = await import("../config.js")
      expect(imported.apiUrl).toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(apiUrl).not.toBe(RAILWAY_URL)
    } finally {
      if (originalApiUrl === undefined) delete process.env.API_URL
      else process.env.API_URL = originalApiUrl
      if (originalViteApiUrl === undefined) delete process.env.VITE_API_URL
      else process.env.VITE_API_URL = originalViteApiUrl
      vi.resetModules()
    }
  })

  it("fails configuration inside the operation without calling fetch", async () => {
    const promiseClient = createClient(undefined)
    const effectClient = createEffectClient(undefined)
    expect(() => createClient(undefined)).not.toThrow()
    expect(() => createEffectClient(undefined)).not.toThrow()

    const promiseError = await promiseClient.admin.receipts.list().catch((error: unknown) => error)
    expect(promiseError).toBeInstanceOf(ConfigurationError)
    expect(promiseError).toMatchObject({ type: "configuration" })

    const effectError = await Effect.runPromise(Effect.flip(effectClient.admin.receipts.list()))
    expect(effectError).toMatchObject({ _tag: "Configuration" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(requests.some(({ url }) => url.includes(RAILWAY_URL))).toBe(false)

    const invalidPromise = createClient("not-a-url")
    const invalidEffect = createEffectClient("not-a-url")
    await expect(invalidPromise.admin.receipts.list()).rejects.toMatchObject({ type: "configuration" })
    const invalidEffectError = await Effect.runPromise(Effect.flip(invalidEffect.admin.receipts.list()))
    expect(invalidEffectError).toMatchObject({ _tag: "Configuration" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("authenticates and strictly decodes the Promise Receipt list", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init: init ?? {} })
      return makeResponse(200, validHydra)
    })
    const client = createClient(FIXTURE_URL, { auth: "trace-token" })

    const result = await client.admin.receipts.list({ status: "pending", page: 1, pageSize: 2 })
    expect(result).toMatchObject({ items: [expect.anything()], totalItems: 1, page: 1, pageSize: 2 })
    const item = result.items[0]!
    expect(item).toMatchObject({
      id: 42,
      visualId: "receipt-42",
      description: "Travel to course",
      sum: 125.5,
      status: "pending",
      refundDate: null,
      userName: "Synthetic User",
    })
    expect(item.receiptDate).toBeInstanceOf(Date)
    expect(item.submitDate).toBeInstanceOf(Date)
    expect(item.receiptDate.toISOString()).toContain("2026-08-08")
    expect(item.submitDate.toISOString()).toBe("2026-08-09T10:00:00.000Z")

    expect(requests[0]?.url).toBe(`${FIXTURE_URL}/api/admin/receipts?status=pending&page=1&itemsPerPage=2`)
    expect(header(requests[0]?.init, "Accept")).toBe("application/ld+json")
    expect(header(requests[0]?.init, "Authorization")).toBe("Bearer trace-token")
  })

  it("returns a direct Effect list value with the same Page-compatible result", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, validHydra))
    const client = createEffectClient(FIXTURE_URL, { auth: "trace-token" })
    const effect = client.admin.receipts.list({ status: "pending", page: 1, pageSize: 2 })
    expect(Effect.isEffect(effect)).toBe(true)

    const result = await Effect.runPromise(effect)
    expect(result).toMatchObject({ totalItems: 1, page: 1, pageSize: 2 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.receiptDate).toBeInstanceOf(Date)
    expect(result.items[0]?.submitDate).toBeInstanceOf(Date)
  })

  it("maps approve to refunded and treats 204 as void without parsing JSON", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init: init ?? {} })
      return makeResponse(204, undefined, false)
    })
    const promiseClient = createClient(FIXTURE_URL, { auth: "trace-token" })
    await expect(promiseClient.admin.receipts.approve(42)).resolves.toBeUndefined()
    expect(requests[0]?.url).toBe(`${FIXTURE_URL}/api/admin/receipts/42/status`)
    expect(requests[0]?.init.method).toBe("PUT")
    expect(header(requests[0]?.init, "Authorization")).toBe("Bearer trace-token")
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ status: "refunded" })

    requests = []
    const effectClient = createEffectClient(FIXTURE_URL, { auth: "trace-token" })
    const effect = effectClient.admin.receipts.approve(42)
    expect(Effect.isEffect(effect)).toBe(true)
    await expect(Effect.runPromise(effect)).resolves.toBeUndefined()
    expect(requests[0]?.url).toBe(`${FIXTURE_URL}/api/admin/receipts/42/status`)
    expect(requests[0]?.init.method).toBe("PUT")
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ status: "refunded" })
  })

  it("rejects malformed Hydra envelopes, members, and ISO dates before exposing values", async () => {
    const malformedBodies = [
      { "hydra:totalItems": 1 },
      { "hydra:member": { id: 42 }, "hydra:totalItems": 1 },
      { "hydra:member": [{ ...validReceipt, userName: undefined }], "hydra:totalItems": 1 },
      { "hydra:member": [{ ...validReceipt, receiptDate: "not-a-date" }], "hydra:totalItems": 1 },
    ]

    for (const body of malformedBodies) {
      fetchMock.mockResolvedValue(makeResponse(200, body))
      const promiseClient = createClient(FIXTURE_URL)
      const promiseError = await promiseClient.admin.receipts.list().catch((error: unknown) => error)
      expect(promiseError).toBeInstanceOf(ValidationError)
      expect(promiseError).toMatchObject({ type: "validation" })

      const effectClient = createEffectClient(FIXTURE_URL)
      const effectError = await Effect.runPromise(Effect.flip(effectClient.admin.receipts.list()))
      expect(effectError).toMatchObject({ _tag: "Validation" })
    }
  })

  it("preserves typed HTTP and network error mappings on both surfaces", async () => {
    const cases = [
      [401, UnauthorizedError, "unauthorized", "Unauthorized"] as const,
      [403, UnauthorizedError, "unauthorized", "Unauthorized"] as const,
      [404, NotFoundError, "not_found", "NotFound"] as const,
      [409, ConflictError, "conflict", "Conflict"] as const,
      [422, ValidationError, "validation", "Validation"] as const,
      [429, RateLimitedError, "rate_limited", "RateLimited"] as const,
      [500, NetworkError, "network", "Network"] as const,
    ]

    for (const [status, publicError, publicType, effectTag] of cases) {
      const body = status === 422
        ? { violations: [{ propertyPath: "description", message: "Too short" }] }
        : {}
      fetchMock.mockResolvedValue(makeResponse(status, body))
      const promiseClient = createClient(FIXTURE_URL)
      const promiseError = await promiseClient.admin.receipts.list().catch((error: unknown) => error)
      expect(promiseError).toBeInstanceOf(publicError)
      expect(promiseError).toMatchObject({ type: publicType })
      if (status === 422) expect(promiseError).toMatchObject({ fields: { description: "Too short" } })

      const effectClient = createEffectClient(FIXTURE_URL)
      const effectError = await Effect.runPromise(Effect.flip(effectClient.admin.receipts.list()))
      expect(effectError).toMatchObject({ _tag: effectTag })
      if (status === 422) expect(effectError).toMatchObject({ fields: { description: "Too short" } })
    }

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    const promiseNetworkError = await createClient(FIXTURE_URL).admin.receipts.list().catch((error: unknown) => error)
    expect(promiseNetworkError).toBeInstanceOf(NetworkError)
    expect(promiseNetworkError).toMatchObject({ type: "network" })
    const effectNetworkError = await Effect.runPromise(Effect.flip(createEffectClient(FIXTURE_URL).admin.receipts.list()))
    expect(effectNetworkError).toMatchObject({ _tag: "Network" })
  })

  it("resolves async auth for each request without changing the public seam", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init: init ?? {} })
      return makeResponse(200, validHydra)
    })
    const auth = vi.fn().mockResolvedValue("trace-token")
    const client = createClient(FIXTURE_URL, { auth })

    await client.admin.receipts.list()
    await client.admin.receipts.list()

    expect(auth).toHaveBeenCalledTimes(2)
    expect(header(requests[0]?.init, "Authorization")).toBe("Bearer trace-token")
    expect(header(requests[1]?.init, "Authorization")).toBe("Bearer trace-token")
  })

  it("propagates fiber interruption to fetch and leaves no owned request work", async () => {
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let receivedSignal: AbortSignal | undefined
    let activeRequests = 0
    let abortObservations = 0
    let completionObservations = 0
    let listenerActive = false

    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      activeRequests += 1
      receivedSignal = init?.signal ?? undefined
      resolveStarted()
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal === undefined) {
          activeRequests -= 1
          reject(new Error("missing abort signal"))
          return
        }
        let settled = false
        const onAbort = () => {
          if (settled) return
          settled = true
          listenerActive = false
          activeRequests -= 1
          abortObservations += 1
          signal.removeEventListener("abort", onAbort)
          reject(new Error("aborted"))
        }
        listenerActive = true
        signal.addEventListener("abort", onAbort, { once: true })
      }).then((response) => {
        completionObservations += 1
        return response
      })
    })

    const client = createEffectClient(FIXTURE_URL)
    const fiber = Effect.runFork(client.admin.receipts.list())
    await started
    await Effect.runPromise(Fiber.interrupt(fiber))
    const ownerExit = await Effect.runPromise(Fiber.await(fiber))

    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(receivedSignal?.aborted).toBe(true)
    expect(abortObservations).toBe(1)
    expect(activeRequests).toBe(0)
    expect(completionObservations).toBe(0)
    expect(listenerActive).toBe(false)
    expect(Exit.isFailure(ownerExit)).toBe(true)
    if (Exit.isFailure(ownerExit)) {
      expect(Cause.hasInterruptsOnly(ownerExit.cause)).toBe(true)
    }
  })
})

const APPLICATION_FIXTURE_URL = "https://application-status-fixture.invalid"
const applicationStatusCases = [
  [-1, "cancelled", "Avbrutt"],
  [0, "not_received", "Ikke mottatt"],
  [1, "received", "Mottatt"],
  [2, "invited", "Invitert"],
  [3, "accepted", "Akseptert"],
  [4, "completed", "Fullført"],
  [5, "assigned", "Tildelt skole"],
] as const

const validApplication = {
  id: 101,
  userName: "Synthetic Applicant",
  userEmail: "applicant@example.com",
  interviewStatus: null,
  interviewer: null,
  interviewScheduled: null,
  previousParticipation: false,
}

function applicationResponse(applicationStatus: number) {
  return { ...validApplication, applicationStatus }
}

function applicationCollection(applicationStatus: number) {
  return {
    "hydra:member": [applicationResponse(applicationStatus)],
    "hydra:totalItems": 1,
  }
}

describe("Application status typed decode", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let requests: RecordedRequest[]

  beforeEach(() => {
    requests = []
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function expectValidationExit<A, E>(exit: Exit.Exit<A, E>): void {
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(false)
    expect(Cause.hasFails(exit.cause)).toBe(true)
    const error = Cause.findErrorOption(exit.cause)
    expect(Option.isSome(error)).toBe(true)
    if (Option.isSome(error)) {
      expect(error.value).toMatchObject({ _tag: "Validation" })
    }
  }

  function stubMalformedResponses(): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      requests.push({ url, init: init ?? {} })
      return makeResponse(
        200,
        url.endsWith("/101")
          ? applicationResponse(999)
          : applicationCollection(999),
      )
    })
  }

  it("rejects unknown application status through the Promise list channel", async () => {
    stubMalformedResponses()
    const error = await createClient(APPLICATION_FIXTURE_URL).admin.applications.list().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({ type: "validation" })
    expect(requests.map(({ url }) => url)).toEqual([
      `${APPLICATION_FIXTURE_URL}/api/admin/applications`,
    ])
    expect(requests.every(({ init }) => header(init, "Authorization") === undefined)).toBe(true)
  })

  it("rejects unknown application status through the Promise detail channel", async () => {
    stubMalformedResponses()
    const error = await createClient(APPLICATION_FIXTURE_URL).admin.applications.get(101).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({ type: "validation" })
    expect(requests.map(({ url }) => url)).toEqual([
      `${APPLICATION_FIXTURE_URL}/api/admin/applications/101`,
    ])
  })

  it("fails unknown application status through the Effect list channel without a defect", async () => {
    stubMalformedResponses()
    const exit = await Effect.runPromiseExit(
      createEffectClient(APPLICATION_FIXTURE_URL).admin.applications.list(),
    )
    expectValidationExit(exit)
  })

  it("fails unknown application status through the Effect detail channel without a defect", async () => {
    stubMalformedResponses()
    const exit = await Effect.runPromiseExit(
      createEffectClient(APPLICATION_FIXTURE_URL).admin.applications.get(101),
    )
    expectValidationExit(exit)
  })

  it("preserves all seven application statuses across valid Promise and Effect list/detail results", async () => {
    const promiseClient = createClient(APPLICATION_FIXTURE_URL)
    const effectClient = createEffectClient(APPLICATION_FIXTURE_URL)

    for (const [rawStatus, expectedStatus, expectedLabel] of applicationStatusCases) {
      fetchMock.mockResolvedValueOnce(makeResponse(200, applicationCollection(rawStatus)))
      const promiseList = await promiseClient.admin.applications.list()
      expect(promiseList).toMatchObject({ totalItems: 1, page: 1, pageSize: 30 })
      expect(promiseList.items[0]).toMatchObject({
        id: 101,
        userName: "Synthetic Applicant",
        userEmail: "applicant@example.com",
        status: expectedStatus,
      })
      expect(promiseList.items[0]?.statusLabel).toBe(expectedLabel)

      fetchMock.mockResolvedValueOnce(makeResponse(200, applicationResponse(rawStatus)))
      const promiseDetail = await promiseClient.admin.applications.get(101)
      expect(promiseDetail).toMatchObject({
        id: 101,
        userName: "Synthetic Applicant",
        userEmail: "applicant@example.com",
        status: expectedStatus,
      })

      fetchMock.mockResolvedValueOnce(makeResponse(200, applicationCollection(rawStatus)))
      const effectList = await Effect.runPromise(effectClient.admin.applications.list())
      expect(effectList).toMatchObject({ totalItems: 1, page: 1, pageSize: 30 })
      expect(effectList.items[0]?.status).toBe(expectedStatus)
      expect(effectList.items[0]?.statusLabel).toBe(expectedLabel)

      fetchMock.mockResolvedValueOnce(makeResponse(200, applicationResponse(rawStatus)))
      const effectDetail = await Effect.runPromise(effectClient.admin.applications.get(101))
      expect(effectDetail.status).toBe(expectedStatus)
    }
  })
})
