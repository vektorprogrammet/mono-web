/**
 * Admin users domain — list active/inactive users.
 *
 * Endpoints:
 *   GET /api/admin/users
 *
 * Note: this endpoint returns a plain object { activeUsers, inactiveUsers },
 * NOT a Hydra collection. Use transport.get, not transport.getCollection.
 */

import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { User } from "../../schemas/user.js"

const UsersResponse = Schema.Struct({
  activeUsers: Schema.Array(User),
  inactiveUsers: Schema.Array(User),
})

export interface AdminUsersDomain {
  list(): Effect.Effect<{ active: typeof User.Type[]; inactive: typeof User.Type[] }, InternalSdkError>
}

export function createAdminUsersDomain(transport: Transport): AdminUsersDomain {
  return {
    list() {
      return Effect.map(
        transport.get("/api/admin/users", UsersResponse),
        (res) => ({
          active: res.activeUsers as typeof User.Type[],
          inactive: res.inactiveUsers as typeof User.Type[],
        }),
      )
    },
  }
}
