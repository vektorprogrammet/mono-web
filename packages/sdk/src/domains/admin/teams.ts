import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { Team, TeamInterest } from "../../schemas/common.js"

export interface AdminTeamsDomain {
  list(): Effect.Effect<readonly Team[], InternalSdkError>
  interest(): Effect.Effect<{ items: TeamInterest[]; totalItems: number }, InternalSdkError>
}

export function createAdminTeamsDomain(transport: Transport): AdminTeamsDomain {
  return {
    list() {
      return transport.get("/api/admin/teams", Schema.Array(Team))
    },

    interest() {
      return transport.getCollection("/api/admin/team-interest", TeamInterest)
    },
  }
}
