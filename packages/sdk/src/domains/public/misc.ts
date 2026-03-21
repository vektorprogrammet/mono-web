import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { Department, FieldOfStudy, Sponsor } from "../../schemas/common.js"

export interface PublicMiscDomain {
  departments(): Effect.Effect<{ items: Department[]; totalItems: number }, InternalSdkError>
  fieldOfStudies(): Effect.Effect<{ items: FieldOfStudy[]; totalItems: number }, InternalSdkError>
  sponsors(): Effect.Effect<{ items: Sponsor[]; totalItems: number }, InternalSdkError>
}

export function createPublicMiscDomain(transport: Transport): PublicMiscDomain {
  return {
    departments() {
      return transport.getCollection("/api/departments", Department)
    },

    fieldOfStudies() {
      return transport.getCollection("/api/field_of_studies", FieldOfStudy)
    },

    sponsors() {
      return transport.getCollection("/api/sponsors", Sponsor)
    },
  }
}
