import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { TeamInterest } from "../../schemas/common.js"

export interface AdminTeamsDomain {
  interest(): Effect.Effect<{ items: TeamInterest[]; totalItems: number }, InternalSdkError>
}

export function createAdminTeamsDomain(transport: Transport): AdminTeamsDomain {
  return {
    interest() {
      return transport.getCollection("/api/admin/team-interest", TeamInterest)
    },
  }
}
