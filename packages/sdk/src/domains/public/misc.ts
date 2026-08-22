import { Effect } from "effect"
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
      return transport
        .getCollection("/api/departments", Department)
        .pipe(Effect.map(({ items }) => items))
    },

    fieldOfStudies() {
      return transport
        .getCollection("/api/field_of_studies", FieldOfStudy)
        .pipe(Effect.map(({ items }) => items))
    },

    sponsors() {
      return transport
        .getCollection("/api/sponsors", Sponsor)
        .pipe(Effect.map(({ items }) => items))
    },
  }
}
