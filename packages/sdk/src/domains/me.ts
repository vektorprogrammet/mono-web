import { Effect, Schema } from "effect"
import type { Transport } from "../transport.js"
import type { InternalSdkError } from "../errors.js"

const UserProfile = Schema.Struct({
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  phone: Schema.optionalWith(Schema.String, { as: "Option" }),
  profilePhoto: Schema.optionalWith(Schema.String, { as: "Option" }),
  role: Schema.optionalWith(Schema.String, { as: "Option" }),
})

const DashboardData = Schema.Struct({
  name: Schema.String,
  department: Schema.String,
  activeAssistants: Schema.Number,
  pendingApplications: Schema.Number,
  upcomingInterviews: Schema.Number,
})

export type UserProfile = {
  firstName: string
  lastName: string
  email: string
  phone?: string | null
  profilePhoto?: string | null
  role?: string | null
}

export type DashboardData = {
  name: string
  department: string
  activeAssistants: number
  pendingApplications: number
  upcomingInterviews: number
}

export interface MeDomain {
  profile(): Effect.Effect<UserProfile, InternalSdkError>
  dashboard(): Effect.Effect<DashboardData, InternalSdkError>
}

export function createMeDomain(transport: Transport): MeDomain {
  return {
    profile() {
      return transport.get("/api/me", Schema.Unknown) as Effect.Effect<UserProfile, InternalSdkError>
    },
    dashboard() {
      return transport.get("/api/me/dashboard", Schema.Unknown) as Effect.Effect<DashboardData, InternalSdkError>
    },
  }
}
