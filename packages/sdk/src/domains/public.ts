import { Effect, Schema } from "effect"
import type { Transport } from "../transport.js"
import type { InternalSdkError } from "../errors.js"

export type Team = {
  name: string
  description: string
}

export type Sponsor = {
  name: string
  size: string
}

export type FieldOfStudy = {
  id: number
  name: string
  shortName: string
}

export interface PublicDomain {
  teams(): Effect.Effect<{ items: Team[], totalItems: number }, InternalSdkError>
  sponsors(): Effect.Effect<{ items: Sponsor[], totalItems: number }, InternalSdkError>
  fieldOfStudies(): Effect.Effect<FieldOfStudy[], InternalSdkError>
}

export function createPublicDomain(transport: Transport): PublicDomain {
  return {
    teams() {
      return transport.getCollection("/api/teams", Schema.Unknown) as Effect.Effect<{ items: Team[], totalItems: number }, InternalSdkError>
    },
    sponsors() {
      return transport.getCollection("/api/sponsors", Schema.Unknown) as Effect.Effect<{ items: Sponsor[], totalItems: number }, InternalSdkError>
    },
    fieldOfStudies() {
      return transport.get("/api/field_of_studies", Schema.Unknown) as Effect.Effect<FieldOfStudy[], InternalSdkError>
    },
  }
}
