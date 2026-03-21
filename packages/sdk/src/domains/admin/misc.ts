import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { MailingList, AdmissionStats } from "../../schemas/common.js"

export interface AdminMiscDomain {
  mailingLists(): Effect.Effect<readonly MailingList[], InternalSdkError>
  admissionStats(): Effect.Effect<AdmissionStats, InternalSdkError>
}

export function createAdminMiscDomain(transport: Transport): AdminMiscDomain {
  return {
    mailingLists() {
      return transport.get("/api/admin/mailing-lists", Schema.Array(MailingList))
    },

    admissionStats() {
      return transport.get("/api/admin/admission-statistics", AdmissionStats)
    },
  }
}
