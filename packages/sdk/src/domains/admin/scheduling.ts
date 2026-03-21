import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"

export type Assistant = {
  name: string
  school: string
  phone: string
  email: string
}

export type School = {
  name: string
  capacity: number
  assistantCount: number
}

export type Substitute = {
  name: string
  phone: string
  email: string
  status: string
}

export interface AdminSchedulingDomain {
  assistants(): Effect.Effect<Assistant[], InternalSdkError>
  schools(): Effect.Effect<School[], InternalSdkError>
  substitutes(): Effect.Effect<Substitute[], InternalSdkError>
}

export function createAdminSchedulingDomain(transport: Transport): AdminSchedulingDomain {
  return {
    assistants() {
      return transport.get("/api/admin/scheduling/assistants", Schema.Unknown) as Effect.Effect<Assistant[], InternalSdkError>
    },
    schools() {
      return transport.get("/api/admin/scheduling/schools", Schema.Unknown) as Effect.Effect<School[], InternalSdkError>
    },
    substitutes() {
      return transport.get("/api/admin/substitutes", Schema.Unknown) as Effect.Effect<Substitute[], InternalSdkError>
    },
  }
}
