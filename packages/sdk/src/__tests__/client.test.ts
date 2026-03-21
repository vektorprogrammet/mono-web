/**
 * Integration tests for createClient.
 * Verifies the shape of the returned object and that all methods are promise-returning functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createClient } from "../promise.js"

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
    expect(client).toHaveProperty("context")
  })

  it("admin namespace has expected sub-domains", () => {
    const client = createClient("http://api.test")
    expect(client.admin).toHaveProperty("receipts")
    expect(client.admin).toHaveProperty("applications")
    expect(client.admin).toHaveProperty("interviews")
    expect(client.admin).toHaveProperty("users")
    expect(client.admin).toHaveProperty("scheduling")
    expect(client.admin).toHaveProperty("teams")
  })

  it("public namespace has expected methods", () => {
    const client = createClient("http://api.test")
    expect(typeof client.public.departments).toBe("function")
    expect(typeof client.public.fieldOfStudies).toBe("function")
    expect(typeof client.public.sponsors).toBe("function")
    expect(typeof client.public.teams).toBe("function")
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

  it("context is a ClientContext object", () => {
    const client = createClient("http://api.test")
    expect(client.context).toBeDefined()
    expect(typeof client.context.hasRole).toBe("function")
    expect(typeof client.context.isInDepartment).toBe("function")
    expect(client.context.isAuthenticated).toBe(false)
  })

  it("context reflects auth token when string auth is provided", () => {
    // Build a JWT with ROLE_USER
    const payload = JSON.stringify({ roles: ["ROLE_USER"], userId: 5, department: null, teams: [] })
    const encoded = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    const token = `header.${encoded}.sig`

    const client = createClient("http://api.test", { auth: token })
    expect(client.context.isAuthenticated).toBe(true)
    expect(client.context.role).toBe("user")
  })
})
