import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { Department, FieldOfStudy, Sponsor } from "../../schemas/common.js"

export interface PublicMiscDomain {
  departments(): Effect.Effect<readonly Department[], InternalSdkError>
  fieldOfStudies(): Effect.Effect<readonly FieldOfStudy[], InternalSdkError>
  sponsors(): Effect.Effect<readonly Sponsor[], InternalSdkError>
}

export function createPublicMiscDomain(transport: Transport): PublicMiscDomain {
  return {
    departments() {
      return transport.get("/api/departments", Schema.Array(Department))
    },

    fieldOfStudies() {
      return transport.get("/api/field_of_studies", Schema.Array(FieldOfStudy))
    },

    sponsors() {
      return transport.get("/api/sponsors", Schema.Array(Sponsor))
    },
  }
}
