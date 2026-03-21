import { Effect } from "effect"
import type { Transport } from "../transport.js"
import type { InternalSdkError } from "../errors.js"
import { UserProfile } from "../schemas/user.js"
import { DashboardStats } from "../schemas/dashboard.js"

export interface MeDomain {
  profile(): Effect.Effect<UserProfile, InternalSdkError>
  dashboard(): Effect.Effect<DashboardStats, InternalSdkError>
  updateProfile(data: Partial<typeof UserProfile.Type>): Effect.Effect<void, InternalSdkError>
}

export function createMeDomain(transport: Transport): MeDomain {
  return {
    profile() {
      return transport.get("/api/me/profile", UserProfile)
    },
    dashboard() {
      return transport.get("/api/me/dashboard", DashboardStats)
    },
    updateProfile(data) {
      return transport.put("/api/me/profile", data)
    },
  }
}
