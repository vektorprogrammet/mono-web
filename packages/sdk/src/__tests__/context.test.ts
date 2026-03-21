/**
 * Context tests — JWT decoding, role hierarchy, department checks.
 */

import { describe, it, expect } from "vitest"
import { createContext } from "../context.js"

/**
 * Builds a minimal JWT with the given payload (no signature verification needed).
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
  return `${header}.${body}.fakesignature`
}

describe("createContext", () => {
  describe("unauthenticated", () => {
    it("returns unauthenticated context when no token is provided", () => {
      const ctx = createContext()
      expect(ctx.isAuthenticated).toBe(false)
      expect(ctx.role).toBeNull()
      expect(ctx.department).toBeNull()
      expect(ctx.teams).toEqual([])
      expect(ctx.userId).toBeNull()
    })

    it("hasRole always returns false for unauthenticated context", () => {
      const ctx = createContext()
      expect(ctx.hasRole("user")).toBe(false)
      expect(ctx.hasRole("admin")).toBe(false)
    })

    it("isInDepartment always returns false for unauthenticated context", () => {
      const ctx = createContext()
      expect(ctx.isInDepartment(1)).toBe(false)
    })
  })

  describe("with valid JWT", () => {
    it("populates role from ROLE_ADMIN claim", () => {
      const token = makeJwt({ roles: ["ROLE_ADMIN", "ROLE_USER"], userId: 1, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.isAuthenticated).toBe(true)
      expect(ctx.role).toBe("admin")
    })

    it("populates role from ROLE_TEAM_LEADER claim", () => {
      const token = makeJwt({ roles: ["ROLE_TEAM_LEADER", "ROLE_USER"], userId: 2, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.role).toBe("team_leader")
    })

    it("populates role from ROLE_TEAM_MEMBER claim", () => {
      const token = makeJwt({ roles: ["ROLE_TEAM_MEMBER", "ROLE_USER"], userId: 3, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.role).toBe("team_member")
    })

    it("populates role as 'user' from ROLE_USER claim", () => {
      const token = makeJwt({ roles: ["ROLE_USER"], userId: 4, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.role).toBe("user")
    })

    it("populates userId from claim", () => {
      const token = makeJwt({ roles: ["ROLE_USER"], userId: 99, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.userId).toBe(99)
    })

    it("populates department from claim", () => {
      const dept = { id: 5, name: "Trondheim" }
      const token = makeJwt({ roles: ["ROLE_USER"], userId: 1, department: dept, teams: [] })
      const ctx = createContext(token)
      expect(ctx.department).toEqual(dept)
    })

    it("populates teams from claim", () => {
      const teams = [{ id: 10, name: "Web" }, { id: 11, name: "Promo" }]
      const token = makeJwt({ roles: ["ROLE_USER"], userId: 1, department: null, teams })
      const ctx = createContext(token)
      expect(ctx.teams).toEqual(teams)
    })
  })

  describe("hasRole", () => {
    it("returns true for the exact role", () => {
      const token = makeJwt({ roles: ["ROLE_TEAM_MEMBER"], userId: 1, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.hasRole("team_member")).toBe(true)
    })

    it("returns true for lower roles (admin can act as user)", () => {
      const token = makeJwt({ roles: ["ROLE_ADMIN"], userId: 1, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.hasRole("user")).toBe(true)
      expect(ctx.hasRole("team_member")).toBe(true)
      expect(ctx.hasRole("team_leader")).toBe(true)
      expect(ctx.hasRole("admin")).toBe(true)
    })

    it("returns false for higher roles (user cannot act as admin)", () => {
      const token = makeJwt({ roles: ["ROLE_USER"], userId: 1, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.hasRole("team_member")).toBe(false)
      expect(ctx.hasRole("admin")).toBe(false)
    })
  })

  describe("isInDepartment", () => {
    it("returns true for matching department ID", () => {
      const dept = { id: 7, name: "Bergen" }
      const token = makeJwt({ roles: ["ROLE_USER"], userId: 1, department: dept, teams: [] })
      const ctx = createContext(token)
      expect(ctx.isInDepartment(7)).toBe(true)
    })

    it("returns false for non-matching department ID", () => {
      const dept = { id: 7, name: "Bergen" }
      const token = makeJwt({ roles: ["ROLE_USER"], userId: 1, department: dept, teams: [] })
      const ctx = createContext(token)
      expect(ctx.isInDepartment(99)).toBe(false)
    })

    it("returns false when department is null", () => {
      const token = makeJwt({ roles: ["ROLE_USER"], userId: 1, department: null, teams: [] })
      const ctx = createContext(token)
      expect(ctx.isInDepartment(1)).toBe(false)
    })
  })
})
