import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"

export type MailingListEntry = {
  name: string
  email: string
}

export type AdmissionStats = {
  totalApplicants: number
  accepted: number
  rejected: number
  interviewed: number
  assignedAssistants: number
}

export type TeamInterest = {
  name: string
  team: string
  semester: string
}

export interface AdminMiscDomain {
  mailingLists(): Effect.Effect<MailingListEntry[], InternalSdkError>
  admissionStats(): Effect.Effect<AdmissionStats, InternalSdkError>
  teamInterest(): Effect.Effect<TeamInterest[], InternalSdkError>
}

export function createAdminMiscDomain(transport: Transport): AdminMiscDomain {
  return {
    mailingLists() {
      return transport.get("/api/admin/mailing-lists", Schema.Unknown) as Effect.Effect<MailingListEntry[], InternalSdkError>
    },
    admissionStats() {
      return transport.get("/api/admin/admission-statistics", Schema.Unknown) as Effect.Effect<AdmissionStats, InternalSdkError>
    },
    teamInterest() {
      return transport.get("/api/admin/team-interest", Schema.Unknown) as Effect.Effect<TeamInterest[], InternalSdkError>
    },
  }
}
