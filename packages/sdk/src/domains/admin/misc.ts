import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { MailingList, AdmissionStats } from "../../schemas/common.js"

export interface AdminMiscDomain {
  mailingLists(): Effect.Effect<{ items: MailingList[]; totalItems: number }, InternalSdkError>
  admissionStats(): Effect.Effect<AdmissionStats, InternalSdkError>
}

export function createAdminMiscDomain(transport: Transport): AdminMiscDomain {
  return {
    mailingLists() {
      return transport.getCollection("/api/admin/mailing-lists", MailingList)
    },

    admissionStats() {
      return transport.get("/api/admin/admission-statistics", AdmissionStats)
    },
  }
}
