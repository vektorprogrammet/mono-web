import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { Team } from "../../schemas/common.js"

export interface PublicTeamsDomain {
  list(): Effect.Effect<readonly Team[], InternalSdkError>
}

export function createPublicTeamsDomain(transport: Transport): PublicTeamsDomain {
  return {
    list() {
      return transport
        .getCollection("/api/teams", Team)
        .pipe(Effect.map(({ items }) => items))
    },
  }
}
