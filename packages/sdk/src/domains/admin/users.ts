import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"

export type AdminUser = {
  id: number
  firstName: string
  lastName: string
  phone: string
  email: string
  role: string
  activeUsers?: AdminUser[]
  inactiveUsers?: AdminUser[]
}

export interface AdminUsersDomain {
  list(): Effect.Effect<unknown, InternalSdkError>
}

export function createAdminUsersDomain(transport: Transport): AdminUsersDomain {
  return {
    list() {
      return transport.get("/api/admin/users", Schema.Unknown)
    },
  }
}
