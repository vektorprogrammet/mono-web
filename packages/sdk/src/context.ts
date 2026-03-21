/**
 * Client context decoded from JWT claims.
 * Used for UI convenience (conditional rendering), not security.
 */

export interface ClientContext {
  readonly isAuthenticated: boolean
  readonly role: "user" | "team_member" | "team_leader" | "admin" | null
  readonly department: { id: number; name: string } | null
  readonly teams: { id: number; name: string }[]
  readonly userId: number | null
  hasRole(role: "user" | "team_member" | "team_leader" | "admin"): boolean
  isInDepartment(departmentId: number): boolean
}

const ROLE_HIERARCHY: Record<string, number> = {
  user: 0,
  team_member: 1,
  team_leader: 2,
  admin: 3,
}

/**
 * Decodes a JWT token (base64url) without verification.
 * We only need the payload claims for UI hints -- the server verifies the signature.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return {}
    const payload = parts[1]!
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function extractRole(roles: unknown): ClientContext["role"] {
  if (!Array.isArray(roles)) return null
  if (roles.includes("ROLE_ADMIN")) return "admin"
  if (roles.includes("ROLE_TEAM_LEADER")) return "team_leader"
  if (roles.includes("ROLE_TEAM_MEMBER")) return "team_member"
  if (roles.includes("ROLE_USER")) return "user"
  return null
}

export function createContext(token?: string): ClientContext {
  if (!token) {
    return {
      isAuthenticated: false,
      role: null,
      department: null,
      teams: [],
      userId: null,
      hasRole: () => false,
      isInDepartment: () => false,
    }
  }

  const claims = decodeJwtPayload(token)
  const role = extractRole(claims.roles)
  const department = (claims.department as { id: number; name: string } | null) ?? null
  const teams = (Array.isArray(claims.teams) ? claims.teams : []) as { id: number; name: string }[]
  const userId = typeof claims.userId === "number" ? claims.userId : null

  return {
    isAuthenticated: true,
    role,
    department,
    teams,
    userId,
    hasRole(requiredRole) {
      if (!role) return false
      return ROLE_HIERARCHY[role]! >= ROLE_HIERARCHY[requiredRole]!
    },
    isInDepartment(departmentId) {
      return department?.id === departmentId
    },
  }
}
