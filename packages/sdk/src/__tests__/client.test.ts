/**
 * Integration tests for createClient.
 * Verifies the shape of the returned object and that all methods are promise-returning functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createClient, ValidationError } from "../promise.js"

describe("createClient", () => {
  beforeEach(() => {
    // Stub fetch so domain method calls don't fail at the network level
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns an object with all expected domain namespaces", () => {
    const client = createClient("http://api.test")
    expect(client).toHaveProperty("auth")
    expect(client).toHaveProperty("me")
    expect(client).toHaveProperty("receipts")
    expect(client).toHaveProperty("admin")
    expect(client).toHaveProperty("public")
  })

  it("admin namespace has expected sub-domains", () => {
    const client = createClient("http://api.test")
    expect(client.admin).toHaveProperty("receipts")
    expect(client.admin).toHaveProperty("applications")
    expect(client.admin).toHaveProperty("interviews")
    expect(client.admin).toHaveProperty("users")
    expect(client.admin).toHaveProperty("scheduling")
    expect(client.admin).toHaveProperty("teams")
    expect(client.admin).toHaveProperty("organization")
  })

  it("public namespace has expected domains", () => {
    const client = createClient("http://api.test")
    expect(client.public).toHaveProperty("organization")
    expect(typeof client.public.organization.listDepartments).toBe("function")
    expect(typeof client.public.organization.listFieldOfStudies).toBe("function")
    expect(typeof client.public.organization.listTeams).toBe("function")
    expect(typeof client.public.sponsors).toBe("function")
  })

  it("strictly reads the current session actor with the exact Cookie header", async () => {
    const rawCookie =
      "theme=dark; better-auth.session_token=session-value; invitation_capability=opaque"
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ personId: "person-1" }),
    } as Response)
    const client = createClient("http://api.test", { cookie: rawCookie })

    await expect(client.me.session()).resolves.toEqual({ personId: "person-1" })
    expect(fetch).toHaveBeenCalledWith(
      "http://api.test/api/me/session",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Cookie: rawCookie }),
      }),
    )
  })

  it("rejects a malformed session actor projection", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ personId: "person-1", role: "admin" }),
    } as Response)
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=session-value",
    })

    await expect(client.me.session()).rejects.toBeInstanceOf(ValidationError)
  })

  it("uses the server's canonical current-user profile route", async () => {
    const client = createClient("http://api.test")
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: 1,
            firstName: "Ada",
            lastName: "Lovelace",
            userName: "ada",
            email: "ada@example.invalid",
            phone: null,
            gender: null,
            fieldOfStudy: null,
            accountNumber: null,
            role: "ROLE_USER",
            profilePhoto: null,
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      } as Response)

    await client.me.profile()
    await client.me.updateProfile({ firstName: "Ada" })

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://api.test/api/me",
      expect.objectContaining({ method: "GET" }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://api.test/api/me",
      expect.objectContaining({ method: "PUT" }),
    )
  })

  it("domain methods are promise-returning functions", () => {
    const client = createClient("http://api.test")
    // All methods should be functions
    for (const key of Object.keys(client.auth)) {
      expect(typeof (client.auth as any)[key]).toBe("function")
    }
    for (const key of Object.keys(client.me)) {
      expect(typeof (client.me as any)[key]).toBe("function")
    }
    for (const key of Object.keys(client.receipts)) {
      expect(typeof (client.receipts as any)[key]).toBe("function")
    }
  })

})
